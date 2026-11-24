import fs from "node:fs";
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { definition, instructions, notebookInstructions, practiceInstructions, problemDefinition, readTests } from "./contract.ts";
import { runTests } from "./runner.ts";
import { compareValue, readReferenceOutput, readValuePayload, referenceProgram, valuePracticeInstructions, valueProblemDefinition, valueQuestionDefinition, valueTeachInstructions, type ValueAnswer, type ValuePayload, type ValueResult } from "./value.ts";
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
  const unregisterPracticeInstructions = ctx.registerInstructions({ agents: ["practice"], text: practiceInstructions + " " + notebookInstructions + " " + valuePracticeInstructions });
  const unregisterInstructions = ctx.registerInstructions({ agents: ["teacher"], text: instructions + " " + notebookInstructions + " " + valueTeachInstructions });

  // Notebook: settings, per-session .ipynb files and one Jupyter kernel per session.
  let settings = readSettings(ctx.dataDirectory);
  const store = new NotebookStore(ctx.dataDirectory);
  const kernels = new Kernels({
    python: () => settings.python,
    bridgePath: path.join(ctx.directory, "assets", "kernel-bridge.py"),
    idleMs: IDLE_MS,
    emit: (sessionId, event) => { if (!ctx.signal.aborted) ctx.events.emit("kernel", { sessionId, event }); },
  });
  // Exam questions: the value is the grade; code is only read for coaching.
  const answersDirectory = path.join(ctx.dataDirectory, "exam-answers");
  const computeReference = async (setup: string, reference: string, signal?: AbortSignal): Promise<{ answer: ValueAnswer } | { error: string }> => {
    if (!settings.python) return { error: "Set Notebook Python in the Coding questions settings first." };
    const run = await runTests({
      dataDirectory: ctx.dataDirectory, questionId: `compute-${Date.now().toString(36)}`, answer: "",
      tests: { program: settings.python, args: ["-"], code: referenceProgram(setup, reference) }, signal,
    });
    const read = readReferenceOutput(run.stdout);
    if ("answer" in read) return read;
    const detail = run.stderr.trim().split("\n").slice(-8).join("\n") || run.message || "";
    return { error: read.error + (detail ? `\n${detail}` : "") };
  };
  const expectedFor = async (id: string, payload: ValuePayload, signal?: AbortSignal): Promise<{ answer: ValueAnswer } | { error: string }> => {
    if (payload.answer !== undefined) return { answer: payload.answer };
    const cache = SESSION_ID_SAFE.test(id) ? path.join(answersDirectory, `${id}.json`) : undefined;
    if (cache) {
      try {
        const saved = JSON.parse(fs.readFileSync(cache, "utf8")) as { answer?: unknown };
        if (typeof saved.answer === "number" || typeof saved.answer === "string") return { answer: saved.answer };
      } catch { /* not computed yet */ }
    }
    const computed = await computeReference(payload.notebookSetup ?? "", payload.reference ?? "", signal);
    if (cache && "answer" in computed) {
      fs.mkdirSync(answersDirectory, { recursive: true });
      fs.writeFileSync(cache, JSON.stringify(computed));
    }
    return computed;
  };
  const gradeValue = async (id: string, rawPayload: unknown, submission: unknown, signal?: AbortSignal): Promise<ValueResult> => {
    if (typeof submission !== "string") throw new Error("Exam answers must be strings.");
    const payload = readValuePayload(rawPayload);
    const expected = await expectedFor(id, payload, signal);
    if ("error" in expected) return { status: "error", submitted: submission.trim(), message: `Could not compute the correct answer: ${expected.error}` };
    return compareValue(payload, expected.answer, submission);
  };
  const unregisterValueQuestion = ctx.registerQuestionType({
    ...valueQuestionDefinition,
    gradeAnswer: context => gradeValue(context.questionId, context.input.payload, context.answer, context.signal) as never,
  });
  const unregisterValueProblem = ctx.registerProblemType({
    ...valueProblemDefinition,
    processSubmission: context => gradeValue(context.problemId, context.input.payload, context.submission, context.signal) as never,
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
    ctx.handle("set-tutor-reset", input => {
      const enabled = field(input, "enabled");
      if (typeof enabled !== "boolean") throw new Error("Expected enabled to be a boolean.");
      settings = { ...settings, tutorReset: enabled };
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
      name: "compute_answer",
      label: "Compute answer",
      description: "Run Python in a fresh process (the Notebook Python, not the learner's kernel): notebookSetup, then reference, which must assign `answer`. Returns the value or the error. Use it to check an exam question before posing it, or to work out a value for a fresh variant. Keep it light: no large grids.",
      parameters: {
        type: "object",
        properties: {
          notebookSetup: { type: "string", description: "The same setup you will put in the question (imports, pd.read_csv by absolute path)." },
          reference: { type: "string", description: "Python that assigns the variable `answer`." },
        },
        required: ["reference"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, input: unknown, signal?: AbortSignal) => {
        const setup = field(input, "notebookSetup"), reference = field(input, "reference");
        if (typeof reference !== "string") throw new Error("reference must be a string.");
        const result = await computeReference(typeof setup === "string" ? setup : "", reference, signal);
        const text = "answer" in result ? `answer = ${JSON.stringify(result.answer)}` : `Error: ${result.error}`;
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    }, {
      name: "reset_notebook",
      label: "Fresh notebook",
      description: "Start the learner on a fresh, empty notebook for this session: the current notebook is archived (not deleted) and the kernel is stopped, so every variable and import is cleared. Use it when the learner moves to a new paper or mock test, or asks for a clean notebook; never in the middle of a question. Afterwards pose the next question with notebookSetup so its data loads again.",
      parameters: {
        type: "object",
        properties: { title: { type: "string", description: "Optional heading for the first cell, e.g. 'Mock paper 2'." } },
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, input: unknown, signal?: AbortSignal) => {
        if (signal?.aborted || ctx.signal.aborted) throw new Error("Notebook reset cancelled.");
        const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
        if (!settings.tutorReset) return reply("Not reset: the learner turned off 'Tutor can start a fresh notebook' in the Coding questions settings. Ask them to clear the notebook themselves if they want a clean one.");
        if (!SESSION_ID_SAFE.test(context.chatId)) return reply("No notebook is available for this session.");
        const title = field(input, "title");
        const heading = typeof title === "string" ? title.trim().replace(/\s+/g, " ").slice(0, 120) : "";
        const archived = store.archive(context.chatId);
        store.save(context.chatId, {
          cells: heading ? [
            { id: `r${Date.now().toString(36)}h`, type: "markdown", source: `# ${heading}`, outputs: [], executionCount: null },
            { id: `r${Date.now().toString(36)}c`, type: "code", source: "", outputs: [], executionCount: null },
          ] : [],
          seeded: [],
        });
        kernels.shutdown(context.chatId);
        ctx.events.emit("notebook-reset", { sessionId: context.chatId });
        return reply(`Fresh notebook ready${heading ? ` ("${heading}")` : ""}; the kernel was stopped, so nothing from before is defined.${archived ? " The previous notebook was archived." : ""} Pose the next question with notebookSetup so its data loads.`);
      },
    }, {
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
    unregisterValueProblem();
    unregisterValueQuestion();
  };
}

const SESSION_ID_SAFE = /^[A-Za-z0-9_-]{1,200}$/;
