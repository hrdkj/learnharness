// DEVICE ONLY — do not upstream. Replays the handwriting workload into the
// running LearnHarness AppImage (docs/drawing-pad-perf-plan.md, 7.2) through
// CDP Input.dispatchMouseEvent, so events travel the real Electron input and
// compositing path. Mouse input has constant pressure.
//
// Requires a THROWAWAY chat with Draw open on an empty sheet. Refuses otherwise.
//   node tests/device-replay.mjs [--strokes=N] [--seed=N] [--hz=120] [--json=FILE] [--keep]
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { handwriting } from "./perf-workload.mjs";

const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const strokes = Number(option("strokes", 300)), seed = Number(option("seed", 1)), interval = 1000 / Number(option("hz", 120));
const browser = await puppeteer.connect({ browserURL: process.env.LH_CDP ?? "http://127.0.0.1:9229", defaultViewport: null, protocolTimeout: 30 * 60_000 });
try {
  const pages = (await browser.pages()).filter(page => page.url().startsWith("http://127.0.0.1"));
  let page;
  for (const candidate of pages) if (await candidate.$(".drawing-pad-ink")) { page = candidate; break; }
  if (!page) throw new Error("Refusing to run: no open Drawing Pad (.drawing-pad-ink) found. Open Draw in a throwaway chat first.");
  const state = await page.evaluate(() => {
    const button = label => [...document.querySelectorAll(".drawing-pad-tools button")].find(b => (b.getAttribute("aria-label") ?? b.textContent) === label);
    const paper = document.querySelector(".drawing-pad-paper");
    return { perf: !!window.__drawingPadPerf, ready: !!paper && !paper.hidden, undoDisabled: button("Undo")?.disabled, clearDisabled: button("Clear")?.disabled };
  });
  if (!state.perf) throw new Error("Refusing to run: the installed plugin has no __drawingPadPerf (not a perf build).");
  if (!state.ready) throw new Error("Refusing to run: the drawing sheet is not ready.");
  if (state.undoDisabled !== true || state.clearDisabled !== true) throw new Error("Refusing to run: the sheet already has strokes. Use an empty sheet in a throwaway chat.");
  const cdp = await page.createCDPSession();
  const rect = await page.evaluate(() => { const r = document.querySelector(".drawing-pad-ink").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const ops = handwriting({ width: rect.width, height: rect.height, seed, strokes });
  // In-page frame and long-animation-frame recorders for this run only.
  await page.evaluate(() => {
    const run = window.__drawingPadReplay = { frames: [], loaf: [], stop: false };
    let last;
    const tick = now => { if (last !== undefined) run.frames.push(now - last); last = now; if (!run.stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    run.observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) run.loaf.push({ duration: entry.duration, blocking: entry.blockingDuration,
        plugin: entry.scripts.some(script => /\/drawing-pad\/assets\/main\.js(?:[?#]|$)/.test(script.sourceURL)), scripts: entry.scripts.map(s => ({ ms: Math.round(s.duration), src: s.sourceURL.split("/").slice(-2).join("/"), invoker: s.invoker })) });
    });
    run.observer.observe({ type: "long-animation-frame" });
    window.__drawingPadPerf.reset();
  });
  const click = label => page.evaluate(label => [...document.querySelectorAll(".drawing-pad-tools button")].find(b => (b.getAttribute("aria-label") ?? b.textContent) === label).click(), label);
  let next = performance.now();
  const paced = async () => { next += interval; const wait = next - performance.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); else next = performance.now(); };
  const mouse = (type, point, buttons, button = "left") => cdp.send("Input.dispatchMouseEvent", { type, x: rect.x + point.x, y: rect.y + point.y, button, buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
  const gesture = async points => {
    await mouse("mouseMoved", points[0], 0, "none"); await mouse("mousePressed", points[0], 1);
    for (let i = 1; i < points.length; i++) { await paced(); await mouse("mouseMoved", points[i], 1); }
    await mouse("mouseReleased", points.at(-1), 0);
  };
  const windows = [];
  const collect = async label => {
    const data = await page.evaluate(() => {
      const run = window.__drawingPadReplay, frames = run.frames.splice(0), loaf = run.loaf.splice(0), summary = window.__drawingPadPerf.summary();
      window.__drawingPadPerf.reset(); return { frames, loaf, summary };
    });
    const sorted = [...data.frames].sort((a, b) => a - b), at = q => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 10) / 10 : 0;
    windows.push({ label, frames: { n: sorted.length, p50: at(.5), p95: at(.95), max: at(1), over33: sorted.filter(v => v > 33).length },
      longFrames: { n: data.loaf.length, over150: data.loaf.filter(e => e.duration >= 150).length, pluginOver150: data.loaf.filter(e => e.duration >= 150 && e.plugin).length,
        worst: data.loaf.sort((a, b) => b.duration - a.duration).slice(0, 5) }, plugin: data.summary });
    console.log(`${label}: frames p50/p95/max ${windows.at(-1).frames.p50}/${windows.at(-1).frames.p95}/${windows.at(-1).frames.max} ms, >33 ms: ${windows.at(-1).frames.over33}, LoAF ≥150 ms: ${windows.at(-1).longFrames.over150} (plugin ${windows.at(-1).longFrames.pluginOver150})`);
  };
  let label = "strokes 1–100";
  for (const op of ops) {
    if (op.type === "checkpoint") { await collect(label); label = `strokes ${op.strokes + 1}–${op.strokes + 100}`; continue; }
    if (op.type === "pen") await gesture(op.points);
    else if (op.type === "eraser" || op.type === "sweep") { await click("Eraser"); await gesture(op.points); await click("Pen"); }
    else if (op.type === "pan") {
      if (op.phase === "final" && !label.startsWith("final")) label = "final: undo ×10, pan ×10, sweep";
      await click("Hand");
      const centre = { x: rect.width / 2, y: rect.height / 2 }, points = [];
      for (let i = 0; i <= op.moves; i++) points.push({ x: centre.x + op.dx * i / op.moves, y: centre.y + op.dy * i / op.moves });
      await gesture(points); await click("Pen");
    } else if (op.type === "undo") { label = "final: undo ×10, pan ×10, sweep"; await click("Undo"); await paced(); }
  }
  await collect(label);
  await page.evaluate(() => { const run = window.__drawingPadReplay; run.stop = true; run.observer.disconnect(); delete window.__drawingPadReplay; });
  if (!process.argv.includes("--keep")) await click("Clear");
  const report = { at: new Date().toISOString(), seed, strokes, hz: 1000 / interval, rect, windows };
  const out = option("json"); if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report));
  await cdp.detach();
} finally { browser.disconnect(); }
