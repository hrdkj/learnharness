import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fromIpynb, notebookAsText, parseNotebook, toIpynb, type Notebook } from "../src/notebook-model.ts";
import { NotebookStore, pythonPathError } from "../src/notebook-store.ts";
import { Kernels, type BridgeEvent } from "../src/kernels.ts";

const sample: Notebook = {
  seeded: ["problem-1"],
  cells: [
    { id: "a1", type: "markdown", source: "# Notes\nmask then sum", outputs: [], executionCount: null },
    { id: "b2", type: "code", source: "s.isin([1])", executionCount: 3, outputs: [
      { output_type: "stream", name: "stdout", text: "hi\n" },
      { output_type: "execute_result", execution_count: 3, metadata: {}, data: { "text/plain": "0    True\ndtype: bool", "text/html": "<table></table>" } },
      { output_type: "display_data", metadata: {}, data: { "image/png": "iVBORw0KGgo=", "text/plain": "<Figure>" } },
      { output_type: "error", ename: "NameError", evalue: "name 'x' is not defined", traceback: ["\u001b[31mNameError\u001b[39m: name 'x' is not defined"] },
    ] },
  ],
};

test("notebooks round-trip through nbformat 4 and keep seeded problem ids", () => {
  const ipynb = toIpynb(sample) as { nbformat: number; cells: { cell_type: string; outputs?: unknown }[] };
  assert.equal(ipynb.nbformat, 4);
  assert.equal(ipynb.cells[0]!.cell_type, "markdown");
  assert.equal("outputs" in ipynb.cells[0]!, false);
  assert.deepEqual(fromIpynb(JSON.parse(JSON.stringify(ipynb))), sample);
});

test("parseNotebook rejects duplicate or unsafe ids and unknown cell types", () => {
  assert.throws(() => parseNotebook({ cells: [{ id: "x", type: "code", source: "" }, { id: "x", type: "code", source: "" }] }), /unique/);
  assert.throws(() => parseNotebook({ cells: [{ id: "../x", type: "code", source: "" }] }), /unique identifiers/);
  assert.throws(() => parseNotebook({ cells: [{ id: "x", type: "raw", source: "" }] }), /code or markdown/);
  assert.deepEqual(parseNotebook({ cells: [{ id: "x", type: "markdown", source: "t", outputs: [{ output_type: "stream", name: "stdout", text: "drop" }] }] }).cells[0]!.outputs, []);
});

test("Jupyter files with list sources and missing ids still load", () => {
  const loaded = fromIpynb({ cells: [{ cell_type: "code", source: ["a = 1\n", "a"], outputs: [{ output_type: "stream", name: "stdout", text: ["x", "y"] }], execution_count: 1 }] });
  assert.equal(loaded.cells[0]!.source, "a = 1\na");
  assert.equal(loaded.cells[0]!.id, "cell-0");
  assert.deepEqual(loaded.cells[0]!.outputs, [{ output_type: "stream", name: "stdout", text: "xy" }]);
});

test("the tutor's text view shows sources, plain outputs, images and errors without ANSI", () => {
  const text = notebookAsText(sample);
  assert.match(text, /Cell 1 \(markdown\)/);
  assert.match(text, /Cell 2 \(code, In \[3\]\) ---\ns\.isin\(\[1\]\)/);
  assert.match(text, /\[stdout\]\nhi/);
  assert.match(text, /\[result\] 0    True/);
  assert.match(text, /\[display\] \[image\] <Figure>/);
  assert.match(text, /\[error\] NameError: name 'x' is not defined\nNameError: name/);
  assert.doesNotMatch(text, /\u001b|<table>/);
  assert.equal(notebookAsText({ cells: [], seeded: [] }), "The learner's notebook is empty.");
});

test("the tutor's text view keeps the last 40 cells and caps each output", () => {
  const cells = Array.from({ length: 45 }, (_, index) => ({ id: `c${index}`, type: "code" as const, source: `x${index}`, executionCount: null, outputs: [{ output_type: "stream" as const, name: "stdout", text: "y".repeat(3000) }] }));
  const text = notebookAsText({ cells, seeded: [] });
  assert.match(text, /^\[5 earlier cells omitted\]/);
  assert.doesNotMatch(text, /\nx4\n/);
  assert.match(text, /Cell 45/);
  assert.match(text, /more characters\]/);
});

