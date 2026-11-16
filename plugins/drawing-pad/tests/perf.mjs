// DEVICE ONLY — do not upstream as-is. Drawing Pad smoothness harness
// (docs/drawing-pad-perf-plan.md, phase 0.3). Builds the same host fixture as
// tests/browser.mjs, opens a question sheet in headful Chromium with the GPU
// enabled, replays the deterministic handwriting workload as real
// PointerEvents and times each synchronous dispatch.
//
//   CHROME_PATH=/usr/bin/chromium npm run test:perf [-- --assert] [-- --no-gpu] [-- --strokes=N] [-- --seed=N] [-- --json=FILE]
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import { handwriting } from "./perf-workload.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), repo = path.resolve(root, "../..");
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "lh-drawing-pad-perf-"));
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const flag = name => process.argv.includes(`--${name}`);
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const strokes = Number(option("strokes", 300)), seed = Number(option("seed", 1));
// Section 6 targets (D4).
const BUDGET = { downP95: 2, penMoveP95: 1, upP95: 4, eraserMissMoveP95: 2, fullRepaintP95: 50, repaintsPerStroke: 0, hostRefreshPerStroke: 0, hostRefreshPerPanMove: 0, upGrowth: 1.5 };

function stats(values) {
  if (!values.length) return { n: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b), at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = value => Math.round(value * 1000) / 1000;
  return { n: values.length, p50: round(at(.5)), p95: round(at(.95)), max: round(sorted.at(-1)) };
}
function acPower() {
  try {
    for (const name of fs.readdirSync("/sys/class/power_supply")) {
      const base = path.join("/sys/class/power_supply", name);
      if (fs.readFileSync(path.join(base, "type"), "utf8").trim() === "Mains") return fs.readFileSync(path.join(base, "online"), "utf8").trim() === "1";
    }
  } catch { /* not Linux */ }
  return undefined;
}

