import type { CodingPayload } from "./contract.ts";

/** A mounted, answerable coding editor that the notebook can fill. */
export interface AnswerTarget {
  readonly sessionId: string;
  /** questionId or problemId. */
  readonly id: string;
  readonly kind: "question" | "problem";
  readonly statement: string;
  readonly payload: Pick<CodingPayload, "language" | "notebookSetup">;
  isActive(): boolean;
  setCode(code: string): void;
  focus(): void;
}

const targets = new Set<AnswerTarget>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

export function registerAnswerTarget(target: AnswerTarget): () => void {
  targets.add(target);
  notify();
  return () => { if (targets.delete(target)) notify(); };
}

export function answerTargetsChanged(): void { notify(); }

export function onAnswerTargetsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The active editor for a session; prefers the given id when several are mounted. */
export function activeAnswerTarget(sessionId: string, preferredId?: string): AnswerTarget | undefined {
  const active = [...targets].filter(target => target.sessionId === sessionId && target.isActive());
  return active.find(target => target.id === preferredId) ?? active.at(-1);
}

/** Opens the notebook from a problem card; installed by main.ts. */
let opener: ((target: AnswerTarget) => void) | undefined;
export function setNotebookOpener(next: typeof opener): void { opener = next; }
export function openNotebookFor(target: AnswerTarget): void { opener?.(target); }
