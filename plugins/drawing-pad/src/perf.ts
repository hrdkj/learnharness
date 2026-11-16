/** DEVICE ONLY — do not upstream. In-memory perf counters for the Drawing Pad
 * smoothness work. Nothing is logged per event; read the numbers with
 * `window.__drawingPadPerf.summary()` (over CDP or from tests/perf.mjs).
 *
 * Every bucket counts events (`n`) and sums their values (`total`): a duration
 * in milliseconds for `timed`/`timedAsync`, the `by` amount for `count`. */
export interface PerfBucket { n: number; total: number; max: number; samples: number[] } // samples: ring buffer, last 2000
const RING = 2000;
export const perf: Record<string, PerfBucket> = {};

function record(name: string, value: number): void {
  const bucket = perf[name] ??= { n: 0, total: 0, max: 0, samples: [] };
  if (bucket.samples.length < RING) bucket.samples.push(value);
  else bucket.samples[bucket.n % RING] = value;
  bucket.n++; bucket.total += value;
  if (value > bucket.max) bucket.max = value;
}
/** Synchronous wall time of `run`, in milliseconds. */
export function timed<T>(name: string, run: () => T): T {
  const start = performance.now();
  try { return run(); } finally { record(name, performance.now() - start); }
}
/** Elapsed time until the promise settles (not main-thread blocking time). */
export async function timedAsync<T>(name: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await run(); } finally { record(name, performance.now() - start); }
}
export function count(name: string, by = 1): void { record(name, by); }
function quantile(sorted: readonly number[], q: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;
}
export function perfSummary(): Record<string, { n: number; p50: number; p95: number; max: number; total: number }> {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return Object.fromEntries(Object.entries(perf).sort(([a], [b]) => a.localeCompare(b)).map(([name, bucket]) => {
    const sorted = [...bucket.samples].sort((a, b) => a - b);
    return [name, { n: bucket.n, p50: round(quantile(sorted, .5)), p95: round(quantile(sorted, .95)), max: round(bucket.max), total: round(bucket.total) }];
  }));
}
export function perfReset(): void { for (const name of Object.keys(perf)) delete perf[name]; }

interface LongFrame { startTime: number; duration: number; blockingDuration: number; renderStart: number;
  scripts: { invoker: string; sourceURL: string; sourceFunctionName: string; duration: number; forcedStyleAndLayoutDuration: number }[] }
/** Long animation frames (≥ 150 ms), with page visibility/focus at their start
 * and end so a hidden Hyprland workspace can be told from a real stall. */
function observeLongFrames(): void {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) return;
  // Visibility/focus are sampled on every change, so the state at any past
  // timestamp is the last change at or before it.
  const states: { at: number; visible: boolean; focused: boolean }[] = [];
  const sample = () => {
    states.push({ at: performance.now(), visible: document.visibilityState === "visible", focused: document.hasFocus() });
    if (states.length > 1000) states.splice(0, states.length - 1000);
  };
  const stateAt = (time: number) => {
    let found = states[0];
    for (const state of states) { if (state.at > time) break; found = state; }
    return found ? { visible: found.visible, focused: found.focused } : undefined;
  };
  sample();
  document.addEventListener("visibilitychange", sample);
  window.addEventListener("focus", sample); window.addEventListener("blur", sample);
  const store = ((window as unknown as { __lhLongFrames?: unknown[] }).__lhLongFrames ??= []);
  new PerformanceObserver(list => {
    for (const entry of list.getEntries() as unknown as LongFrame[]) {
      if (entry.duration < 150) continue;
      const end = entry.startTime + entry.duration;
      const row = { at: new Date().toISOString(), start: Math.round(entry.startTime), duration: Math.round(entry.duration), blocking: Math.round(entry.blockingDuration),
        render: Math.round(end - (entry.renderStart || end)), atStart: stateAt(entry.startTime), atEnd: stateAt(end),
        scripts: entry.scripts.map(s => ({ ms: Math.round(s.duration), layout: Math.round(s.forcedStyleAndLayoutDuration), invoker: s.invoker,
          fn: s.sourceFunctionName, src: s.sourceURL.split("/").slice(-2).join("/") })) };
      store.push(row); if (store.length > 500) store.shift();
      console.warn("[lh-long-frame]", JSON.stringify(row));
    }
  }).observe({ type: "long-animation-frame", buffered: true });
}
if (typeof window !== "undefined") {
  const target = window as unknown as { __drawingPadPerf?: { summary: typeof perfSummary; reset: typeof perfReset } };
  // One observer per window even if the plugin bundle is evaluated again.
  if (!target.__drawingPadPerf) observeLongFrames();
  target.__drawingPadPerf = { summary: perfSummary, reset: perfReset };
}
