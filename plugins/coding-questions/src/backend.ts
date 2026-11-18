import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { definition, instructions, notebookInstructions, practiceInstructions, problemDefinition, readTests } from "./contract.ts";
import { runTests } from "./runner.ts";
import { Kernels } from "./kernels.ts";
import { notebookAsText } from "./notebook-model.ts";
import { NotebookStore, pythonPathError, readSettings, sessionIdFrom, writeSettings } from "./notebook-store.ts";

const IDLE_MS = 30 * 60 * 1000;

function field(input: unknown, name: string): unknown {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>)[name] : undefined;
}

export function activate(ctx: PluginBackendContext): () => void {
  const unregisterQuestion = ctx.registerQuestionType({
    ...definition,
    gradeAnswer(context) {
      if (typeof context.answer !== "string") throw new Error("Coding answers must be strings.");
      return runTests({
        dataDirectory: ctx.dataDirectory,
        questionId: context.questionId,
        answer: context.answer,
        tests: readTests(context.input.payload),
        signal: context.signal,
      });
    },
  });
  const unregisterProblem = ctx.registerProblemType({
    ...problemDefinition,
    processSubmission(context) {
      if (typeof context.submission !== "string") throw new Error("Coding submissions must be strings.");
      return runTests({
        dataDirectory: ctx.dataDirectory,
        questionId: context.problemId,
        answer: context.submission,
        tests: readTests(context.input.payload),
        signal: context.signal,
      });
    },
  });
  const unregisterPracticeInstructions = ctx.registerInstructions({ agents: ["practice"], text: practiceInstructions + " " + notebookInstructions });
  const unregisterInstructions = ctx.registerInstructions({ agents: ["teacher"], text: instructions + " " + notebookInstructions });

  // Notebook: settings, per-session .ipynb files and one Jupyter kernel per session.
  let settings = readSettings(ctx.dataDirectory);
  const store = new NotebookStore(ctx.dataDirectory);
  const kernels = new Kernels({
    python: () => settings.python,
    bridgePath: path.join(ctx.directory, "assets", "kernel-bridge.py"),
    idleMs: IDLE_MS,
    emit: (sessionId, event) => { if (!ctx.signal.aborted) ctx.events.emit("kernel", { sessionId, event }); },
  });
  const handlers = [
    ctx.handle("get-settings", () => ({ ...settings })),
    ctx.handle("set-python", input => {
      const python = field(input, "python");
      if (typeof python !== "string") throw new Error("Expected python to be a string.");
      const error = pythonPathError(python);
      if (error) throw new Error(error);
      settings = { ...settings, python };
      writeSettings(ctx.dataDirectory, settings);
      ctx.events.emit("settings-changed", { ...settings });
      return { ...settings };
    }),
    ctx.handle("notebook-load", input => {
      const sessionId = sessionIdFrom(input);
      return { notebook: store.load(sessionId), kernel: kernels.state(sessionId) };
    }),
    ctx.handle("notebook-save", input => {
      store.save(sessionIdFrom(input), field(input, "notebook"));
      return { saved: true };
    }),
    ctx.handle("kernel-execute", input => {
      const code = field(input, "code");
      if (typeof code !== "string") throw new Error("Expected code to be a string.");
      return { runId: kernels.get(sessionIdFrom(input)).execute(code) };
    }),
    ctx.handle("kernel-request", async input => {
      const op = field(input, "op"), code = field(input, "code"), cursor = field(input, "cursor");
      if ((op !== "complete" && op !== "inspect") || typeof code !== "string" || typeof cursor !== "number") throw new Error("Invalid kernel request.");
      return kernels.get(sessionIdFrom(input)).request(op, code, cursor);
    }),
    ctx.handle("kernel-interrupt", input => { kernels.interrupt(sessionIdFrom(input)); return {}; }),
    ctx.handle("kernel-restart", input => { kernels.get(sessionIdFrom(input)).restart(); return {}; }),
    ctx.handle("kernel-shutdown", input => { kernels.shutdown(sessionIdFrom(input)); return {}; }),
  ];
  const unregisterTools = ctx.registerTools({
    agents: ["teacher", "practice"],
    create: context => [{
      name: "read_notebook",
      label: "Read notebook",
      description: "Read the learner's scratch Python notebook for this session: every cell's source and its text outputs (last 40 cells, each output capped at 2 KB). Use it before giving a hint or after repeated test failures to see what the learner tried. Read-only; it never runs code.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_toolCallId: string, _input: unknown, signal?: AbortSignal) => {
        if (signal?.aborted || ctx.signal.aborted) throw new Error("Notebook read cancelled.");
        const text = SESSION_ID_SAFE.test(context.chatId) ? notebookAsText(store.load(context.chatId)) : "No notebook is available for this session.";
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    }],
  });
  return () => {
    kernels.dispose();
    for (const unregister of handlers) unregister();
    unregisterTools();
    unregisterInstructions();
    unregisterPracticeInstructions();
    unregisterProblem();
    unregisterQuestion();
  };
}

const SESSION_ID_SAFE = /^[A-Za-z0-9_-]{1,200}$/;
