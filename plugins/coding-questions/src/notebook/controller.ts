import type { PluginFrontendContext } from "learnharness-plugin-api";
import { parseNotebook, type Notebook, type NotebookCell, type NotebookOutput } from "../notebook-model.ts";

export type KernelState = "stopped" | "starting" | "idle" | "busy" | "restarting" | "dead";
export type RunState = "idle" | "queued" | "running";

type BridgeEvent =
  | { type: "status"; state: KernelState }
  | { type: "started"; id: number; executionCount: number | null }
  | { type: "output"; id: number; output: NotebookOutput }
  | { type: "clear"; id: number; wait: boolean }
  | { type: "done"; id: number; status: "ok" | "error" | "aborted"; executionCount: number | null }
  | { type: "fatal" | "error"; message: string }
  | { type: "stderr"; text: string };

let counter = 0;
export function newCellId(): string {
  counter = (counter + 1) % 1_000_000;
  return `c${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyCell(type: NotebookCell["type"] = "code", source = ""): NotebookCell {
  return { id: newCellId(), type, source, outputs: [], executionCount: null };
}

/**
 * In-memory notebook for one learning session. Survives overlay close; kernel
 * events keep updating it while hidden. The backend file is the durable copy.
 */
export class NotebookController {
  notebook: Notebook = { cells: [], seeded: [] };
  kernel: KernelState = "stopped";
  message = "";
  loaded: Promise<void>;
  readonly runState = new Map<string, RunState>();
  private queue: string[] = [];
  private running: { cellId: string; runId?: number; clearOnNext: boolean } | undefined;
  private listeners = new Set<(change: { cellId?: string; structure?: boolean }) => void>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private deleted: { cell: NotebookCell; index: number }[] = [];
  /** Kernel events can beat the kernel-execute reply that names their run id. */
  private early: BridgeEvent[] = [];

  constructor(private readonly ctx: PluginFrontendContext, readonly sessionId: string) {
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    const result = await this.ctx.call<{ notebook: unknown; kernel: KernelState }>("notebook-load", { sessionId: this.sessionId });
    this.notebook = parseNotebook(result.notebook);
    this.kernel = result.kernel;
    if (!this.notebook.cells.length) this.notebook.cells.push(emptyCell());
    this.emit({ structure: true });
  }

  /** The backend replaced the notebook (tutor reset): drop local state and reload. */
  async reload(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.queue = [];
    this.running = undefined;
    this.early = [];
    this.deleted = [];
    this.runState.clear();
    this.message = "";
    this.loaded = this.load();
    await this.loaded;
  }

  subscribe(listener: (change: { cellId?: string; structure?: boolean }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: { cellId?: string; structure?: boolean }): void {
    for (const listener of this.listeners) listener(change);
  }

  scheduleSave(delay = 600): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.saveNow(); }, delay);
  }

  async saveNow(): Promise<void> {
    clearTimeout(this.saveTimer);
    try {
      await this.ctx.call("notebook-save", { sessionId: this.sessionId, notebook: this.notebook });
    } catch (error) {
      this.message = `Could not save notebook: ${error instanceof Error ? error.message : String(error)}`;
      this.emit({});
    }
  }

  cell(id: string): NotebookCell | undefined { return this.notebook.cells.find(cell => cell.id === id); }
  index(id: string): number { return this.notebook.cells.findIndex(cell => cell.id === id); }

  setSource(id: string, source: string): void {
    const cell = this.cell(id);
    if (!cell || cell.source === source) return;
    cell.source = source;
    this.scheduleSave();
  }

  insert(index: number, cell: NotebookCell = emptyCell()): NotebookCell {
    this.notebook.cells.splice(Math.max(0, Math.min(index, this.notebook.cells.length)), 0, cell);
    this.emit({ structure: true });
    this.scheduleSave();
    return cell;
  }

  remove(id: string): void {
    const index = this.index(id);
    if (index < 0) return;
    const [cell] = this.notebook.cells.splice(index, 1);
    this.deleted.push({ cell: cell!, index });
    this.queue = this.queue.filter(queued => queued !== id);
    this.runState.delete(id);
    if (!this.notebook.cells.length) this.notebook.cells.push(emptyCell());
    this.emit({ structure: true });
    this.scheduleSave();
  }

  undoDelete(): NotebookCell | undefined {
    const last = this.deleted.pop();
    if (!last) return;
    this.insert(last.index, last.cell);
    return last.cell;
  }

  move(id: string, delta: -1 | 1): void {
    const index = this.index(id), target = index + delta;
    if (index < 0 || target < 0 || target >= this.notebook.cells.length) return;
    const cells = this.notebook.cells;
    [cells[index], cells[target]] = [cells[target]!, cells[index]!];
    this.emit({ structure: true });
    this.scheduleSave();
  }

  setType(id: string, type: NotebookCell["type"]): void {
    const cell = this.cell(id);
    if (!cell || cell.type === type) return;
    cell.type = type;
    cell.outputs = [];
    cell.executionCount = null;
    this.emit({ structure: true });
    this.scheduleSave();
  }

  /** Append the problem's setup once, as an unrun code cell. */
  seed(problemId: string, title: string, setup: string | undefined): NotebookCell | undefined {
    if (!setup?.trim() || this.notebook.seeded.includes(problemId)) return;
    this.notebook.seeded.push(problemId);
    const only = this.notebook.cells.length === 1 && !this.notebook.cells[0]!.source.trim() ? this.notebook.cells[0] : undefined;
    const cell = emptyCell("code", `# ${title} · setup\n${setup.replace(/\s+$/, "")}\n`);
    if (only) this.notebook.cells.splice(0, 1, cell);
    else this.notebook.cells.push(cell);
    this.notebook.cells.push(emptyCell());
    this.emit({ structure: true });
    this.scheduleSave(0);
    return cell;
  }

  // --- Execution -----------------------------------------------------------

  run(ids: string[]): void {
    for (const id of ids) {
      const cell = this.cell(id);
      if (!cell || cell.type !== "code" || this.queue.includes(id) || this.running?.cellId === id) continue;
      this.queue.push(id);
      this.runState.set(id, "queued");
      this.emit({ cellId: id });
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const id = this.queue.shift();
    if (!id) return;
    const cell = this.cell(id);
    if (!cell) { void this.pump(); return; }
    this.running = { cellId: id, clearOnNext: false };
    this.runState.set(id, "running");
    cell.outputs = [];
    cell.executionCount = null;
    this.message = "";
    this.emit({ cellId: id });
    try {
      const { runId } = await this.ctx.call<{ runId: number }>("kernel-execute", { sessionId: this.sessionId, code: cell.source });
      if (this.running?.cellId === id) {
        this.running.runId = runId;
        const early = this.early;
        this.early = [];
        for (const event of early) this.handle(event);
      }
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
      this.finish(id, "error");
    }
  }

  private finish(id: string, status: "ok" | "error" | "aborted"): void {
    this.running = undefined;
    this.early = [];
    this.runState.set(id, "idle");
    if (status !== "ok") {
      // Like Colab, a failing cell stops the cells queued after it.
      for (const queued of this.queue) this.runState.set(queued, "idle");
      const stopped = this.queue;
      this.queue = [];
      for (const queued of stopped) this.emit({ cellId: queued });
    }
    this.emit({ cellId: id });
    this.scheduleSave(200);
    void this.pump();
  }

  handle(event: BridgeEvent): void {
    if (event.type === "status") { this.kernel = event.state; this.emit({}); return; }
    if (event.type === "fatal" || event.type === "error") { this.message = event.message; this.emit({}); return; }
    if (event.type === "stderr" || !("id" in event)) return;
    const running = this.running;
    if (running && running.runId === undefined) { this.early.push(event); return; }
    if (!running || running.runId !== event.id) return;
    const cell = this.cell(running.cellId);
    if (!cell) return;
    switch (event.type) {
      case "started":
        cell.executionCount = event.executionCount;
        break;
      case "clear":
        if (event.wait) running.clearOnNext = true;
        else cell.outputs = [];
        break;
      case "output": {
        if (running.clearOnNext) { cell.outputs = []; running.clearOnNext = false; }
        const last = cell.outputs.at(-1);
        if (event.output.output_type === "stream" && last?.output_type === "stream" && last.name === event.output.name) last.text += event.output.text;
        else cell.outputs.push(event.output);
        break;
      }
      case "done":
        if (event.executionCount !== null) cell.executionCount = event.executionCount;
        this.finish(cell.id, event.status);
        return;
    }
    this.emit({ cellId: cell.id });
  }

  async interrupt(): Promise<void> {
    for (const queued of this.queue) this.runState.set(queued, "idle");
    const stopped = this.queue;
    this.queue = [];
    for (const id of stopped) this.emit({ cellId: id });
    await this.ctx.call("kernel-interrupt", { sessionId: this.sessionId });
  }

  async restart(): Promise<void> {
    const stopped = [...this.queue, ...(this.running ? [this.running.cellId] : [])];
    this.queue = [];
    this.running = undefined;
    for (const id of stopped) { this.runState.set(id, "idle"); this.emit({ cellId: id }); }
    await this.ctx.call("kernel-restart", { sessionId: this.sessionId });
  }

  request(op: "complete" | "inspect", code: string, cursor: number): Promise<Record<string, unknown>> {
    return this.ctx.call("kernel-request", { sessionId: this.sessionId, op, code, cursor });
  }
}
