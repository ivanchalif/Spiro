import assert from "node:assert/strict";
import { test } from "node:test";
import { TraceLayer, type TraceRun } from "./traceLayer";

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
