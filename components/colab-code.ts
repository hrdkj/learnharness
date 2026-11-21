import { createCodePlugin, type ThemeInput } from "@streamdown/code";
import type { CodeHighlighterPlugin } from "streamdown";

/**
 * Chat code blocks look like Google Colab's dark editor in BOTH app themes:
 * one Shiki theme fills both theme slots, and bracket pairs are coloured by
 * nesting depth. The palette mirrors COLAB in
 * plugins/coding-questions/src/colab-theme.ts (notebook cells and the answer
 * editor), so all code the learner reads or types looks the same.
 */
export const COLAB_CODE = {
	background: "#282a2c",
	foreground: "#d4d4d4",
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
} as const;

const c = COLAB_CODE;

/** A Shiki (TextMate) theme: Dark+ scopes on Colab's colours. Later rules
 *  win for equally specific scopes; more specific scopes always win. */
export const colabShikiTheme: Exclude<ThemeInput, string> = {
	name: "lh-colab-dark",
	type: "dark",
	fg: c.foreground,
	bg: c.background,
	colors: { "editor.background": c.background, "editor.foreground": c.foreground },
	tokenColors: [
		{ settings: { foreground: c.foreground, background: c.background } },
		{ scope: ["comment", "punctuation.definition.comment"], settings: { foreground: c.comment } },
		{ scope: ["string", "punctuation.definition.string"], settings: { foreground: c.string } },
		{ scope: ["constant.character.escape"], settings: { foreground: c.escape } },
		{ scope: ["string.regexp"], settings: { foreground: c.regexp } },
		{ scope: ["constant.numeric"], settings: { foreground: c.number } },
		{ scope: ["keyword", "storage.type", "storage.modifier", "constant.language", "variable.language", "entity.name.tag", "constant.character.format.placeholder"], settings: { foreground: c.keyword } },
		{ scope: ["keyword.operator"], settings: { foreground: c.foreground } },
		{ scope: ["keyword.operator.logical.python", "keyword.operator.new", "keyword.operator.expression", "keyword.operator.wordlike"], settings: { foreground: c.keyword } },
		{ scope: ["keyword.control"], settings: { foreground: c.control } },
		{ scope: ["entity.name.function", "support.function", "meta.function-call.generic"], settings: { foreground: c.function } },
		{ scope: ["variable.parameter", "entity.other.attribute-name", "support.type.property-name"], settings: { foreground: c.parameter } },
		// Keyword arguments in a call are not parameters (Colab leaves them plain).
		{ scope: ["variable.parameter.function-call"], settings: { foreground: c.foreground } },
		{ scope: ["entity.name.type", "entity.name.class", "entity.name.namespace", "support.type", "support.class", "entity.other.inherited-class"], settings: { foreground: c.type } },
		{ scope: ["invalid"], settings: { foreground: c.invalid } },
	],
};

type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;
type HighlightToken = HighlightResult["tokens"][number][number];

const OPEN = "([{";
const CLOSE: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function tokenColor(token: HighlightToken): string | undefined {
	return (token.htmlStyle?.color ?? token.color)?.toLowerCase();
}

function withColor(token: HighlightToken, content: string, offset: number, color: string | undefined): HighlightToken {
	const next: HighlightToken = { ...token, content, offset };
	if (color === undefined) return next;
	next.color = color;
	if (token.htmlStyle) next.htmlStyle = { ...token.htmlStyle, color, "--shiki-dark": color };
	return next;
}

/**
 * Pure: colour `()[]{}` by nesting depth across the whole block. Only
 * brackets in default-foreground tokens count, so brackets inside strings,
 * comments and other coloured tokens are left alone. Unmatched closers keep
 * the default colour. Exported for tests.
 */
export function colorizeBrackets(result: HighlightResult): HighlightResult {
	const stack: { char: string; depth: number }[] = [];
	let changed = false;
	const tokens = result.tokens.map(line => line.flatMap(token => {
		const color = tokenColor(token);
		if ((color !== undefined && color !== c.foreground) || !/[()[\]{}]/.test(token.content)) return [token];
		const parts: HighlightToken[] = [];
		const base = token.offset ?? 0;
		let start = 0;
		for (let i = 0; i < token.content.length; i++) {
			const ch = token.content[i]!;
			let depth: number;
			if (OPEN.includes(ch)) {
				depth = stack.length;
				stack.push({ char: ch, depth });
			} else if (ch in CLOSE && stack.at(-1)?.char === CLOSE[ch]) {
				depth = stack.pop()!.depth;
			} else continue;
			if (i > start) parts.push(withColor(token, token.content.slice(start, i), base + start, undefined));
			parts.push(withColor(token, ch, base + i, c.brackets[depth % c.brackets.length]));
			start = i + 1;
		}
		if (!parts.length) return [token];
		if (start < token.content.length) parts.push(withColor(token, token.content.slice(start), base + start, undefined));
		changed = true;
		return parts;
	}));
	return changed ? { ...result, tokens } : result;
}

/**
 * The chat's Shiki plugin: Colab theme in both slots (the plugin's themes
 * take precedence over Streamdown's `shikiTheme` prop) plus bracket colours.
 * Results are memoized so a cached highlight keeps its identity.
 */
export function createColabCodePlugin(): CodeHighlighterPlugin {
	const inner = createCodePlugin({ themes: [colabShikiTheme, colabShikiTheme] }) as unknown as CodeHighlighterPlugin;
	const colored = new WeakMap<HighlightResult, HighlightResult>();
	const colorize = (result: HighlightResult) => {
		let next = colored.get(result);
		if (!next) { next = colorizeBrackets(result); colored.set(result, next); }
		return next;
	};
	return {
		...inner,
		highlight(options, callback) {
			const result = inner.highlight(options, callback && (ready => callback(colorize(ready))));
			return result && colorize(result);
		},
	};
}
