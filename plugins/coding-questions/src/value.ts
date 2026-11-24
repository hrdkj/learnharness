import type { PluginProblemTypeDefinition, PluginQuestionTypeDefinition } from "learnharness-plugin-api";

/** OPPE/SEEK-style questions: work it out in the notebook, type the value. */
export const VALUE_TYPE_ID = "value";

export type ValueKind = "number" | "choice" | "text";
export type ValueAnswer = number | string;
export type ValuePayload = {
  answerType: ValueKind;
  options?: string[];
  notebookSetup?: string;
  /** Stored key (e.g. from a paper's answer sheet). */
  answer?: ValueAnswer;
  /** Python run after notebookSetup in a fresh process; must assign `answer`. */
  reference?: string;
  /** Absolute tolerance for numbers. */
  tolerance?: number;
};
export type ValueQuestionPayload = ValuePayload & { modelSolution: string };

/** What the answer box sends when the learner picks "I don't know". */
export const DONT_KNOW = "I don't know";
export function isDontKnow(raw: string): boolean { return raw.trim() === DONT_KNOW; }

export type ValueResult = {
  status: "correct" | "incorrect" | "invalid" | "error" | "dont_know";
  submitted: string;
  expected?: ValueAnswer;
  tolerance?: number;
  message?: string;
};

const payloadSchema = {
  answerType: {
    type: "string", enum: ["number", "choice", "text"],
    description: "number: the learner types a number (checked within tolerance). choice: the learner picks one of options. text: a short word or name (case and spacing ignored).",
  },
  options: { type: "array", items: { type: "string", pattern: "\\S" }, minItems: 2, description: "Required for choice: the options shown, in order. answer/reference must equal one of them." },
  notebookSetup: {
    type: "string",
    description: "Python that loads the data for this question (imports + pd.read_csv of the local CSV by absolute path, or a small in-memory frame). Appended to the learner's notebook and run automatically; also run before reference. Never the solution.",
  },
  answer: { type: ["number", "string"], description: "The correct value when it is already known (e.g. from a paper's answer key)." },
  reference: {
    type: "string", pattern: "\\S",
    description: "Python that computes the correct value and assigns it to the variable `answer`, run in a fresh process after notebookSetup when the learner submits. Use it for generated questions so the app checks the real number. Verify it first with compute_answer.",
  },
  tolerance: { type: "number", minimum: 0, description: "Absolute tolerance for number answers. Defaults to 0 for integer answers and 0.01 otherwise. Match the question's rounding instruction." },
} as const;

const valueInstructions = "Use exam questions for OPPE/SEEK-style practice where only the final value matters: the learner computes it in the docked notebook (code is never graded) and types a number, picks an option or types a short name. Supply payload.answerType, options for choice, notebookSetup that loads the dataset, and either answer (a known key, e.g. from a paper's answer sheet) or reference (Python that assigns `answer`, for generated or harder variants; always call compute_answer with the same notebookSetup and reference first to check it runs and the value is sensible). State any rounding in the question and set tolerance to match. Each submission returns correct/incorrect with the expected value for you only; status dont_know means the learner chose 'I don't know': treat it as an honest gap, not a wrong guess. Do not reveal the value: name the first step of the method (which column, filter or function), let them try again, and give more only as they need it; never reveal the expected value or the method before the learner gets it right or asks to give up. When an answer is wrong, call read_notebook, find the exact cell where their approach diverges (wrong filter, missed sentinel such as 'UNKNOWN' or -1, fitting on all data, wrong split/random_state, wrong metric or sign, rounding) and give one targeted hint quoting their code. Keep the CPU light: prefer the provided CSVs, avoid huge grids.";

export const valueTeachInstructions = "When a check calls for computing a value from data, you may use exam_question. " + valueInstructions;
export const valuePracticeInstructions = "For data-analysis/ML practice (e.g. IITM MLP OPPE) prefer exam_problem over coding_problem. " + valueInstructions + " Use the existing conclude tool after the learner gets it right (or gives up); put the full working code in modelSolution.";

