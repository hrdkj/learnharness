import type { PluginFrontendContext, PluginProblemRenderer, PluginQuestionRenderer } from "learnharness-plugin-api";
import { QUESTION_TYPE_ID, PROBLEM_TYPE_ID, type CodingPayload, type CodingQuestionPayload } from "./contract.ts";
import { mountAnswered, mountAnswerEditor, mountSubmissionEditor } from "./editor.ts";
import { mountTestResult } from "./result-view.ts";
import { mountModelSolution } from "./solution-view.ts";
import { mountSavedQuestion } from "./question-view.ts";
import { readTestResult, type CodingTestResult } from "./test-result.ts";
import { activateNotebook } from "./notebook/entry.ts";
import { VALUE_TYPE_ID, type ValuePayload, type ValueQuestionPayload } from "./value.ts";
import { mountValueAnswerEditor, mountValueSubmissionEditor, mountValueSubmitted } from "./value-view.ts";

function mountRecordedTests(container: HTMLElement, ctx: PluginFrontendContext, outcome: { result: unknown } | { error: string }, signal: AbortSignal, headerContainer?: HTMLElement): () => void {
  const result = "result" in outcome ? readTestResult(outcome.result) : null;
  const failure: CodingTestResult = {
    status: "error", exitCode: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
    message: "error" in outcome ? outcome.error : "Saved test result is unavailable.",
  };
  return mountTestResult(container, ctx.ui, result ?? failure, signal, headerContainer);
}

export function activate(ctx: PluginFrontendContext): () => void {
  const unregisterQuestion = ctx.registerQuestionRenderer({
    id: QUESTION_TYPE_ID,
    supportedContractVersions: [1],
    mountAnswerEditor,
    mountAnswered(container, props) {
      if (props.signal.aborted) return;
      let questionCleanup: (() => void) | undefined;
      let codeCleanup: (() => void) | undefined;
      let resultCleanup: (() => void) | undefined;
      let solutionCleanup: (() => void) | undefined;
      const dispose = () => {
        try { questionCleanup?.(); }
        finally { try { codeCleanup?.(); } finally { try { resultCleanup?.(); } finally { solutionCleanup?.(); } } }
      };
      try {
        questionCleanup = mountSavedQuestion(container, ctx.ui, props.input.question, props.signal);
        if (props.signal.aborted) return dispose;
        codeCleanup = mountAnswered(container, props);
        if (props.grading !== undefined) {
          resultCleanup = mountRecordedTests(props.footerContainer ?? container, ctx, props.grading, props.signal, props.headerContainer);
        }
        solutionCleanup = mountModelSolution(props.footerContainer ?? container, ctx.ui, props.input.payload.modelSolution, props.signal);
        return dispose;
      } catch (error) { dispose(); throw error; }
    },
  } satisfies PluginQuestionRenderer<CodingQuestionPayload, string>);
  const unregisterProblem = ctx.registerProblemRenderer({
    id: PROBLEM_TYPE_ID,
    supportedContractVersions: [1],
    mountSubmissionEditor,
    mountSubmitted(container, props) {
      if (props.signal.aborted) return;
      let codeCleanup: (() => void) | undefined;
      let resultCleanup: (() => void) | undefined;
      const dispose = () => { try { codeCleanup?.(); } finally { resultCleanup?.(); } };
      try {
        codeCleanup = mountAnswered(container, { input: props.input, answer: props.submission, signal: props.signal });
        if (props.processing !== undefined) {
          resultCleanup = mountRecordedTests(props.footerContainer ?? container, ctx, props.processing, props.signal, props.headerContainer);
        }
        return dispose;
      } catch (error) { dispose(); throw error; }
    },
  } satisfies PluginProblemRenderer<CodingPayload, string>);
  const unregisterValueQuestion = ctx.registerQuestionRenderer({
    id: VALUE_TYPE_ID,
    supportedContractVersions: [1],
    mountAnswerEditor: mountValueAnswerEditor,
    mountAnswered(container, props) {
      if (props.signal.aborted) return;
      const cleanups: (() => void)[] = [];
      const dispose = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); };
      try {
        cleanups.push(mountSavedQuestion(container, ctx.ui, props.input.question, props.signal));
        cleanups.push(mountValueSubmitted(container, ctx.ui, props.answer, props.grading, props.signal, { headerContainer: props.headerContainer, revealExpected: true }));
        cleanups.push(mountModelSolution(props.footerContainer ?? container, ctx.ui, props.input.payload.modelSolution, props.signal));
        return dispose;
      } catch (error) { dispose(); throw error; }
    },
  } satisfies PluginQuestionRenderer<ValueQuestionPayload, string>);
  const unregisterValueProblem = ctx.registerProblemRenderer({
    id: VALUE_TYPE_ID,
    supportedContractVersions: [1],
    mountSubmissionEditor: mountValueSubmissionEditor,
    mountSubmitted(container, props) {
      if (props.signal.aborted) return;
      return mountValueSubmitted(container, ctx.ui, props.submission, props.processing, props.signal, { headerContainer: props.headerContainer, revealExpected: false });
    },
  } satisfies PluginProblemRenderer<ValuePayload, string>);
  const disposeNotebook = activateNotebook(ctx);
  return () => {
    try { disposeNotebook(); }
    finally { try { unregisterValueProblem(); unregisterValueQuestion(); } finally { try { unregisterProblem(); } finally { unregisterQuestion(); } } }
  };
}
