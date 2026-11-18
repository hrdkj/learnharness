/** Notebook data shared by the backend store, the read_notebook tool and the overlay. */

export type NotebookOutput =
  | { output_type: "stream"; name: string; text: string }
  | { output_type: "execute_result"; data: Record<string, unknown>; metadata: Record<string, unknown>; execution_count: number | null }
  | { output_type: "display_data"; data: Record<string, unknown>; metadata: Record<string, unknown> }
  | { output_type: "error"; ename: string; evalue: string; traceback: string[] };

export interface NotebookCell {
  id: string;
  type: "code" | "markdown";
  source: string;
  outputs: NotebookOutput[];
  executionCount: number | null;
}

export interface Notebook {
  cells: NotebookCell[];
  /** Problem ids whose notebookSetup cell was already appended. */
  seeded: string[];
}

export const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;
const CELL_ID = /^[A-Za-z0-9_-]{1,64}$/;

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every(item => typeof item === "string")) return value.join("");
  return "";
}

function readOutput(value: unknown): NotebookOutput | null {
  const item = record(value, "Output");
  switch (item.output_type) {
    case "stream": return { output_type: "stream", name: typeof item.name === "string" ? item.name : "stdout", text: text(item.text) };
    case "execute_result": return {
      output_type: "execute_result", data: record(item.data ?? {}, "Output data"), metadata: record(item.metadata ?? {}, "Output metadata"),
      execution_count: typeof item.execution_count === "number" ? item.execution_count : null,
    };
    case "display_data": return { output_type: "display_data", data: record(item.data ?? {}, "Output data"), metadata: record(item.metadata ?? {}, "Output metadata") };
    case "error": return {
      output_type: "error", ename: typeof item.ename === "string" ? item.ename : "", evalue: typeof item.evalue === "string" ? item.evalue : "",
      traceback: Array.isArray(item.traceback) ? item.traceback.filter((line): line is string => typeof line === "string") : [],
    };
    default: return null;
  }
}

/** Accepts the plugin's own wire shape (from the overlay). */
export function parseNotebook(value: unknown): Notebook {
  const input = record(value, "Notebook");
  if (!Array.isArray(input.cells)) throw new Error("Notebook cells must be an array.");
  const ids = new Set<string>();
  const cells = input.cells.map(raw => {
    const cell = record(raw, "Cell");
    if (typeof cell.id !== "string" || !CELL_ID.test(cell.id) || ids.has(cell.id)) throw new Error("Cell ids must be unique identifiers.");
    ids.add(cell.id);
    if (cell.type !== "code" && cell.type !== "markdown") throw new Error("Cell type must be code or markdown.");
    if (typeof cell.source !== "string") throw new Error("Cell source must be a string.");
    const outputs = cell.type === "code" && Array.isArray(cell.outputs) ? cell.outputs.map(readOutput).filter((o): o is NotebookOutput => o !== null) : [];
    return { id: cell.id, type: cell.type, source: cell.source, outputs, executionCount: typeof cell.executionCount === "number" ? cell.executionCount : null } satisfies NotebookCell;
  });
  const seeded = Array.isArray(input.seeded) ? input.seeded.filter((id): id is string => typeof id === "string") : [];
  return { cells, seeded };
}

/** nbformat 4.5, so the file also opens in Jupyter or Colab. */
export function toIpynb(notebook: Notebook): unknown {
  return {
    nbformat: 4, nbformat_minor: 5,
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
      language_info: { name: "python" },
      learnharness: { seededProblemIds: notebook.seeded },
    },
    cells: notebook.cells.map(cell => cell.type === "markdown"
      ? { id: cell.id, cell_type: "markdown", metadata: {}, source: cell.source }
      : { id: cell.id, cell_type: "code", metadata: {}, source: cell.source, outputs: cell.outputs, execution_count: cell.executionCount }),
  };
}

export function fromIpynb(value: unknown): Notebook {
  const input = record(value, "Notebook file");
  const cells = Array.isArray(input.cells) ? input.cells : [];
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata as Record<string, unknown> : {};
  const lh = metadata.learnharness && typeof metadata.learnharness === "object" ? metadata.learnharness as Record<string, unknown> : {};
  return parseNotebook({
    seeded: lh.seededProblemIds,
    cells: cells.map((raw, index) => {
      const cell = record(raw, "Cell");
      return {
        id: typeof cell.id === "string" && CELL_ID.test(cell.id) ? cell.id : `cell-${index}`,
        type: cell.cell_type === "markdown" ? "markdown" : "code",
        source: text(cell.source),
        outputs: cell.outputs,
        executionCount: cell.execution_count,
      };
    }),
  });
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… [${value.length - limit} more characters]`;
}

/** Plain-text view for the tutor: last 40 cells, outputs capped at 2 KB each. */
export function notebookAsText(notebook: Notebook, { maxCells = 40, maxOutput = 2048 } = {}): string {
  if (!notebook.cells.length) return "The learner's notebook is empty.";
  const skipped = Math.max(0, notebook.cells.length - maxCells);
  const lines: string[] = [];
  if (skipped) lines.push(`[${skipped} earlier cells omitted]`);
  notebook.cells.slice(skipped).forEach((cell, offset) => {
    const number = skipped + offset + 1;
    if (cell.type === "markdown") {
      lines.push(`--- Cell ${number} (markdown) ---`, cell.source);
      return;
    }
    lines.push(`--- Cell ${number} (code, ${cell.executionCount === null ? "not run" : `In [${cell.executionCount}]`}) ---`, cell.source);
    for (const output of cell.outputs) {
      let body: string;
      if (output.output_type === "stream") body = `[${output.name}]\n${output.text}`;
      else if (output.output_type === "error") body = `[error] ${output.ename}: ${output.evalue}\n${stripAnsi(output.traceback.join("\n"))}`;
      else {
        const plain = output.data["text/plain"];
        const image = Object.keys(output.data).some(key => key.startsWith("image/"));
        body = `[${output.output_type === "execute_result" ? "result" : "display"}] ${image ? "[image] " : ""}${text(plain)}`;
      }
      lines.push(truncate(body, maxOutput));
    }
  });
  return lines.join("\n");
}
