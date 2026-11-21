import type { PluginFrontendContext, PluginProblemEditorHandle, PluginProblemEditorProps, PluginQuestionAnswerState, PluginQuestionEditorHandle, PluginQuestionEditorProps } from "learnharness-plugin-api";
import { openNotebookFor, registerAnswerTarget, answerTargetsChanged, type AnswerTarget } from "./answer-targets.ts";
import { readValueResult, type ValuePayload, type ValueQuestionPayload, type ValueResult } from "./value.ts";

function valueOf(answer: PluginQuestionAnswerState): string {
  return answer.status === "empty" || typeof answer.value !== "string" ? "" : answer.value;
}

interface Target { id: string; kind: "question" | "problem"; statement: string }

/** SEEK-style answer box: a number/text field, or one radio per option. */
function mountValueEditor(container: HTMLElement, props: {
  payload: ValuePayload; answer: PluginQuestionAnswerState; active: boolean; chatId: string; signal: AbortSignal;
  onChange(answer: PluginQuestionAnswerState): void; target: Target;
}): PluginQuestionEditorHandle {
  const document = container.ownerDocument;
  let active = props.active, disposed = false;
  let current = valueOf(props.answer);
  const root = document.createElement("div");
  root.className = "lh-value";
  const header = document.createElement("div");
  header.className = "lh-value__header";
  const label = document.createElement("span");
  label.textContent = props.payload.answerType === "choice" ? "Choose one" : props.payload.answerType === "number" ? "Your answer (number)" : "Your answer";
  const notebook = document.createElement("button");
  notebook.type = "button";
  notebook.className = "lh-coding-question__notebook";
  notebook.textContent = "Open notebook";
  notebook.title = "Open the scratch notebook (Ctrl+Shift+N)";
  header.append(label, notebook);
  root.append(header);

  const publish = (value: string) => {
    current = value;
    if (!disposed && active && !props.signal.aborted) props.onChange(/\S/.test(value) ? { status: "ready", value } : { status: "unready", value });
  };

  let input: HTMLInputElement | undefined;
  const radios: HTMLInputElement[] = [];
  if (props.payload.answerType === "choice") {
    const list = document.createElement("div");
    list.className = "lh-value__options";
    const name = `lh-value-${props.target.id}`;
    for (const option of props.payload.options ?? []) {
      const row = document.createElement("label");
      row.className = "lh-value__option";
      const radio = document.createElement("input");
      radio.type = "radio"; radio.name = name; radio.value = option;
      radio.checked = option === current;
      radio.addEventListener("change", () => { if (radio.checked) publish(option); });
      const text = document.createElement("span");
      text.textContent = option;
      row.append(radio, text);
      list.append(row);
      radios.push(radio);
    }
    root.append(list);
  } else {
    input = document.createElement("input");
    input.type = "text";
    input.inputMode = props.payload.answerType === "number" ? "decimal" : "text";
    input.className = "lh-value__input";
    input.placeholder = props.payload.answerType === "number" ? "e.g. 0.8472" : "Type the value";
    input.autocomplete = "off"; input.spellcheck = false;
    input.value = current;
    input.setAttribute("aria-label", "Answer value");
    input.addEventListener("input", () => publish(input!.value));
    root.append(input);
    const hint = document.createElement("div");
    hint.className = "lh-value__hint";
    hint.textContent = props.payload.answerType === "number"
      ? "Compute it in the notebook, then type the number. Enter submits." : "Enter submits.";
    root.append(hint);
  }
  container.append(root);

  const setEditable = () => {
    if (input) input.disabled = !active;
    for (const radio of radios) radio.disabled = !active;
  };
  setEditable();

  const target: AnswerTarget = {
    sessionId: props.chatId, id: props.target.id, kind: props.target.kind, statement: props.target.statement,
    accepts: "value",
    payload: { language: "python", notebookSetup: props.payload.notebookSetup },
    isActive: () => !disposed && active && !props.signal.aborted,
    setCode(value) {
      if (disposed || !active) return;
      if (input) input.value = value;
      for (const radio of radios) radio.checked = radio.value === value;
      publish(value);
    },
    focus() { if (!disposed && active) (input ?? radios.find(radio => radio.checked) ?? radios[0])?.focus(); },
  };
  const unregister = registerAnswerTarget(target);
  notebook.addEventListener("click", () => { if (!disposed) openNotebookFor(target); });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    props.signal.removeEventListener("abort", dispose);
    unregister();
    root.remove();
  };
  if (props.signal.aborted) dispose();
  else { props.signal.addEventListener("abort", dispose, { once: true }); if (current) publish(current); }

  return {
    update(next) {
      if (disposed) return;
      const changed = active !== next.active;
      active = next.active;
      const value = valueOf(next.answer);
      if (value !== current) target.setCode(value);
      setEditable();
      if (changed) answerTargetsChanged();
    },
    focus: () => target.focus(),
    handleKeyDown(key) {
      // Enter submits through the host; nothing to edit across lines here.
      return key === "Shift+Enter" ? "handled" : "pass";
    },
    dispose,
  };
}

