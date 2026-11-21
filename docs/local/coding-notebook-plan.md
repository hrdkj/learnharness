# Coding questions · Notebook overlay — plan (draft for approval)

Goal: while solving a `coding_problem` (P1–M7 style "write the code" drills), open a Colab-like
Python notebook over the chat, try your code on sample data with a live kernel, then send a
cell as your answer. Local only; no upstream polish.

## Decisions already made (from the Q&A)

| Topic | Decision |
|---|---|
| Placement | Page overlay via `ctx.ui.openSurface` (like Draw), opaque. Current problem statement shown at the top as reference. |
| Execution | Persistent Jupyter kernel; cells share state; Interrupt / Restart / Restart & run all. |
| Layout | Multi-cell notebook: code + Markdown cells. |
| Owner | Built into the core **Coding questions** plugin (no host changes). |
| Lifetime | **One notebook per practice/teaching session**; each problem appends its setup cell. |
| Interpreter | New plugin setting **Notebook Python** (path); clear error if `ipykernel` is missing. |
| Seeding | Optional `notebookSetup` code string on `coding_problem`; appended once as a labelled cell, **not run**. |
| Submit | Per-cell **Use as answer** fills the active problem editor; you press the host Submit / Ctrl+Enter (check.py runs as today). |
| Tutor access | `read_notebook` tool for teacher + practice agents; the tutor pulls when it wants context. |
| Entry | Top-bar **Notebook** button + `Ctrl+Shift+N` (teaching/practice sessions) + **Open in notebook** button on the problem card. |
| Outputs | stdout/stderr, last-expression repr, formatted tracebacks, pandas HTML tables, matplotlib PNGs. |
| Keymap | Mirror Colab: `Ctrl+Enter` run, `Shift+Enter` run+next, `Alt+Enter` run+insert, `Esc` command mode (`A`/`B` insert, `D,D` delete, `J`/`K` move, `Y`/`M` code/text, `Z` undo delete), `Ctrl+M` chords, `Ctrl+/` comment, `Ctrl+Space` completion, `Ctrl+Shift+Space` docs. |
| Completion | Kernel completion pops after `.` and on `Ctrl+Space`; never AI. `help(x)` / `?x` work natively. |
| Editor QoL | Auto-close brackets/quotes, auto-indent after `:`, dedent, duplicate/move line, multi-cursor, find/replace, indent guides — in **both** the notebook and the chat problem editor (chat editor keeps Enter/Tab/Ctrl+Enter/Esc meanings). |
| Kernel shutdown | 30 min idle or app quit; survives closing the overlay and switching sessions. |
| Branch | `local/coding-notebook` off `local/study-0.6.1` in a new worktree; rebuild + install into the Study (Electron 45) app. |

## Architecture

### Backend (`plugins/coding-questions/src/`)
- **`kernel-bridge.py`** (shipped in `dist/assets/`): runs under *Notebook Python*, uses
  `jupyter_client.KernelManager`; JSON lines over stdin/stdout. Commands: `execute`, `interrupt`,
  `restart`, `complete`, `inspect`, `shutdown`. Streams iopub messages back (stream,
  execute_result, display_data, error). Avoids a native ZeroMQ npm dependency.
- **`kernels.ts`**: one bridge per session id, started lazily on first run; idle timer; killed in
  plugin cleanup.
- **`notebooks.ts`**: load/save cells + outputs + `seededProblemIds`.
- **RPC** via `ctx.handle(...)`: `notebook.load`, `notebook.save`, `cell.execute`,
  `kernel.interrupt`, `kernel.restart`, `kernel.complete`, `kernel.inspect`, `kernel.status`.
  Output streaming via `ctx.events.emit` → frontend `ctx.onNotification`.
- **`read_notebook` tool** (`registerTools`, agents: teacher, practice): returns cells in order
  with type, execution count, source, and text outputs.
- **Contract** (`contract.ts`): `coding_problem` payload gains optional `notebookSetup: string`
  (validated). Practice/teacher instructions: put a small in-memory dataset + imports in
  `notebookSetup`, never the solution; call `read_notebook` before giving a hint or after
  repeated failures.

### Frontend
- **`notebook/`** module: surface mount, cell list, toolbar (Run all, Interrupt, Restart,
  Restart & run all, + Code, + Text, kernel status), command/edit modes, output renderers.
- Markdown cells render with `ctx.ui.mountMarkdown` when not being edited.
- HTML outputs (DataFrame tables) render inside a sandboxed iframe (`sandbox=""`, no scripts);
  PNGs as `<img>`.
- **Use as answer**: an in-plugin registry of mounted *active* problem editors; the button
  replaces that editor's draft via its `onChange`, closes the overlay, and focuses the editor.
- **Seeding**: on opening, if the active problem has `notebookSetup` and its `problemId` isn't in
  `seededProblemIds`, append `# <problem title> · setup` + code as a new cell at the end.
- **Shared editor extensions** (`editor-extensions.ts`) used by both editors.

## Choices I filled in — please confirm or change

1. **File format/location:** save each notebook as real **`.ipynb`** (nbformat 4) at
   `<learning data>/core-plugin-data/coding-questions/notebooks/<sessionId>.ipynb`, so you could
   also open it in Jupyter/Colab.
2. **`read_notebook` size cap:** last 40 cells; each output truncated to 2 KB of `text/plain`;
   images reported as `[image]`; HTML tables sent as their `text/plain` repr.
3. **Seed cell position:** appended at the end of the notebook (not the top).
4. **Use as answer:** replaces the whole editor draft (no merge), no confirm dialog.
5. **Notebook Python default:** empty; I set yours to `/home/hrdk/avidya/.venv/bin/python` once
   built.
6. **New npm dependencies** (bundled by esbuild): `@codemirror/autocomplete`,
   `@codemirror/search`, `@codemirror/lang-python` (direct), and
   `@replit/codemirror-indentation-markers` for indent guides.
7. **Execution timeout:** none by default (like Colab); Interrupt is the escape hatch.

## Build order (OPPE is Sun 22 Nov)

1. Worktree + branch; verify `PluginToolContext.chatId` equals the session id used by actions
   (needed so `read_notebook` finds the right notebook).
2. Kernel bridge + backend RPC + persistence + setting; Node tests against the real avidya venv.
3. Notebook overlay: cells, run keys, outputs, kernel controls, Use as answer.
4. Editor QoL + Colab keymap + kernel completion/docs in both editors.
5. `notebookSetup` contract + seeding + `read_notebook` tool + instruction text.
6. Browser test (existing `tests/browser.mjs` pattern), build, install into the Study app,
   run P1 end to end.

Steps 2–4 make it usable for self-typed experiments; step 5 adds tutor seeding/reading.