let browser, server;
try {
  await build({ absWorkingDir: root, entryPoints: ["tests/browser-fixture.mjs"], outfile: path.join(evidence, "fixture.js"), bundle: true,
    format: "esm", platform: "browser", target: "es2022", jsx: "automatic", alias: { "@": repo },
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning",
    banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "production" } };' },
    plugins: [{ name: "discard-unused-node-only-barrel-import", setup(builder) {
      builder.onResolve({ filter: /^\.\/plugins$/ }, args => args.importer === path.join(repo, "components/plugin-shortcuts.tsx")
        ? { path: path.join(root, "tests/keyboard-context.mjs") } : undefined);
      builder.onResolve({ filter: /^node:crypto$/ }, args => ({ path: args.path, external: true, sideEffects: false }));
    } }] });
  const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/plugin.css"><link rel="stylesheet" href="/katex/katex.min.css"><style>
    html.dark{color-scheme:dark}*{box-sizing:border-box} body{margin:0;background:var(--background);color:var(--foreground);font-family:monospace} #bar{height:48px;display:flex;gap:12px;padding:8px 240px;background:var(--card)} button{font:inherit;font-size:12px;padding:6px 10px;background:var(--card);color:var(--foreground);border:1px solid var(--border);border-radius:6px} button[data-variant=secondary]{background:var(--border)}button:disabled{opacity:.4}button svg{display:block;width:16px;height:16px}
    #sidebar{position:fixed;left:0;top:48px;width:220px;bottom:0;background:var(--card)}#pad{position:fixed;left:220px;top:48px;right:0;bottom:0;background:var(--background)}#close-pad{position:absolute;right:12px;top:10px;z-index:10}#settings{display:none}.lh-prose{font-family:serif;font-size:16px;line-height:1.5}.lh-prose p{margin:0 0 8px}
    </style></head><body><div id="bar"><button id="draw">Loading</button><button id="settings-open">Settings</button></div><aside id="sidebar">Fixture sidebar</aside><div id="settings" hidden><input id="dark-ink"><input id="light-ink"><input id="image-scale" type="number"><p id="setting-error"></p><button id="blur-target">Done</button></div><script type="module" src="/fixture.js"></script></body></html>`;
  server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    let file, type;
    if (url.pathname === "/") { response.setHeader("content-type", "text/html"); response.end(html); return; }
    if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    if (url.pathname === "/fixture.js") { file = path.join(evidence, "fixture.js"); type = "text/javascript"; }
    else if (url.pathname === "/plugin.css") { file = path.join(root, "src/styles.css"); type = "text/css"; }
    else if (url.pathname.startsWith("/katex/")) {
      file = path.resolve(repo, "node_modules/katex/dist", decodeURIComponent(url.pathname.slice(7)));
      if (!file.startsWith(path.join(repo, "node_modules/katex/dist") + path.sep)) { response.writeHead(403).end(); return; }
      type = file.endsWith(".css") ? "text/css" : "font/woff2";
    }
    if (!file || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
    response.setHeader("content-type", type); response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const gpu = !flag("no-gpu");
  // Headful so Chromium uses the real GPU instead of headless software fallbacks.
  browser = await puppeteer.launch({ executablePath: chrome, headless: false, userDataDir: path.join(evidence, "profile"), defaultViewport: null, protocolTimeout: 30 * 60_000,
    args: ["--no-sandbox", "--window-size=1600,1000", "--no-first-run", "--no-default-browser-check", ...(gpu ? [] : ["--disable-gpu"])] });
  const info = await (await browser.target().createCDPSession()).send("SystemInfo.getInfo");
  const canvasStatus = info.gpu.featureStatus?.["2d_canvas"] ?? "could not be determined";
  const renderer = info.gpu.auxAttributes?.glRenderer ?? info.gpu.devices?.map(device => device.deviceString).join(", ") ?? "unknown";
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1536, height: 864, deviceScaleFactor: 1.25 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack ?? String(error)));
  page.on("console", message => { if (message.type() === "error") errors.push(`${message.text()} ${message.location()?.url ?? ""}`); });
  await page.goto(origin, { waitUntil: "networkidle0" });
  // Poll on a timer: rAF stops while the window is hidden.
  await page.waitForFunction(() => window.fixtureReady, { polling: 100 });
  const question = { type: "answer", available: true, revealed: true, expanded: true,
    question: { id: "q", kind: "quiz", question: "Find $x^2$ when $x=3$.", context: "A **read-only** reference.", mode: "single-select",
      options: [{ value: "b", label: "$9$" }, { value: "a", label: "$6$" }], occurrence: { messageId: "mq", contentIndex: 0, toolCallId: "q", toolName: "quiz" } },
    draft: { text: "", values: [] } };
  // Opening Draw: a first open, then a second open on a different question
  // (fresh capture, fonts already used once in this window), then the
  // workload's own sheet. Main-thread blocking = long animation frames.
  await page.evaluate(() => {
    window.__perfLoaf = [];
    new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__perfLoaf.push({ duration: entry.duration, blocking: entry.blockingDuration }); })
      .observe({ type: "long-animation-frame" });
  });
  const openDraw = async (session, input) => {
    await page.evaluate((session, input) => { window.fixture.navigate(session, "teaching", input); window.__perfLoaf.length = 0; window.__drawingPadPerf.reset(); window.__perfOpenStart = performance.now(); }, session, input);
    await page.click("#draw");
    await page.waitForFunction(() => {
      const paper = document.querySelector(".drawing-pad-paper"), status = document.querySelector(".drawing-pad-status");
      if (status?.getAttribute("role") === "alert") throw new Error(status.textContent);
      return paper && !paper.hidden && status.hidden;
    }, { timeout: 30000, polling: 100 });
    // Long-animation-frame entries arrive after their frame ends.
    await new Promise(resolve => setTimeout(resolve, 300));
    return page.evaluate(() => {
      const loaf = window.__perfLoaf.splice(0), round = value => Math.round(value * 10) / 10;
      return { wall: round(performance.now() - window.__perfOpenStart), longFrames: loaf.length, longFrameTotal: round(loaf.reduce((sum, e) => sum + e.duration, 0)),
        longFrameMax: round(Math.max(0, ...loaf.map(e => e.duration))), blockingTotal: round(loaf.reduce((sum, e) => sum + e.blocking, 0)), plugin: window.__drawingPadPerf.summary() };
    });
  };
  const second = { ...question, question: { ...question.question, id: "q2", question: "Compute $\\int_0^1 x\\,dx$ and $\\sqrt{2}$.", occurrence: { ...question.question.occurrence, toolCallId: "q2" } } };
  const opens = { first: await openDraw("open-first", question), second: await openDraw("open-second", second) };
  for (const [name, open] of Object.entries(opens)) {
    const fonts = open.plugin["capture.fonts"], png = open.plugin["capture.png"], svg = open.plugin["capture.svg"];
    console.log(`open Draw (${name}): ${open.wall} ms to ready; long frames ${open.longFrames}, total ${open.longFrameTotal} ms, max ${open.longFrameMax} ms, blocking ${open.blockingTotal} ms; capture.fonts total ${fonts?.total}, capture.svg ${svg?.total}, capture.png ${png?.total}`);
  }
  if (flag("opens-only")) { console.log(JSON.stringify({ opens })); process.exit(0); }
  const openSummary = (await openDraw("perf", question)).plugin;
  const size = await page.evaluate(() => { const r = document.querySelector(".drawing-pad-ink").getBoundingClientRect(); return { width: r.width, height: r.height }; });
  const ops = handwriting({ ...size, seed, strokes });
  await page.evaluate(() => window.__drawingPadPerf.reset());

  // Everything below runs inside the page so no CDP round trip sits between events.
  const raw = await page.evaluate(async ops => {
    const canvas = document.querySelector(".drawing-pad-ink"), perf = window.__drawingPadPerf;
    // Isolate the run from the real mouse (pointerId 1) moving over this headful
    // window: synthetic gestures use their own id, the canvas takes no real
    // hits, and capture of the synthetic id is tracked here because the browser
    // only captures active (real) pointers.
    const SYNTHETIC = 7, held = new Set();
    canvas.style.pointerEvents = "none";
    canvas.setPointerCapture = id => { if (id !== SYNTHETIC) return Element.prototype.setPointerCapture.call(canvas, id); held.add(id); };
    canvas.releasePointerCapture = id => { if (id !== SYNTHETIC) return Element.prototype.releasePointerCapture.call(canvas, id); held.delete(id); };
    canvas.hasPointerCapture = id => id === SYNTHETIC ? held.has(id) : Element.prototype.hasPointerCapture.call(canvas, id);
    let trusted = 0;
    for (const type of ["pointerdown", "pointermove", "pointerup"]) window.addEventListener(type, event => { if (event.isTrusted) trusted++; }, true);
    const tool = label => [...document.querySelectorAll(".drawing-pad-tools button")].find(button => button.getAttribute("aria-label") === label);
    // Yield to rendering like real input does; fall back to a timer if rAF is throttled.
    // A hidden or occluded window gets no frames (Wayland sends no frame
    // callbacks), so every window records how many frames really ran: repaint
    // work is per frame now, and numbers without frames are not valid.
    let rendered = 0, waits = 0, hiddenAt;
    const tick = () => { rendered++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    const frame = () => new Promise(resolve => { waits++; let done = false; const go = () => { if (!done) { done = true; resolve(); } }; requestAnimationFrame(go); setTimeout(go, 50); });
    const windows = [], snapshot = () => perf.summary();
    let current, strokeCount = 0;
    const open = label => { perf.reset(); current = { label, samples: {}, strokes: [], rendered, waits, hidden: document.visibilityState !== "visible" }; };
    document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "visible" && current) current.hidden = true; });
    const add = (name, value) => (current.samples[name] ??= []).push(value);
    const close = () => { current.summary = snapshot(); current.rendered = rendered - current.rendered; current.waits = waits - current.waits; if (Object.keys(current.samples).length) windows.push(current); };
    const fire = (type, point, init, name) => {
      const rect = canvas.getBoundingClientRect();
      const event = new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, isPrimary: true, pointerId: SYNTHETIC, ...init,
        clientX: rect.left + point.x, clientY: rect.top + point.y });
      const start = performance.now(); canvas.dispatchEvent(event); const elapsed = performance.now() - start;
      if (name) add(name, elapsed);
    };
    const pen = { pointerType: "pen", width: 1, height: 1 };
    const gesture = async (points, names) => {
      fire("pointerdown", points[0], { ...pen, pressure: points[0].pressure, button: 0, buttons: 1 }, names.down);
      for (let i = 1; i < points.length; i++) {
        fire("pointermove", points[i], { ...pen, pressure: points[i].pressure, button: -1, buttons: 1 }, names.move);
        if (i % 3 === 0) await frame();
      }
      fire("pointerup", points.at(-1), { ...pen, pressure: 0, button: 0, buttons: 0 }, names.up);
      await frame();
    };
    const click = (label, name) => { const button = tool(label), start = performance.now(); button.click(); add(name, performance.now() - start); };
    const counters = () => { const s = perf.summary(); return { repaints: s.fullRepaint?.n ?? 0, refresh: s.hostPublish?.total ?? 0 }; };
    open("strokes 1–100");
    for (const op of ops) {
      if (op.type === "checkpoint") { current.atStrokes = op.strokes; close(); open(`strokes ${op.strokes + 1}–${op.strokes + 100}`); continue; }
      if (op.type === "pen") {
        const before = counters();
        await gesture(op.points, { down: "down", move: "penMove", up: "up" });
        const after = counters(); strokeCount++;
        current.strokes.push({ stroke: op.stroke, repaints: after.repaints - before.repaints, refresh: after.refresh - before.refresh });
      } else if (op.type === "eraser" || op.type === "sweep") {
        const kind = op.type === "sweep" ? "sweep" : op.hit ? "eraserHit" : "eraserMiss";
        click("Eraser", "toolClick");
        await gesture(op.points, { down: `${kind}Down`, move: `${kind}Move`, up: `${kind}Up` });
        click("Pen", "toolClick");
      } else if (op.type === "pan") {
        if (current.label.startsWith("strokes") && op.phase === "final") { close(); open("final: undo ×10, pan ×10, sweep"); }
        click("Hand", "toolClick");
        const centre = { x: canvas.getBoundingClientRect().width / 2, y: canvas.getBoundingClientRect().height / 2 };
        const mouse = { pointerType: "mouse", pressure: .5 };
        const before = counters();
        fire("pointerdown", centre, { ...mouse, button: 0, buttons: 1 }, op.phase === "final" ? "panDown" : undefined);
        for (let i = 1; i <= op.moves; i++) {
          fire("pointermove", { x: centre.x + op.dx * i / op.moves, y: centre.y + op.dy * i / op.moves }, { ...mouse, button: -1, buttons: 1 }, op.phase === "final" ? "panMove" : "blockPanMove");
          if (i % 2 === 0) await frame();
        }
        fire("pointerup", { x: centre.x + op.dx, y: centre.y + op.dy }, { ...mouse, pressure: 0, button: 0, buttons: 0 }, op.phase === "final" ? "panUp" : undefined);
        const after = counters();
        add(op.phase === "final" ? "panRefresh" : "blockPanRefresh", (after.refresh - before.refresh) / op.moves);
        await frame();
        click("Pen", "toolClick");
      } else if (op.type === "undo") {
        if (current.label.startsWith("strokes")) { close(); open("final: undo ×10, pan ×10, sweep"); }
        click("Undo", "undoClick"); await frame();
      }
    }
    close();
    return { windows, strokeCount, trusted };
  }, ops);

  const finalWindow = raw.windows.find(w => w.label.startsWith("final"));
  const report = { config: { gpu, canvas: canvasStatus, renderer, chromium: await browser.version(), viewport: "1536×864 @ DPR 1.25", acPower: acPower(), seed, strokes, ops: ops.length },
    open: openSummary, opens, windows: raw.windows.map(w => {
      const per = name => w.strokes.map(s => s[name]);
      const s = Object.fromEntries(Object.entries(w.samples).map(([name, values]) => [name, stats(values)]));
      return { label: w.label, atStrokes: w.atStrokes, frames: { rendered: w.rendered, waits: w.waits, hidden: w.hidden }, dispatch: s,
        repaintsPerStroke: w.strokes.length ? stats(per("repaints")) : undefined,
        hostRefreshPerStroke: w.strokes.length ? stats(w.strokes.filter(x => x.stroke > 1).map(x => x.refresh)) : undefined,
        plugin: w.summary };
    }), realPointerEvents: raw.trusted, errors };
  const checkpoints = report.windows.filter(w => w.atStrokes);
  const first = checkpoints[0], last = checkpoints.at(-1), fin = report.windows.find(w => w.label.startsWith("final"));
  const row = w => [w.label, w.dispatch.down?.p95, w.dispatch.penMove?.p95, w.dispatch.up?.p95, w.dispatch.eraserMissMove?.p95, w.dispatch.eraserHitMove?.p95,
    w.plugin.paintInk?.p50, w.plugin.paintInk?.p95, w.plugin["paintInk.visible"]?.p95, w.repaintsPerStroke?.p50, w.repaintsPerStroke?.max, w.hostRefreshPerStroke?.p50, w.hostRefreshPerStroke?.max];
  console.log(JSON.stringify(report));
  console.log(`\nDrawing Pad perf — GPU ${gpu ? "on" : "off"}, 2d_canvas: ${canvasStatus}, renderer: ${renderer}, AC: ${report.config.acPower}`);
  console.log("window | down p95 | pen move p95 | up p95 | eraser miss move p95 | eraser hit move p95 | paintInk p50 | paintInk p95 | paintInk.visible p95 | repaints/stroke p50 | max | host refresh/stroke p50 | max");
  for (const w of checkpoints) console.log(row(w).join(" | "));
  if (fin) {
    const d = fin.dispatch;
    console.log(`final | undo click p50/p95/max ${d.undoClick?.p50}/${d.undoClick?.p95}/${d.undoClick?.max} | pan move p50/p95/max ${d.panMove?.p50}/${d.panMove?.p95}/${d.panMove?.max} | host refresh/pan move max ${d.panRefresh?.max} | sweep move p50/p95/max ${d.sweepMove?.p50}/${d.sweepMove?.p95}/${d.sweepMove?.max} | sweep up ${d.sweepUp?.max}`);
    console.log(`final plugin: ${JSON.stringify(fin.plugin)}`);
  }
  for (const w of report.windows) console.log(`${w.label}: ${w.frames.rendered} frames rendered during ${w.frames.waits} frame waits${w.frames.hidden ? ", page was hidden at some point" : ""}`);
  const starved = report.windows.filter(w => w.frames.hidden || w.frames.rendered < w.frames.waits / 2);
  if (starved.length) console.log(`WARNING: frames were not rendering in ${starved.map(w => w.label).join(", ")} (window hidden or occluded?). Per-frame repaint work is missing: rerun with the window visible.`);
  console.log(`growth up p95 ${last.label} ÷ ${first.label}: ${first.dispatch.up?.p95 ? (last.dispatch.up.p95 / first.dispatch.up.p95).toFixed(2) : "n/a"}`);
  const out = option("json"); if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(evidence, "perf.json"), JSON.stringify(report, null, 1));
  console.log(`real (trusted) pointer events during the run, ignored by the sheet: ${raw.trusted}`);
  console.log(`evidence ${evidence}`);
  assert.deepEqual(errors, [], "page errors during the workload");
  if (flag("assert")) {
    const failures = [];
    const check = (name, value, budget) => { if (!(value <= budget)) failures.push(`${name}: ${value} > ${budget}`); };
    check("pointerdown p95", last.dispatch.down.p95, BUDGET.downP95);
    check("pen pointermove p95", last.dispatch.penMove.p95, BUDGET.penMoveP95);
    check("pointerup p95", last.dispatch.up.p95, BUDGET.upP95);
    check("eraser move (nothing erased) p95", last.dispatch.eraserMissMove.p95, BUDGET.eraserMissMoveP95);
    check("full repaint p95", last.plugin.paintInk?.p95 ?? 0, BUDGET.fullRepaintP95);
    for (const w of checkpoints) check(`full repaints per pen stroke (max, ${w.label})`, w.repaintsPerStroke.max, BUDGET.repaintsPerStroke);
    for (const w of checkpoints) check(`host refresh per stroke from stroke 2 (max, ${w.label})`, w.hostRefreshPerStroke.max, BUDGET.hostRefreshPerStroke);
    check("host refresh per pan move (max)", fin.dispatch.panRefresh.max, BUDGET.hostRefreshPerPanMove);
    check("pointerup p95 growth", last.dispatch.up.p95 / first.dispatch.up.p95, BUDGET.upGrowth);
    if (starved.length) failures.push(`frames not rendering in ${starved.map(w => w.label).join(", ")}: results invalid`);
    if (failures.length) { console.error(`Budget failures:\n  ${failures.join("\n  ")}`); process.exitCode = 1; }
    else console.log("All section 6 budgets met.");
  }
} finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); }