test("the store writes one ipynb per session and never escapes its folder", async t => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "coding-notebook-store-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const store = new NotebookStore(dataDirectory);
  assert.deepEqual(store.load("session-1"), { cells: [], seeded: [] });
  store.save("session-1", sample);
  assert.ok(fs.existsSync(path.join(dataDirectory, "notebooks", "session-1.ipynb")));
  assert.deepEqual(store.load("session-1"), sample);
  assert.throws(() => store.file("../escape"), /Invalid session id/);
});

test("Notebook Python accepts PATH commands and existing absolute files only", () => {
  assert.equal(pythonPathError(""), null);
  assert.equal(pythonPathError("python3"), null);
  assert.equal(pythonPathError(process.execPath), null);
  assert.match(pythonPathError("/no/such/python")!, /not found/);
  assert.match(pythonPathError(" python3")!, /spaces/);
  assert.match(pythonPathError("python3; rm")!, /absolute path/);
});

const python = process.env.NOTEBOOK_PYTHON ?? "/home/hrdk/avidya/.venv/bin/python";
const bridgePath = fileURLToPath(new URL("../src/kernel-bridge.py", import.meta.url));

test("a real kernel keeps state across runs, streams outputs, completes and restarts", { skip: fs.existsSync(python) ? false : `set NOTEBOOK_PYTHON (missing ${python})`, timeout: 120_000 }, async t => {
  const events: BridgeEvent[] = [];
  let waiters: (() => void)[] = [];
  const kernels = new Kernels({
    python: () => python, bridgePath, idleMs: 60_000,
    emit: (sessionId, event) => { assert.equal(sessionId, "s1"); if (event.type !== "stderr") events.push(event); for (const wake of waiters) wake(); waiters = []; },
  });
  t.after(() => kernels.dispose());
  const doneFor = async (id: number) => {
    for (;;) {
      const done = events.find(event => event.type === "done" && event.id === id);
      if (done) return done;
      await new Promise<void>(resolve => waiters.push(resolve));
    }
  };
  const outputsFor = (id: number) => events.filter(event => event.type === "output" && event.id === id).map(event => (event as { output: { output_type: string; data?: Record<string, unknown>; text?: string } }).output);
  const kernel = kernels.get("s1");

  const first = kernel.execute("import pandas as pd\nframe = pd.DataFrame({'H': [6, 9, 7]})\nprint('rows', len(frame))\nframe['H'].isin([6, 7, 8])");
  assert.deepEqual(await doneFor(first), { type: "done", id: first, status: "ok", executionCount: 1 });
  const outputs = outputsFor(first);
  assert.equal(outputs[0]!.text, "rows 3\n");
  assert.match(String(outputs[1]!.data!["text/plain"]), /True\n1\s+False\n2\s+True/);

  const second = kernel.execute("frame['H'].isin([6, 7, 8]).sum()");
  await doneFor(second);
  assert.equal(outputsFor(second)[0]!.data!["text/plain"], "np.int64(2)");

  const completion = await kernel.request("complete", "frame['H'].isi", 14);
  assert.ok((completion.matches as string[]).includes("isin"));
  const docs = await kernel.request("inspect", "frame.head", 10);
  assert.equal(docs.found, true);

  const table = kernel.execute("frame");
  await doneFor(table);
  assert.match(String(outputsFor(table)[0]!.data!["text/html"]), /<table/);

  const failing = kernel.execute("undefined_name");
  assert.equal((await doneFor(failing) as { status: string }).status, "error");

  kernel.restart();
  const after = kernel.execute("'frame' in dir()");
  const done = await doneFor(after);
  assert.equal((done as { executionCount: number }).executionCount, 1);
  assert.equal(outputsFor(after)[0]!.data!["text/plain"], "False");
});

test("a missing Notebook Python fails with a settings hint instead of spawning", () => {
  const kernels = new Kernels({ python: () => "", bridgePath, idleMs: 1000, emit() {} });
  assert.throws(() => kernels.get("s1").execute("1"), /Set Notebook Python in Settings/);
});