export const valueQuestionDefinition = {
  id: VALUE_TYPE_ID,
  label: "Exam question",
  contractVersion: 1,
  showThinking: true,
  questionSchema: {
    type: "object",
    properties: { ...payloadSchema, modelSolution: { type: "string", pattern: "\\S", description: "Markdown with the code that computes the answer; shown after answering." } },
    required: ["answerType", "modelSolution"],
    additionalProperties: false,
  },
  answerSchema: { type: "string", pattern: "\\S" },
  validateQuestion: context => payloadErrors(context.input.payload),
  teach: {
    toolName: "exam_question",
    description: "Ask an OPPE-style question whose answer is a single value computed from data in the learner's notebook: a number (checked within tolerance), one of several options, or a short name. Supply answer (known key) or reference (Python assigning `answer`). Code is never graded.",
  },
} satisfies PluginQuestionTypeDefinition;

export const valueProblemDefinition = {
  id: VALUE_TYPE_ID,
  label: "Exam question",
  contractVersion: 1,
  tool: {
    toolName: "exam_problem",
    description: "Pose an OPPE/SEEK-style practice question: the learner computes a value in the docked notebook and types it (number within tolerance, an option, or a short name). Supply payload.answer (known key) or payload.reference (Python that assigns `answer`, run after notebookSetup on submit). Each submission returns correct/incorrect plus the expected value for you. Allow retries; conclude with the existing tool.",
  },
  problemSchema: { type: "object", properties: payloadSchema, required: ["answerType"], additionalProperties: false },
  submissionSchema: { type: "string", pattern: "\\S" },
  validateProblem: context => payloadErrors(context.input.payload),
} satisfies PluginProblemTypeDefinition;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function readValuePayload(value: unknown): ValuePayload {
  const payload = record(value);
  if (!payload) throw new Error("Exam question payload is unavailable.");
  const answerType = payload.answerType;
  if (answerType !== "number" && answerType !== "choice" && answerType !== "text") throw new Error("Exam question answerType is invalid.");
  const result: ValuePayload = { answerType };
  if (Array.isArray(payload.options)) result.options = payload.options.filter((item): item is string => typeof item === "string");
  if (typeof payload.notebookSetup === "string") result.notebookSetup = payload.notebookSetup;
  if (typeof payload.answer === "number" || typeof payload.answer === "string") result.answer = payload.answer;
  if (typeof payload.reference === "string" && /\S/.test(payload.reference)) result.reference = payload.reference;
  if (typeof payload.tolerance === "number" && payload.tolerance >= 0) result.tolerance = payload.tolerance;
  return result;
}

function payloadErrors(value: unknown): string[] | undefined {
  let payload: ValuePayload;
  try { payload = readValuePayload(value); } catch (error) { return [error instanceof Error ? error.message : String(error)]; }
  const errors: string[] = [];
  if (payload.answer === undefined && payload.reference === undefined) errors.push("Supply answer (a known key) or reference (Python that assigns `answer`).");
  if (payload.answerType === "choice") {
    if (!payload.options || payload.options.length < 2) errors.push("A choice question needs at least two options.");
    else if (payload.answer !== undefined && !payload.options.some(option => sameText(option, String(payload.answer)))) errors.push("answer must equal one of options.");
  }
  if (payload.answerType === "number" && typeof payload.answer === "string" && parseNumber(payload.answer) === null) errors.push("answer must be a number for a number question.");
  return errors.length ? errors : undefined;
}

