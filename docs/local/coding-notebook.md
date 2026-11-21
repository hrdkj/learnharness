# Coding notebook and exam questions: local dev guide

This guide covers the local `local/coding-notebook` branch, which builds on `local/study-0.6.1`. It's
installed in the **LearnHarness Study (Electron 45)** app. It isn't upstreamed. The
original design Q&A is in [coding-notebook-plan.md](coding-notebook-plan.md). This file
describes what was actually built.

## What it does

- **Docked notebook.** A Colab-like Python notebook with a persistent Jupyter kernel, one per session.
  It docks on the right of a teaching or practice session while the chat keeps working on the left.
  It opens automatically when a Python coding or exam question mounts, appends that question's
  `notebookSetup` cell and runs it.
- **Coding questions** (`coding_question` / `coding_problem`). Code is graded by the tutor's test
  recipe.
- **Exam questions** (`exam_question` / `exam_problem`), in OPPE/SEEK style. The learner types a
  number, picks an option or types a name, and only the value is graded, within a tolerance. The
  correct value is either `payload.answer` (a stored key) or `payload.reference` (Python that assigns
  `answer`, run after `notebookSetup` in a fresh Notebook Python process on the first submit and
  cached). The learner types the value into the answer box; cells have only a Delete button.
- **Tutor tools.** `read_notebook` returns the learner's cells and outputs. `compute_answer` runs
  setup plus reference so the tutor can check a generated question before posing it.

The learner-facing guide lives in the vault, at `~/avidya/courses/mlp/oppe-1/exam-practice.md`.

## Map

| Piece | Where |
|---|---|
| Side-docked surfaces (`placement: "side"`) | `src/core/plugin-ui.ts`, `components/plugin-surface-shell.tsx`, `components/plugin-ui-host.tsx` |
| Dock keeps its own keys (Enter/Escape, Mod+Enter) | `plugin-surface-shell.tsx` (stopPropagation), `components/plugin-question-keys.ts` (capture skip) |
| Teaching Submit hook for the notebook | `data-testid="plugin-question-send"` in `components/plugin-question-dock.tsx` (practice uses `practice-send`) |
| Notebook UI, seeding | `plugins/coding-questions/src/notebook/{entry,view,controller,outputs,cell-editor}.ts` |
| Kernel bridge (jupyter_client over JSON lines) | `plugins/coding-questions/src/kernel-bridge.py`, `kernels.ts` |
| Answer targets (editor ⇄ notebook) | `plugins/coding-questions/src/answer-targets.ts` (`accepts: "value"` for exam questions) |
| Exam question contract, parsing, tolerance, reference runner | `plugins/coding-questions/src/value.ts` |
| Exam answer box and result badge | `plugins/coding-questions/src/value-view.ts` |
| Backend: grading, answer cache, tools, instructions | `plugins/coding-questions/src/backend.ts` |
| Colab-dark code theme | `plugins/coding-questions/src/colab-theme.ts`, `components/colab-code.ts` |

Plugin data lives in `<profile>/data/core-plugin-data/coding-questions/`. That's `settings.json` (Notebook
Python), `notebooks/<session>.ipynb` and `exam-answers/<id>.json`.

## Workflow

```bash
cd ~/gen/learnharness-notebook
npx tsc --noEmit -p .                                   # whole repo
(cd plugins/coding-questions && npx tsx --test --test-concurrency=1 tests/*.test.ts)
NODE_ENV=test LH_DATA_DIR=$(mktemp -d) npx tsx --test tests/*.test.ts tests/*.test.tsx
npm run build && node scripts/build-server.mjs          # standalone server
scripts/local/test-server.sh                            # :3917 on a COPY of Study data
scripts/local/install-study.sh                          # quit the app first
```

- After changing a public plugin API type (`src/core/plugin-*.ts`), regenerate the plugin SDK
  (`cd plugins/coding-questions && npm run sdk`) and the committed reference:
  `T=$(mktemp -d); node scripts/build-plugin-types.mjs $T/sdk && node scripts/build-plugin-api-reference.mjs $T/sdk docs/plugin-api`.
- `next build` rewrites `next-env.d.ts`. Restore it with `git checkout next-env.d.ts`. The install script does this for you.
- `next build` can stop once on a security-advisory notice. Rerunning continues, and both scripts retry.
- For end-to-end checks, use the test server and the built-in browser. Ask the tutor for a tiny
  question in a test-copy session, then check that the notebook docks, the setup cell runs, Ctrl+Enter
  runs only the cell, and Submit works.

## Known issues and backlog

- In **teaching** sessions, the question sits collapsed ("Check your understanding"), so the notebook
  only opens when you open the question. Practice opens it immediately.
- Exam answers are cached by question id on the first submit. If a reference is wrong, that wrong answer
  sticks until `exam-answers/<id>.json` is deleted.
- For exam questions, a cell's value is its last `execute_result` or last stdout line. A DataFrame or
  Series result is submitted as its text repr, which is rarely what you want.
- The tutor can see `payload.answer` and `reference` before you answer. That's fine for practice, but
  it isn't a sealed exam.
- Existing test failures: `tests/code-ligatures.test.tsx` already fails on `local/study-0.6.1`. In the
  plugin, the runner's 30 s timeout tests flake when the suite runs in parallel, so use `--test-concurrency=1`.
- Next.js 16.4.3 is flagged by its own security-advisory check. Upgrading is separate work.
- Possible upstream pieces: `placement: "side"` for surfaces, and the exam question type. Both need
  upstream review. The question-dock key exemption is a narrow host seam.
- Ideas: a timed mock mode (a set of questions with a countdown and no hints until the end); a
  per-session dataset panel listing the CSVs; showing which answer source (key or reference) the
  tutor used, for the post-mortem.
