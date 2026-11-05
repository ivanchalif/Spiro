import assert from "node:assert/strict";
import { test } from "node:test";
import { TraceLayer, getCopyColor, type TraceRun } from "./traceLayer";

test("trace cache appends new segments instead of replaying old points", () => {
  let lines = 0, strokes = 0;
  const context = {
    setTransform() {}, beginPath() {}, moveTo() {},
    lineTo() { lines++; }, stroke() { strokes++; }, drawImage() {},
  };
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  } as unknown as Document;
  try {
    const layer = new TraceLayer();
    const run: TraceRun = { color: "#60a5fa", weight: 2, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    const view = { size: 600, scale: 1, dpr: 1, offX: 0, offY: 0 };
    layer.draw(context as unknown as CanvasRenderingContext2D, [run], view);
    assert.equal(lines, 1);
    layer.draw(context as unknown as CanvasRenderingContext2D, [run], view);
    assert.equal(strokes, 1);
    run.points.push({ x: 2, y: 2 });
    layer.draw(context as unknown as CanvasRenderingContext2D, [run], view);
    assert.equal(lines, 2);
    layer.invalidate();
    layer.draw(context as unknown as CanvasRenderingContext2D, [run], view);
    assert.equal(lines, 4);
  } finally { globalThis.document = previous; }
});

test("rotated copies retain incremental caching and rebuild when copy count changes", () => {
  const ends: number[][] = [];
  const colors: string[] = [];
  const context = {
    strokeStyle: "",
    setTransform() {}, beginPath() {}, moveTo() {},
    lineTo(x: number, y: number) { ends.push([x, y]); },
    stroke() { colors.push(this.strokeStyle); }, drawImage() {},
  };
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  } as unknown as Document;
  try {
    const layer = new TraceLayer();
    const run: TraceRun = { color: "#60a5fa", weight: 2, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
    const view = { size: 600, scale: 1, dpr: 1, offX: 0, offY: 0, copies: 4 };
    const target = context as unknown as CanvasRenderingContext2D;
    layer.draw(target, [run], view);
    assert.deepEqual(ends.map(p => p.map(Math.round)), [[310, 300], [300, 310], [290, 300], [300, 290]]);
    assert.deepEqual(colors, ["#60a5fa", "#f472b6", "#34d399", "#fbbf24"]);
    layer.draw(target, [run], view);
    assert.equal(colors.length, 4);
    run.points.push({ x: 20, y: 0 });
    layer.draw(target, [run], view);
    assert.equal(ends.length, 8);
    layer.draw(target, [run], { ...view, copies: 1 });
    assert.equal(colors.length, 9);
    layer.archiveRuns([run], view);
    assert.equal(colors.length, 13);
    assert.equal(getCopyColor(0, 12, run.color), run.color);
    assert.equal(getCopyColor(6, 12, run.color), "hsl(180, 80%, 60%)");
  } finally { globalThis.document = previous; }
});