const normalize = (text: string) => text.trim().replace(/^['"`]+|['"`]+$/g, "").replace(/\s+/g, " ").toLowerCase();
export function sameText(a: string, b: string): boolean { return normalize(a) === normalize(b); }

/** Accepts what people paste from a notebook: 1,234.5 · np.float64(0.38) · '42' · 38.5%. */
export function parseNumber(raw: string): number | null {
  let text = raw.trim().replace(/^['"`]+|['"`]+$/g, "");
  const wrapped = /^(?:np\.|numpy\.)?\w*\((.*)\)$/s.exec(text);
  if (wrapped) text = wrapped[1]!.trim();
  text = text.replace(/[,_\s]/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(text)) return null;
  const number = Number(text.replace(/%$/, ""));
  return Number.isFinite(number) ? number : null;
}

export function defaultTolerance(expected: number): number {
  return Number.isInteger(expected) ? 0 : 0.01;
}

export function compareValue(payload: ValuePayload, expected: ValueAnswer, submittedRaw: string): ValueResult {
  const submitted = submittedRaw.trim();
  if (isDontKnow(submitted)) return { status: "dont_know", submitted, expected };
  if (payload.answerType === "number") {
    const value = parseNumber(submitted);
    const target = typeof expected === "number" ? expected : parseNumber(expected);
    if (target === null) return { status: "error", submitted, expected, message: "The reference answer is not a number." };
    if (value === null) return { status: "invalid", submitted, expected: target, message: "Enter a number." };
    const tolerance = payload.tolerance ?? defaultTolerance(target);
    const close = Math.abs(value - target) <= tolerance + 1e-9 * Math.max(1, Math.abs(target));
    return { status: close ? "correct" : "incorrect", submitted, expected: target, tolerance };
  }
  return { status: sameText(submitted, String(expected)) ? "correct" : "incorrect", submitted, expected };
}

/** Python program that runs setup + reference in one namespace and prints the answer as JSON. */
export function referenceProgram(setup: string, reference: string): string {
  return [
    "import json, math, os, sys, warnings",
    "warnings.filterwarnings('ignore')",
    "os.environ.setdefault('OMP_NUM_THREADS', '2'); os.environ.setdefault('OPENBLAS_NUM_THREADS', '2')",
    `_lh_setup = json.loads(${JSON.stringify(JSON.stringify(setup))})`,
    `_lh_reference = json.loads(${JSON.stringify(JSON.stringify(reference))})`,
    "_lh_ns = {'__name__': '__main__'}",
    "exec(compile(_lh_setup, '<notebookSetup>', 'exec'), _lh_ns)",
    "exec(compile(_lh_reference, '<reference>', 'exec'), _lh_ns)",
    "if 'answer' not in _lh_ns:",
    "    print('\\n__LH_ANSWER__' + json.dumps({'error': 'reference must assign the variable `answer`.'})); sys.exit(0)",
    "_lh_a = _lh_ns['answer']",
    "if hasattr(_lh_a, 'item') and callable(_lh_a.item):",
    "    try: _lh_a = _lh_a.item()",
    "    except Exception: pass",
    "if isinstance(_lh_a, bool): _lh_a = str(_lh_a)",
    "if isinstance(_lh_a, (int, float)):",
    "    if isinstance(_lh_a, float) and not math.isfinite(_lh_a):",
    "        print('\\n__LH_ANSWER__' + json.dumps({'error': 'answer is not finite: ' + repr(_lh_a)})); sys.exit(0)",
    "    print('\\n__LH_ANSWER__' + json.dumps({'answer': _lh_a}))",
    "else:",
    "    print('\\n__LH_ANSWER__' + json.dumps({'answer': str(_lh_a)}))",
  ].join("\n");
}

export function readReferenceOutput(stdout: string): { answer: ValueAnswer } | { error: string } {
  const line = stdout.split("\n").reverse().find(item => item.startsWith("__LH_ANSWER__"));
  if (!line) return { error: "The reference did not report an answer." };
  try {
    const parsed = JSON.parse(line.slice("__LH_ANSWER__".length)) as { answer?: unknown; error?: unknown };
    if (typeof parsed.error === "string") return { error: parsed.error };
    if (typeof parsed.answer === "number" || typeof parsed.answer === "string") return { answer: parsed.answer };
  } catch { /* fall through */ }
  return { error: "The reference reported an unreadable answer." };
}

export function readValueResult(value: unknown): ValueResult | null {
  const result = record(value);
  if (!result) return null;
  if (result.status !== "correct" && result.status !== "incorrect" && result.status !== "invalid" && result.status !== "error" && result.status !== "dont_know") return null;
  if (typeof result.submitted !== "string") return null;
  return result as unknown as ValueResult;
}
