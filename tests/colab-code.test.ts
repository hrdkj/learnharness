import assert from "node:assert/strict";
import { it } from "node:test";
import { COLAB_CODE, colorizeBrackets, createColabCodePlugin } from "../components/colab-code.ts";

const SOURCE = [
  "import pandas as pd",
  "def split_impute(frame, test_size, seed):",
  "    X = frame.drop(columns=\"target (x)\")  # features (new frame)",
  "    fill = {\"age\": X[\"age\"].median(), \"n\": [0]}",
  "    return X.fillna(fill), print(len(fill))",
].join("\n");

type Result = NonNullable<ReturnType<ReturnType<typeof createColabCodePlugin>["highlight"]>>;

function highlight(code: string): Promise<Result> {
  const plugin = createColabCodePlugin();
  return new Promise(resolve => {
    const ready = plugin.highlight({ code, language: "python" as never, themes: plugin.getThemes() }, resolve);
    if (ready) resolve(ready);
  });
}

/** Colour of every occurrence of `text` as a whole token, in order. */
function colours(result: Result, text: string): string[] {
  return result.tokens.flat().filter(token => token.content.trim() === text).map(token => (token.htmlStyle?.color ?? token.color ?? "").toLowerCase());
}

it("chat code uses the Colab palette in both theme slots", async () => {
  const plugin = createColabCodePlugin();
  const [light, dark] = plugin.getThemes();
  assert.equal(light, dark);
  const result = await highlight(SOURCE);
  assert.ok(result.bg?.toLowerCase().startsWith(COLAB_CODE.background));
  assert.deepEqual(colours(result, "import"), [COLAB_CODE.control]);
  assert.deepEqual(colours(result, "as"), [COLAB_CODE.control]);
  assert.deepEqual(colours(result, "return"), [COLAB_CODE.control]);
  assert.deepEqual(colours(result, "def"), [COLAB_CODE.keyword]);
  assert.deepEqual(colours(result, "split_impute"), [COLAB_CODE.function]);
  assert.deepEqual(colours(result, "seed"), [COLAB_CODE.parameter]);
  assert.deepEqual(colours(result, "columns="), [COLAB_CODE.foreground], "keyword arguments stay plain");
  assert.deepEqual(colours(result, "0"), [COLAB_CODE.number]);
  assert.ok(colours(result, "features (new frame)").every(colour => colour === COLAB_CODE.comment));
});

it("brackets are coloured by depth, skipping strings and comments", async () => {
  const result = await highlight(SOURCE);
  const [gold, orchid, blue] = COLAB_CODE.brackets;
  const line = (index: number) => result.tokens[index]!.filter(token => /^[()[\]{}]$/.test(token.content)).map(token => [token.content, (token.htmlStyle?.color ?? token.color)?.toLowerCase()]);
  assert.deepEqual(line(1), [["(", gold], [")", gold]]);
  // "(x)" inside the string and "(new frame)" in the comment are not brackets.
  assert.deepEqual(line(2), [["(", gold], [")", gold]]);
  assert.deepEqual(line(3), [["{", gold], ["[", orchid], ["]", orchid], ["(", orchid], [")", orchid], ["[", orchid], ["]", orchid], ["}", gold]]);
  assert.deepEqual(line(4), [["(", gold], [")", gold], ["(", gold], ["(", orchid], [")", orchid], [")", gold]]);
  void blue;
});

it("third-level brackets turn blue, then the cycle repeats; stray closers stay plain", () => {
  const fg = COLAB_CODE.foreground;
  const result = colorizeBrackets({ tokens: [[{ content: "f(a[b{c(d)}]))", color: fg, offset: 0 }]] });
  const coloured = result.tokens[0]!.filter(token => /^[()[\]{}]$/.test(token.content)).map(token => token.color);
  const [gold, orchid, blue] = COLAB_CODE.brackets;
  assert.deepEqual(coloured, [gold, orchid, blue, gold, gold, blue, orchid, gold, fg]);
  assert.equal(result.tokens[0]!.map(token => token.content).join(""), "f(a[b{c(d)}]))");
  assert.deepEqual(result.tokens[0]!.map(token => token.offset), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});
