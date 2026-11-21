import type { PluginFrontendContext, PluginWidgetHandle, PluginMarkdownProps } from "learnharness-plugin-api";
import type { EditorView } from "@codemirror/view";
import { activeAnswerTarget, onAnswerTargetsChange } from "../answer-targets.ts";
import type { NotebookCell } from "../notebook-model.ts";
import { createCellEditor } from "./cell-editor.ts";
import { emptyCell, type NotebookController } from "./controller.ts";
import { renderOutputs } from "./outputs.ts";

export interface ProblemReference {
  id: string;
  statement: string;
}

interface CellView {
  id: string;
  root: HTMLElement;
  run: HTMLButtonElement;
  count: HTMLElement;
  editorHost: HTMLElement;
  rendered: HTMLElement;
  docs: HTMLElement;
  outputs: HTMLElement;
  answer: HTMLButtonElement;
  submit: HTMLButtonElement;
  editor?: EditorView;
  markdown?: PluginWidgetHandle<PluginMarkdownProps>;
  editingMarkdown: boolean;
  outputsKey?: unknown;
  type: NotebookCell["type"];
}

const SHORTCUTS: [string, string][] = [
  ["Ctrl+Enter", "Run cell"],
  ["Shift+Enter", "Run cell and select next"],
  ["Alt+Enter", "Run cell and insert below"],
  ["Ctrl+F9 / Ctrl+F8 / Ctrl+F10", "Run all / run before / run selected and after"],
  ["Esc", "Command mode (Enter to edit)"],
  ["A / B", "Insert code cell above / below (command mode)"],
  ["D, D", "Delete cell (command mode)"],
  ["Z", "Undo cell deletion (command mode)"],
  ["Y / M", "Convert to code / text (command mode)"],
  ["J / K, ↓ / ↑", "Select next / previous cell (command mode)"],
  ["Ctrl+M then A, B, D, Y, M, Z", "Same as command-mode keys, from anywhere"],
  ["Ctrl+M then K / J", "Move cell up / down"],
  ["Ctrl+M then I / .", "Interrupt / restart kernel"],
  ["Ctrl+M then H", "Show this list"],
  ["Ctrl+Space, Tab", "Completions (also pops after typing .)"],
  ["Ctrl+Shift+Space", "Docs for the name at the cursor (or help(x), x?)"],
  ["Ctrl+/", "Toggle comment"],
  ["Alt+↑ / Alt+↓", "Move line"],
  ["Shift+Alt+↑ / ↓", "Duplicate line"],
  ["Ctrl+D, Ctrl+click, Alt+drag", "Multiple cursors"],
  ["Ctrl+F", "Find / replace in cell"],
  ["Ctrl+Shift+N", "Close / reopen notebook"],
];

function button(document: Document, label: string, title: string, className = "lh-nb-button"): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.title = title;
  return node;
}

