import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fromIpynb, parseNotebook, SESSION_ID, toIpynb, type Notebook } from "./notebook-model.ts";

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function sessionIdFrom(input: unknown): string {
  const id = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).sessionId : undefined;
  if (typeof id !== "string" || !SESSION_ID.test(id)) throw new Error("Expected a valid sessionId.");
  return id;
}

/** One .ipynb per learning session under <dataDirectory>/notebooks/. */
export class NotebookStore {
  constructor(private readonly dataDirectory: string) {}

  file(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error("Invalid session id.");
    return path.join(this.dataDirectory, "notebooks", `${sessionId}.ipynb`);
  }

  load(sessionId: string): Notebook {
    try { return fromIpynb(JSON.parse(fs.readFileSync(this.file(sessionId), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cells: [], seeded: [] };
      throw error;
    }
  }

  /** Copy the current notebook to notebooks/archive/ before a reset. Returns the copy, or undefined if there was none. */
  archive(sessionId: string): string | undefined {
    const file = this.file(sessionId);
    if (!fs.existsSync(file)) return undefined;
    const copy = path.join(this.dataDirectory, "notebooks", "archive", `${sessionId}-${new Date().toISOString().replace(/[:.]/g, "-")}.ipynb`);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(file, copy);
    return copy;
  }

  save(sessionId: string, value: unknown): void {
    const notebook = parseNotebook(value);
    atomicWrite(this.file(sessionId), JSON.stringify(toIpynb(notebook), null, 1) + "\n");
  }
}

export interface NotebookSettings {
  python: string;
  /** Whether the tutor may start a fresh notebook (reset_notebook). */
  tutorReset: boolean;
}
const DEFAULT_SETTINGS: NotebookSettings = { python: "", tutorReset: true };

export function readSettings(dataDirectory: string): NotebookSettings {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDirectory, "settings.json"), "utf8")) as Record<string, unknown>;
    return { python: typeof value.python === "string" ? value.python : "", tutorReset: value.tutorReset !== false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS };
    throw error;
  }
}

export function writeSettings(dataDirectory: string, settings: NotebookSettings): void {
  atomicWrite(path.join(dataDirectory, "settings.json"), JSON.stringify(settings) + "\n");
}

/** Accept a bare command name on PATH or an absolute path to an existing file. */
export function pythonPathError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed !== value) return "Remove leading or trailing spaces.";
  if (!path.isAbsolute(value)) return /^[A-Za-z0-9._-]+$/.test(value) ? null : "Use an absolute path or a command name on PATH.";
  try { return fs.statSync(value).isFile() ? null : "Not a file."; }
  catch { return "File not found."; }
}
