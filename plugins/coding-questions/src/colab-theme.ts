import { pythonLanguage } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting, syntaxTree, type Language } from "@codemirror/language";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { styleTags, Tag, tags as t } from "@lezer/highlight";

/**
 * Google Colab's dark editor (VS Code Dark+ with bracket-pair colours on
 * Colab's #282a2c), always dark regardless of the app theme. Token colours
 * were pixel-sampled from a Colab screenshot; where the sample differed from
 * Dark+ the sampled value is used, because it is what Colab renders.
 * The host's chat code blocks (components/colab-code.ts) mirror this palette.
 */
export const COLAB = {
  background: "#282a2c",
  foreground: "#d4d4d4",
  border: "#444746",
  control: "#c99cc6",
  keyword: "#69a5d7",
  function: "#dcdcaa",
  parameter: "#9cdcfe",
  type: "#4ec9b0",
  string: "#ce9178",
  escape: "#d7ba7d",
  regexp: "#d16969",
  number: "#b5cea8",
  comment: "#82b76c",
  invalid: "#f44747",
  brackets: ["#ffd700", "#da70d6", "#179fff"],
  lineNumber: "#858585",
  activeLineNumber: "#c6c6c6",
  cursor: "#aeafad",
  selection: "#264f78",
  inactiveSelection: "#3a3d41",
} as const;

/** Function parameters (Lezer Python tags them as plain variable names). */
const parameterTag = Tag.define(t.variableName);

/**
 * Python with Colab's keyword split: `from`, `as` and `with` read as control
 * keywords (like `import`), `async` as a definition keyword, and parameter
 * names get their own tag. Only highlighting props change; parsing, indent
 * and folding are the stock language's.
 */
const colabPythonLanguage = pythonLanguage.configure({
  props: [styleTags({
    from: t.moduleKeyword,
    "with as": t.controlKeyword,
    async: t.definitionKeyword,
    "ParamList/VariableName": parameterTag,
  })],
});

/** The language to install: Colab-tagged Python, any other language as is. */
export function colabLanguage(language: Language): Language {
  return language.name === pythonLanguage.name ? colabPythonLanguage : language;
}

const colabHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: COLAB.comment },
  { tag: [t.string, t.special(t.string), t.character, t.docString], color: COLAB.string },
  { tag: t.escape, color: COLAB.escape },
  { tag: t.regexp, color: COLAB.regexp },
  { tag: t.number, color: COLAB.number },
  { tag: [t.controlKeyword, t.moduleKeyword], color: COLAB.control },
  { tag: [t.keyword, t.definitionKeyword, t.operatorKeyword, t.bool, t.null, t.atom, t.self], color: COLAB.keyword },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.function(t.propertyName)], color: COLAB.function },
  { tag: parameterTag, color: COLAB.parameter },
  { tag: [t.className, t.definition(t.className), t.typeName, t.namespace], color: COLAB.type },
  { tag: t.tagName, color: COLAB.keyword },
  { tag: t.attributeName, color: COLAB.parameter },
  { tag: t.invalid, color: COLAB.invalid },
]);

const colabEditorTheme = EditorView.theme({
  "&": { backgroundColor: COLAB.background, color: COLAB.foreground },
  ".cm-content": { caretColor: COLAB.cursor },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: COLAB.cursor },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection": { backgroundColor: COLAB.selection },
  ".cm-selectionBackground": { backgroundColor: COLAB.inactiveSelection },
  ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.04)" },
  ".cm-gutters": { backgroundColor: COLAB.background, color: COLAB.lineNumber, border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: COLAB.activeLineNumber },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "rgba(0, 100, 0, 0.1)", outline: "1px solid #888888" },
  ".cm-selectionMatch": { backgroundColor: "rgba(173, 214, 255, 0.15)" },
  ".cm-colabBracket0": { color: COLAB.brackets[0] },
  ".cm-colabBracket1": { color: COLAB.brackets[1] },
  ".cm-colabBracket2": { color: COLAB.brackets[2] },
}, { dark: true });

const OPEN = new Set(["(", "[", "{"]);
const CLOSE: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const bracketMarks = [0, 1, 2].map(depth => Decoration.mark({ class: `cm-colabBracket${depth}` }));

/**
 * Colour `()[]{}` by nesting depth, like VS Code/Colab bracket-pair
 * colourisation. Brackets are the parser's bracket tokens, so brackets inside
 * strings and comments (which are text, not tokens) are never counted.
 * Unmatched closers keep the default colour.
 */
function bracketDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const end = view.viewport.to;
  const from = view.viewport.from;
  const stack: { char: string; depth: number }[] = [];
  syntaxTree(view.state).iterate({
    to: end,
    enter(node) {
      if (node.to - node.from !== 1) return;
      const name = node.name;
      let depth: number;
      if (OPEN.has(name)) {
        depth = stack.length;
        stack.push({ char: name, depth });
      } else if (name in CLOSE) {
        if (stack.at(-1)?.char !== CLOSE[name]) return;
        depth = stack.pop()!.depth;
      } else return;
      if (node.from >= from) builder.add(node.from, node.to, bracketMarks[depth % 3]!);
    },
  });
  return builder.finish();
}

const bracketPairColours = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = bracketDecorations(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = bracketDecorations(update.view);
    }
  }
}, { decorations: plugin => plugin.decorations });

/** Colab look for every code editor: background, chrome, tokens and brackets. */
export function colabTheme(): Extension {
  return [colabEditorTheme, syntaxHighlighting(colabHighlightStyle), bracketPairColours];
}