function title(statement: string): string {
  const line = statement.split("\n").map(part => part.replace(/[#*_`>]/g, "").trim()).find(Boolean) ?? "Problem";
  return line.length > 70 ? `${line.slice(0, 67)}…` : line;
}

/** Mount the notebook into a surface body. Returns cleanup. */
export function mountNotebook(container: HTMLElement, options: {
  ctx: PluginFrontendContext;
  controller: NotebookController;
  problem: ProblemReference | undefined;
  setup: string | undefined;
  close(): void;
  signal: AbortSignal;
}): () => void {
  const { ctx, controller, signal } = options;
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = "lh-nb";
  root.tabIndex = -1;
  root.setAttribute("data-plugin-initial-focus", "");
  container.append(root);

  // Header ----------------------------------------------------------------
  const bar = document.createElement("header");
  bar.className = "lh-nb-bar";
  const heading = document.createElement("strong");
  heading.textContent = "Notebook";
  const status = document.createElement("span");
  status.className = "lh-nb-status";
  status.setAttribute("role", "status");
  const runAll = button(document, "▶ All", "Run all cells (Ctrl+F9)");
  const interrupt = button(document, "■", "Interrupt execution (Ctrl+M I)");
  const restart = button(document, "↻", "Restart kernel; variables are cleared (Ctrl+M .)");
  const restartRun = button(document, "↻▶", "Restart the kernel, then run every cell");
  const addCode = button(document, "+ Code", "Insert code cell below (B)");
  const addText = button(document, "+ Text", "Insert text cell below");
  const help = button(document, "?", "Keyboard shortcuts (Ctrl+M H)");
  bar.append(heading, status, runAll, interrupt, restart, restartRun, addCode, addText, help);
  root.append(bar);

  const helpPanel = document.createElement("div");
  helpPanel.className = "lh-nb-help";
  helpPanel.hidden = true;
  const table = document.createElement("table");
  for (const [keys, action] of SHORTCUTS) {
    const row = table.insertRow();
    const key = row.insertCell(), what = row.insertCell();
    key.textContent = keys; what.textContent = action;
  }
  helpPanel.append(table);
  root.append(helpPanel);

  const message = document.createElement("div");
  message.className = "lh-nb-message";
  message.hidden = true;
  const messageText = document.createElement("span");
  const openSettings = button(document, "Open settings", "Set Notebook Python");
  openSettings.addEventListener("click", () => ctx.app.openSettings());
  message.append(messageText, openSettings);
  root.append(message);

  const list = document.createElement("div");
  list.className = "lh-nb-cells";
  root.append(list);

  const footer = document.createElement("div");
  footer.className = "lh-nb-footer";
  const footerCode = button(document, "+ Code", "Add a code cell at the end");
  const footerText = button(document, "+ Text", "Add a text cell at the end");
  footer.append(footerCode, footerText);
  root.append(footer);

  // State -------------------------------------------------------------------
  const views = new Map<string, CellView>();
  let selected: string | undefined;
  let mode: "command" | "edit" = "command";
  let chord = false, chordTimer: ReturnType<typeof setTimeout> | undefined;
  let lastD = 0;
  let disposed = false;

  const select = (id: string | undefined, scroll = true) => {
    if (selected === id) return;
    if (selected) views.get(selected)?.root.classList.remove("lh-nb-cell--selected");
    selected = id;
    const view = id ? views.get(id) : undefined;
    view?.root.classList.add("lh-nb-cell--selected");
    if (scroll) view?.root.scrollIntoView({ block: "nearest" });
  };

  const commandMode = () => {
    mode = "command";
    if (selected) {
      const view = views.get(selected);
      if (view && view.type === "markdown" && view.editingMarkdown) renderMarkdown(view, false);
    }
    root.focus({ preventScroll: true });
  };

  const edit = (id: string) => {
    const view = views.get(id);
    if (!view) return;
    select(id);
    mode = "edit";
    if (view.type === "markdown" && !view.editingMarkdown) renderMarkdown(view, true);
    view.editor?.focus();
  };

  function renderMarkdown(view: CellView, editing: boolean): void {
    const cell = controller.cell(view.id);
    if (!cell) return;
    view.editingMarkdown = editing;
    view.editorHost.hidden = !editing;
    view.rendered.hidden = editing;
    if (!editing) {
      const text = cell.source.trim() ? cell.source : "*Empty text cell — double-click to edit.*";
      if (view.markdown) view.markdown.update({ text });
      else view.markdown = ctx.ui.mountMarkdown(view.rendered, { text }, { signal });
    }
  }

  const neighbour = (id: string, delta: 1 | -1) => controller.notebook.cells[controller.index(id) + delta]?.id;

  const insertBelow = (id: string | undefined, type: NotebookCell["type"] = "code") => {
    const index = id ? controller.index(id) + 1 : controller.notebook.cells.length;
    const cell = controller.insert(index, emptyCell(type));
    edit(cell.id);
    return cell;
  };
  const insertAbove = (id: string | undefined) => {
    const cell = controller.insert(id ? controller.index(id) : 0, emptyCell());
    edit(cell.id);
  };

  const runCell = (id: string) => {
    const view = views.get(id), cell = controller.cell(id);
    if (!view || !cell) return;
    if (cell.type === "markdown") { renderMarkdown(view, false); return; }
    controller.run([id]);
  };

  const runAndNext = (id: string) => {
    const wasEditing = mode === "edit";
    runCell(id);
    const next = neighbour(id, 1) ?? controller.insert(controller.index(id) + 1, emptyCell()).id;
    if (wasEditing) edit(next);
    else { select(next); commandMode(); }
  };

  const runAndInsert = (id: string) => {
    runCell(id);
    insertBelow(id);
  };

  const remove = (id: string) => {
    const next = neighbour(id, 1) ?? neighbour(id, -1);
    controller.remove(id);
    select(next ?? controller.notebook.cells[0]?.id);
    commandMode();
  };

  const useAsAnswer = (id: string, submit = false) => {
    const cell = controller.cell(id);
    const target = activeAnswerTarget(controller.sessionId, currentProblemId);
    if (!cell || !target) return;
    target.setCode(cell.source);
    void controller.saveNow();
    if (!submit) return;
    // The host owns submission; press its practice Submit once the draft is ready.
    let tries = 0;
    const press = () => {
      const send = document.querySelector<HTMLButtonElement>('[data-testid="practice-send"], [data-testid="plugin-question-send"]');
      if (send && !send.disabled) { send.click(); return; }
      if (++tries < 30) setTimeout(press, 50);
    };
    requestAnimationFrame(press);
  };

  // Seed (and run) the setup of whichever problem is active, once per problem.
  let currentProblemId = options.problem?.id;
  const seedProblem = (problem: { id: string; statement: string } | undefined, setup: string | undefined) => {
    if (!problem) return;
    currentProblemId = problem.id;
    const seeded = controller.seed(problem.id, title(problem.statement), setup);
    if (!seeded) return;
    reconcile();
    select(seeded.id);
    controller.run([seeded.id]);
  };

  // Cells -------------------------------------------------------------------
  function createView(cell: NotebookCell): CellView {
    const root = document.createElement("section");
    root.className = "lh-nb-cell";
    root.dataset.cellId = cell.id;
    const gutter = document.createElement("div");
    gutter.className = "lh-nb-gutter";
    const run = button(document, "▶", "Run cell (Ctrl+Enter)", "lh-nb-run");
    const count = document.createElement("span");
    count.className = "lh-nb-count";
    gutter.append(run, count);
    const main = document.createElement("div");
    main.className = "lh-nb-main";
    const tools = document.createElement("div");
    tools.className = "lh-nb-tools";
    const answer = button(document, "Use as answer", "Copy this cell into the answer editor", "lh-nb-tool lh-nb-tool--answer");
    const submit = button(document, "Submit", "Copy this cell into the answer editor and submit it", "lh-nb-tool lh-nb-tool--answer lh-nb-tool--submit");
    const up = button(document, "↑", "Move cell up (Ctrl+M K)", "lh-nb-tool");
    const down = button(document, "↓", "Move cell down (Ctrl+M J)", "lh-nb-tool");
    const del = button(document, "Delete", "Delete cell (D, D)", "lh-nb-tool");
    tools.append(submit, answer, up, down, del);
    const editorHost = document.createElement("div");
    editorHost.className = "lh-nb-editor";
    const rendered = document.createElement("div");
    rendered.className = "lh-nb-rendered";
    rendered.hidden = true;
    const docs = document.createElement("pre");
    docs.className = "lh-nb-docs";
    docs.hidden = true;
    const outputs = document.createElement("div");
    outputs.className = "lh-nb-outputs";
    main.append(tools, editorHost, rendered, docs, outputs);
    root.append(gutter, main);

    const view: CellView = { id: cell.id, root, run, count, editorHost, rendered, docs, outputs, answer, submit, editingMarkdown: true, type: cell.type };
    view.editor = createCellEditor(editorHost, {
      source: cell.source,
      kind: cell.type,
      kernel: controller,
      onChange: source => controller.setSource(cell.id, source),
      keys: {
        run: () => runCell(cell.id),
        runNext: () => runAndNext(cell.id),
        runInsert: () => runAndInsert(cell.id),
        escape: () => { docs.hidden = true; commandMode(); },
        docs: text => { docs.textContent = text ?? ""; docs.hidden = !text; },
        focusChange: focused => { if (focused) { select(cell.id, false); mode = "edit"; } },
      },
    });
    run.addEventListener("click", () => { select(cell.id); runCell(cell.id); });
    answer.addEventListener("click", () => useAsAnswer(cell.id));
    submit.addEventListener("click", () => useAsAnswer(cell.id, true));
    up.addEventListener("click", () => controller.move(cell.id, -1));
    down.addEventListener("click", () => controller.move(cell.id, 1));
    del.addEventListener("click", () => remove(cell.id));
    rendered.addEventListener("dblclick", () => edit(cell.id));
    root.addEventListener("mousedown", event => {
      if (!(event.target as HTMLElement).closest(".cm-editor, button")) { select(cell.id, false); if (mode === "command") queueMicrotask(() => root.ownerDocument.activeElement === document.body && commandMode()); }
    });
    if (cell.type === "markdown") renderMarkdown(view, !cell.source.trim());
    return view;
  }

  function updateCell(id: string): void {
    const view = views.get(id), cell = controller.cell(id);
    if (!view || !cell) return;
    const state = controller.runState.get(id) ?? "idle";
    view.root.classList.toggle("lh-nb-cell--running", state === "running");
    view.root.classList.toggle("lh-nb-cell--queued", state === "queued");
    view.run.textContent = state === "running" ? "■" : "▶";
    view.run.title = state === "running" ? "Interrupt (Ctrl+M I)" : "Run cell (Ctrl+Enter)";
    view.run.hidden = cell.type !== "code";
    view.count.textContent = cell.type !== "code" ? "" : state === "queued" || state === "running" ? "[*]" : cell.executionCount === null ? "[ ]" : `[${cell.executionCount}]`;
    view.answer.hidden = view.submit.hidden = cell.type !== "code";
    view.answer.disabled = view.submit.disabled = !activeAnswerTarget(controller.sessionId, currentProblemId);
    // Outputs: re-render only when the array or its length changed.
    const key = `${cell.outputs.length}:${cell.outputs.map(o => o.output_type === "stream" ? o.text.length : 1).join(",")}`;
    if (view.outputsKey !== key) { view.outputsKey = key; renderOutputs(view.outputs, cell.outputs); }
    if (view.editor && view.editor.state.doc.toString() !== cell.source) {
      view.editor.dispatch({ changes: { from: 0, to: view.editor.state.doc.length, insert: cell.source } });
    }
  }

  function reconcile(): void {
    const cells = controller.notebook.cells;
    const ids = new Set(cells.map(cell => cell.id));
    for (const [id, view] of views) {
      if (!ids.has(id)) { view.editor?.destroy(); view.markdown?.dispose(); view.root.remove(); views.delete(id); }
    }
    for (const cell of cells) {
      let view = views.get(cell.id);
      if (view && view.type !== cell.type) { view.editor?.destroy(); view.markdown?.dispose(); view.root.remove(); views.delete(cell.id); view = undefined; }
      if (!view) { view = createView(cell); views.set(cell.id, view); }
      list.append(view.root);
      updateCell(cell.id);
    }
    if (!selected || !views.has(selected)) select(cells[0]?.id, false);
    else views.get(selected)!.root.classList.add("lh-nb-cell--selected");
  }

  function updateStatus(): void {
    const labels: Record<string, string> = { stopped: "Kernel not started — runs on first cell", starting: "Starting kernel…", idle: "Kernel idle", busy: "Running…", restarting: "Restarting…", dead: "Kernel died — Restart" };
    status.textContent = labels[controller.kernel] ?? controller.kernel;
    status.dataset.state = controller.kernel;
    messageText.textContent = controller.message;
    message.hidden = !controller.message;
    openSettings.hidden = !/Settings|Notebook Python|Could not start|jupyter_client/.test(controller.message);
  }

  // Keyboard ----------------------------------------------------------------
  const commandKey = (event: KeyboardEvent): boolean => {
    const id = selected;
    const key = event.key;
    if (!id) return false;
    if (key === "Enter" && !event.ctrlKey && !event.shiftKey && !event.altKey) { edit(id); return true; }
    if (key === "ArrowDown" || key === "j" || key === "J") { const next = neighbour(id, 1); if (next) select(next); return true; }
    if (key === "ArrowUp" || key === "k" || key === "K") { const prev = neighbour(id, -1); if (prev) select(prev); return true; }
    if (key === "a" || key === "A") { insertAbove(id); return true; }
    if (key === "b" || key === "B") { insertBelow(id); return true; }
    if (key === "y" || key === "Y") { controller.setType(id, "code"); return true; }
    if (key === "m" || key === "M") { controller.setType(id, "markdown"); return true; }
    if (key === "z" || key === "Z") { const cell = controller.undoDelete(); if (cell) select(cell.id); return true; }
    if (key === "d" || key === "D") {
      const now = Date.now();
      if (now - lastD < 1000) { lastD = 0; remove(id); } else lastD = now;
      return true;
    }
    return false;
  };

  const chordKey = (event: KeyboardEvent): boolean => {
    const id = selected;
    const key = event.key.toLowerCase();
    if (key === "h") { helpPanel.hidden = !helpPanel.hidden; return true; }
    if (key === "i") { void controller.interrupt(); return true; }
    if (key === ".") { void controller.restart(); return true; }
    if (!id) return true;
    if (key === "a") insertAbove(id);
    else if (key === "b") insertBelow(id);
    else if (key === "d") remove(id);
    else if (key === "y") controller.setType(id, "code");
    else if (key === "m") controller.setType(id, "markdown");
    else if (key === "z") { const cell = controller.undoDelete(); if (cell) select(cell.id); }
    else if (key === "k") controller.move(id, -1);
    else if (key === "j") controller.move(id, 1);
    return true;
  };

  const runRange = (which: "all" | "before" | "after") => {
    const cells = controller.notebook.cells;
    const index = selected ? controller.index(selected) : 0;
    const range = which === "all" ? cells : which === "before" ? cells.slice(0, index) : cells.slice(index);
    controller.run(range.filter(cell => cell.type === "code").map(cell => cell.id));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const handled = (() => {
      if (chord) { chord = false; clearTimeout(chordTimer); return chordKey(event); }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "m") {
        chord = true;
        chordTimer = setTimeout(() => { chord = false; }, 2000);
        return true;
      }
      if (event.ctrlKey && event.key === "F9") { runRange("all"); return true; }
      if (event.ctrlKey && event.key === "F8") { runRange("before"); return true; }
      if (event.ctrlKey && event.key === "F10") { runRange("after"); return true; }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "s") { void controller.saveNow(); return true; }
      const inEditor = (event.target as HTMLElement).closest?.(".cm-editor");
      if (inEditor) return false;
      const id = selected;
      if (!id) return false;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { runCell(id); return true; }
      if (event.shiftKey && event.key === "Enter") { runAndNext(id); return true; }
      if (event.altKey && event.key === "Enter") { runAndInsert(id); return true; }
      if (event.ctrlKey || event.metaKey || event.altKey) return false;
      return commandKey(event);
    })();
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  };
  root.addEventListener("keydown", onKeyDown, { capture: true });

  // Toolbar ----------------------------------------------------------------
  runAll.addEventListener("click", () => runRange("all"));
  interrupt.addEventListener("click", () => { void controller.interrupt(); });
  restart.addEventListener("click", () => { void controller.restart(); });
  restartRun.addEventListener("click", () => { void controller.restart().then(() => runRange("all")); });
  addCode.addEventListener("click", () => insertBelow(selected));
  addText.addEventListener("click", () => insertBelow(selected, "markdown"));
  help.addEventListener("click", () => { helpPanel.hidden = !helpPanel.hidden; });
  footerCode.addEventListener("click", () => insertBelow(controller.notebook.cells.at(-1)?.id));
  footerText.addEventListener("click", () => insertBelow(controller.notebook.cells.at(-1)?.id, "markdown"));

  // Wiring ------------------------------------------------------------------
  const unsubscribe = controller.subscribe(change => {
    if (disposed) return;
    if (change.structure) reconcile();
    else if (change.cellId) updateCell(change.cellId);
    updateStatus();
  });
  const unwatchTargets = onAnswerTargetsChange(() => {
    for (const id of views.keys()) updateCell(id);
    const target = activeAnswerTarget(controller.sessionId);
    if (target && target.id !== currentProblemId && !disposed) void controller.loaded.then(() => { if (!disposed) seedProblem({ id: target.id, statement: target.statement }, target.payload.notebookSetup); });
  });
  updateStatus();
  void controller.loaded.then(() => {
    if (disposed) return;
    reconcile();
    select(controller.notebook.cells.at(-1)?.id);
    seedProblem(options.problem, options.setup);
    if (selected) edit(selected);
  }).catch(error => {
    controller.message = `Could not load notebook: ${error instanceof Error ? error.message : String(error)}`;
    updateStatus();
  });

  return () => {
    disposed = true;
    clearTimeout(chordTimer);
    root.removeEventListener("keydown", onKeyDown, { capture: true });
    unsubscribe();
    unwatchTargets();
    for (const view of views.values()) { view.editor?.destroy(); view.markdown?.dispose(); }
    views.clear();
    void controller.saveNow();
    root.remove();
  };
}
