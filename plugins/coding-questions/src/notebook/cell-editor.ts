import { acceptCompletion, autocompletion, completionKeymap, completionStatus, startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { history, indentLess, indentMore } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { bracketMatching, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { EditorState, Prec } from "@codemirror/state";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { drawSelection, EditorView, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { syntaxDiagnosticsExtension } from "../diagnostics.ts";
import { editingExtensions } from "../editor-extensions.ts";
import { stripAnsi } from "../notebook-model.ts";

export interface CellKeys {
  run(): void;
  runNext(): void;
  runInsert(): void;
  escape(): void;
  docs(text: string | null): void;
  focusChange(focused: boolean): void;
}

export interface KernelRequests {
  request(op: "complete" | "inspect", code: string, cursor: number): Promise<Record<string, unknown>>;
}

/** Jupyter cursor offsets count code points; CodeMirror counts UTF-16 units. */
export function toCodePoints(text: string, utf16: number): number { return [...text.slice(0, utf16)].length; }
export function fromCodePoints(text: string, points: number): number { return [...text].slice(0, points).join("").length; }

const TYPE_MAP: Record<string, string> = { function: "function", class: "class", module: "namespace", instance: "variable", statement: "keyword", keyword: "keyword", path: "text", param: "variable", property: "property" };

function kernelCompletions(kernel: KernelRequests) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const before = context.matchBefore(/[\w.]*$/);
    // Colab behaviour: pop up on its own only after a dot; otherwise Ctrl+Space / Tab.
    if (!context.explicit && !before?.text.includes(".")) return null;
    const code = context.state.doc.toString();
    let reply: Record<string, unknown>;
    try { reply = await kernel.request("complete", code, toCodePoints(code, context.pos)); }
    catch { return null; }
    if (context.aborted || reply.status !== "ok" || !Array.isArray(reply.matches)) return null;
    const metadata = (reply.metadata ?? {}) as Record<string, unknown>;
    const typed = Array.isArray(metadata._jupyter_types_experimental) ? metadata._jupyter_types_experimental as { text?: string; type?: string; signature?: string }[] : [];
    const info = new Map(typed.filter(item => typeof item.text === "string").map(item => [item.text!, item]));
    const options: Completion[] = (reply.matches as unknown[]).filter((m): m is string => typeof m === "string").map(label => {
      const item = info.get(label);
      return { label, type: item?.type ? TYPE_MAP[item.type] ?? "variable" : undefined, detail: item?.signature || undefined };
    });
    if (!options.length) return null;
    const from = fromCodePoints(code, Number(reply.cursor_start)), to = fromCodePoints(code, Number(reply.cursor_end));
    return { from, to, options, validFor: /^[\w]*$/ };
  };
}

export function createCellEditor(parent: HTMLElement, options: {
  source: string;
  kind: "code" | "markdown";
  kernel: KernelRequests;
  keys: CellKeys;
  onChange(source: string): void;
}): EditorView {
  const { keys } = options;
  const code = options.kind === "code";
  const docs = async (view: EditorView) => {
    const text = view.state.doc.toString();
    try {
      const reply = await options.kernel.request("inspect", text, toCodePoints(text, view.state.selection.main.head));
      const data = (reply.data ?? {}) as Record<string, unknown>;
      keys.docs(reply.found && typeof data["text/plain"] === "string" ? stripAnsi(data["text/plain"]) : "No documentation found. Run the cell that defines or imports the name first.");
    } catch (error) { keys.docs(error instanceof Error ? error.message : String(error)); }
    return true;
  };
  const tab = (view: EditorView) => {
    if (completionStatus(view.state) === "active") return acceptCompletion(view);
    const { head, empty } = view.state.selection.main;
    const previous = head > 0 ? view.state.sliceDoc(head - 1, head) : "";
    if (code && empty && /[\w.]/.test(previous)) return startCompletion(view);
    return indentMore(view);
  };
  const cellKeys = Prec.highest(keymap.of([
    { key: "Mod-Enter", run: () => { keys.run(); return true; } },
    { key: "Shift-Enter", run: () => { keys.runNext(); return true; } },
    { key: "Alt-Enter", run: () => { keys.runInsert(); return true; } },
    { key: "Escape", run: view => { if (completionStatus(view.state)) return false; keys.escape(); return true; } },
    { key: "Tab", run: tab },
    { key: "Shift-Tab", run: indentLess },
    { key: "Mod-Shift-Space", run: view => { void docs(view); return true; } },
  ]));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: options.source,
      extensions: [
        cellKeys,
        ...(code ? [lineNumbers(), python(), syntaxDiagnosticsExtension(), autocompletion({ override: [kernelCompletions(options.kernel)], activateOnTyping: true, defaultKeymap: false, icons: true }), keymap.of(completionKeymap)] : [EditorView.lineWrapping, placeholder("Text (Markdown)…")]),
        history(),
        drawSelection(),
        bracketMatching(),
        EditorState.tabSize.of(4),
        indentUnit.of("    "),
        syntaxHighlighting(oneDarkHighlightStyle),
        ...editingExtensions(new Set(["Escape", "Mod-Enter", "Shift-Enter", "Alt-Enter", "Tab", "Shift-Tab"])),
        EditorView.contentAttributes.of({ "aria-label": code ? "Code cell" : "Text cell", spellcheck: code ? "false" : "true" }),
        EditorView.updateListener.of(update => {
          if (update.docChanged) options.onChange(update.state.doc.toString());
          if (update.focusChanged) keys.focusChange(update.view.hasFocus);
        }),
      ],
    }),
  });
  return view;
}