export function mountValueAnswerEditor(container: HTMLElement, props: PluginQuestionEditorProps<ValueQuestionPayload>): PluginQuestionEditorHandle {
  return mountValueEditor(container, {
    payload: props.input.payload, answer: props.answer, active: props.active, chatId: props.chatId, signal: props.signal, onChange: props.onChange,
    target: { id: props.questionId, kind: "question", statement: props.input.question },
  });
}

export function mountValueSubmissionEditor(container: HTMLElement, props: PluginProblemEditorProps<ValuePayload>): PluginProblemEditorHandle {
  const handle = mountValueEditor(container, {
    payload: props.input.payload, answer: props.submission, active: props.active, chatId: props.chatId, signal: props.signal, onChange: props.onChange,
    target: { id: props.problemId, kind: "problem", statement: props.input.statement },
  });
  return { ...handle, update(next) { handle.update({ answer: next.submission, active: next.active }); } };
}

function format(value: unknown): string {
  return typeof value === "number" ? String(Number(value.toPrecision(10))) : String(value);
}

/** The submitted value plus a Correct/Incorrect badge. revealExpected only once the question is over. */
export function mountValueSubmitted(container: HTMLElement, ui: Pick<PluginFrontendContext["ui"], "mountBadge">, submission: unknown, outcome: { result: unknown } | { error: string } | undefined, signal: AbortSignal, options: { headerContainer?: HTMLElement; revealExpected: boolean }): () => void {
  if (signal.aborted) return () => {};
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = "lh-value lh-value--submitted";
  const value = document.createElement("div");
  value.className = "lh-value__submitted";
  value.textContent = typeof submission === "string" ? submission : "";
  root.append(value);
  const result: ValueResult | null = outcome && "result" in outcome ? readValueResult(outcome.result) : null;
  if (result?.message || (outcome && "error" in outcome)) {
    const note = document.createElement("p");
    note.className = "lh-value__hint";
    note.textContent = result?.message ?? (outcome as { error: string }).error;
    root.append(note);
  }
  if (result && result.status === "incorrect" && options.revealExpected && result.expected !== undefined) {
    const expected = document.createElement("p");
    expected.className = "lh-value__hint";
    expected.textContent = `Correct answer: ${format(result.expected)}${result.tolerance ? ` (±${format(result.tolerance)})` : ""}`;
    root.append(expected);
  }
  container.append(root);
  const badgeRoot = document.createElement("span");
  (options.headerContainer ?? root).append(badgeRoot);
  const status = result?.status ?? "error";
  const badge = ui.mountBadge(badgeRoot, {
    text: status === "correct" ? "Correct" : status === "incorrect" ? "Incorrect" : status === "invalid" ? "Not a valid answer" : "Could not check",
    ...(status === "correct" ? { color: "var(--color-green-500, #22c55e)" } : status === "incorrect" ? { color: "var(--color-red-500, #ef4444)" } : {}),
  }, { signal });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    try { badge.dispose(); } finally { badgeRoot.remove(); root.remove(); }
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
