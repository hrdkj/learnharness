// DEVICE ONLY — do not upstream. Deterministic "handwriting" workload shared by
// tests/perf.mjs (synthetic in-page PointerEvents) and tests/device-replay.mjs
// (CDP input into the running AppImage). Coordinates are CSS pixels relative to
// the drawing canvas' top-left corner.

/** mulberry32: small, seeded, deterministic. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LETTERS_PER_ROW = 10, ROWS_PER_BLOCK = 10, BLOCK = LETTERS_PER_ROW * ROWS_PER_BLOCK;

/**
 * Ops, in order:
 *   { type: "pen", stroke, points }                 one pen stroke (down, moves, up)
 *   { type: "eraser", hit, points }                 one eraser gesture with the Eraser tool
 *   { type: "pan", dx, dy, moves, phase }           Hand-tool drag ("block" between blocks, "final" afterwards)
 *   { type: "undo" }                                Undo button
 *   { type: "sweep", points }                       one long eraser gesture across dense ink
 *   { type: "checkpoint", strokes }                 after 100/200/300 pen strokes
 */
export function handwriting({ width, height, seed = 1, strokes = 300, eraseEvery = 15 }) {
  const random = prng(seed), ops = [];
  const left = Math.max(140, (width - 860) / 2), top = 110;
  const rowHeight = Math.min(64, (height - top - 90) / ROWS_PER_BLOCK), letterPitch = 86, letterWidth = 46;
  const blockPan = -Math.round(rowHeight * ROWS_PER_BLOCK + 40);
  const pressure = t => Math.min(.9, Math.max(.2, .45 + .35 * Math.sin(Math.PI * t) + (random() - .5) * .2));
  const letter = (x0, y0) => {
    const n = 38 + Math.floor(random() * 15), loops = 1 + Math.floor(random() * 3), h = rowHeight * (.45 + random() * .2);
    const tilt = (random() - .5) * 8, points = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      points.push({ x: x0 + letterWidth * t + 9 * Math.sin(2 * Math.PI * loops * t) + tilt * t,
        y: y0 - h * Math.abs(Math.sin(Math.PI * loops * t)) * (.6 + .4 * Math.sin(3 * t)), pressure: pressure(t) });
    }
    return points;
  };
  let last;
  for (let stroke = 1; stroke <= strokes; stroke++) {
    const index = (stroke - 1) % BLOCK, row = Math.floor(index / LETTERS_PER_ROW), column = index % LETTERS_PER_ROW;
    const x = left + column * letterPitch, y = top + (row + 1) * rowHeight - 8;
    const points = letter(x, y);
    ops.push({ type: "pen", stroke, points }); last = { x: x + letterWidth / 2, y: y - rowHeight * .3 };
    if (stroke % eraseEvery === 0) {
      const hit = (stroke / eraseEvery) % 2 === 1, eraser = [];
      // Hit: a short zigzag over the letter just written. Miss: the same
      // gesture in the empty right margin, clear of every row's ink.
      const cx = hit ? last.x : left + LETTERS_PER_ROW * letterPitch + 60, cy = hit ? last.y : last.y;
      for (let i = 0; i < 30; i++) eraser.push({ x: cx + 6 * Math.sin(i / 2), y: cy - 12 + i * .8, pressure: .6 });
      ops.push({ type: "eraser", hit, points: eraser });
    }
    if (stroke % BLOCK === 0) {
      ops.push({ type: "checkpoint", strokes: stroke });
      if (stroke < strokes) ops.push({ type: "pan", dx: 0, dy: blockPan, moves: 40, phase: "block" });
    }
  }
  if (strokes % BLOCK !== 0) ops.push({ type: "checkpoint", strokes });
  for (let i = 0; i < 10; i++) ops.push({ type: "undo" });
  for (let i = 0; i < 10; i++) ops.push({ type: "pan", dx: 0, dy: i < 5 ? 200 : -200, moves: 40, phase: "final" });
  const sweep = [], sweepY = top + 5 * rowHeight - 20;
  for (let i = 0; i < 200; i++) sweep.push({ x: left - 20 + (LETTERS_PER_ROW * letterPitch) * i / 199, y: sweepY + 14 * Math.sin(i / 6), pressure: .6 });
  ops.push({ type: "sweep", points: sweep });
  return ops;
}
