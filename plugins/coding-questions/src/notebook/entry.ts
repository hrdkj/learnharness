import type { PluginAction, PluginActionContext, PluginFrontendContext, PluginSettingsSchema, PluginSurfaceProps, PluginWidgetHandle } from "learnharness-plugin-api";
import { PROBLEM_TYPE_ID, QUESTION_TYPE_ID } from "../contract.ts";
import { setNotebookOpener, type AnswerTarget } from "../answer-targets.ts";
import { NotebookController } from "./controller.ts";
import { mountNotebook, type ProblemReference } from "./view.ts";

const NOTEBOOK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16v16H4z"/><path d="m8 9 3 3-3 3M13 15h3"/></svg>`;

type SessionAction = Extract<PluginActionContext, { surface: "session" }>;
interface Current { problem?: ProblemReference; setup?: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The coding question/problem the learner is answering right now, if any. */
function currentFromView(context: SessionAction, pluginId: string): Current {
  const input = context.view?.input;
  if (!input) return {};
  if (input.type === "plugin-problem-submission" && input.problem.pluginId === pluginId && input.problem.typeId === PROBLEM_TYPE_ID) {
    const payload = record(input.input.payload);
    return { problem: { id: input.problem.problemId, statement: input.input.statement }, setup: typeof payload?.notebookSetup === "string" ? payload.notebookSetup : undefined };
  }
  if (input.type === "plugin-question-answer" && input.question.pluginId === pluginId && input.question.typeId === QUESTION_TYPE_ID) {
    const payload = record(input.input.payload);
    return { problem: { id: input.question.questionId, statement: input.input.question }, setup: typeof payload?.notebookSetup === "string" ? payload.notebookSetup : undefined };
  }
  return {};
}

export function activateNotebook(ctx: PluginFrontendContext): () => void {
  const controllers = new Map<string, NotebookController>();
  let open: { sessionId: string; handle?: PluginWidgetHandle<PluginSurfaceProps>; controller: AbortController } | undefined;
  let settingsHandle: PluginWidgetHandle<PluginSettingsSchema> | undefined;
  let python = "";
  const cleanups: (() => void)[] = [];

  const controllerFor = (sessionId: string) => {
    let controller = controllers.get(sessionId);
    if (!controller) { controller = new NotebookController(ctx, sessionId); controllers.set(sessionId, controller); }
    return controller;
  };

  const close = () => {
    const current = open;
    if (!current) return;
    open = undefined;
    current.controller.abort();
    current.handle?.dispose();
  };

  const show = (sessionId: string, current: Current, target?: SessionAction["surfaceTarget"]) => {
    close();
    const controller = controllerFor(sessionId);
    const state: NonNullable<typeof open> = { sessionId, controller: new AbortController() };
    open = state;
    const props: PluginSurfaceProps = {
      title: "Notebook", background: "opaque",
      content(container, signal) {
        if (signal.aborted || open !== state) return;
        return mountNotebook(container, { ctx, controller, problem: current.problem, setup: current.setup, close, signal });
      },
      onClose: () => { if (open === state) { open = undefined; state.controller.abort(); } },
    };
    state.handle = target
      ? ctx.ui.openSurface(target, props, { signal: state.controller.signal })
      : ctx.ui.openSurface(props, { signal: state.controller.signal });
  };

  const action: PluginAction = {
    id: "notebook", name: "Notebook", icon: NOTEBOOK_ICON,
    shortcut: { scope: { sessions: ["teaching", "practice"] }, defaultBinding: "mod+shift+n" },
    run(context) {
      if (context.surface !== "session") return;
      if (open?.sessionId === context.sessionId) { close(); return; }
      show(context.sessionId, currentFromView(context, ctx.manifest.id), context.surfaceTarget);
    },
  };

  setNotebookOpener((target: AnswerTarget) => {
    show(target.sessionId, { problem: { id: target.id, statement: target.statement }, setup: target.payload.notebookSetup });
  });

  const rows = (): PluginSettingsSchema["rows"] => [{
    key: "python", type: "text", label: "Notebook Python",
    description: "Python used for the notebook kernel; it needs ipykernel (and pandas/sklearn for MLP). An absolute path, e.g. /home/you/project/.venv/bin/python, or a command on PATH.",
    value: python,
    validate: value => value !== value.trim() ? "Remove leading or trailing spaces." : undefined,
    async onChange(value: string) {
      const saved = await ctx.call<{ python: string }>("set-python", { python: value });
      python = saved.python;
      settingsHandle?.update({ rows: rows() });
    },
  }];

  cleanups.push(ctx.onNotification(event => {
    if (event.pluginId !== ctx.manifest.id) return;
    const data = record(event.data);
    if (event.topic === "kernel" && data && typeof data.sessionId === "string") {
      controllers.get(data.sessionId)?.handle(data.event as Parameters<NotebookController["handle"]>[0]);
    } else if (event.topic === "settings-changed" && data && typeof data.python === "string") {
      python = data.python;
      settingsHandle?.update({ rows: rows() });
    }
  }));
  cleanups.push(ctx.registerAction(action));
  cleanups.push(ctx.placeAction({ id: "session-notebook", actionId: "notebook", location: "top-bar", sessions: ["teaching", "practice"] }));
  void ctx.call<{ python: string }>("get-settings").then(value => {
    if (ctx.signal.aborted) return;
    python = value.python;
    settingsHandle = ctx.registerSettings({ rows: rows() });
  }).catch(error => console.error("Coding questions: could not read notebook settings.", error));

  return () => {
    close();
    setNotebookOpener(undefined);
    settingsHandle?.dispose();
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const controller of controllers.values()) void controller.saveNow();
    controllers.clear();
  };
}
