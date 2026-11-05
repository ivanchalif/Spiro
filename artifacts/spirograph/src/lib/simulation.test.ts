import assert from "node:assert/strict";
import { test } from "node:test";
import { buildArcLengthTable, buildRackPathTable, computeMeshState, evalRackPath } from "./gearMath";
import { RACK_SPAN, RACK_PERIOD, evaluateRackRoute } from "./rackRoute";
import { evaluateMesh, gearOrientation, computeNestedGear, FixedStepClock, PointRing, type MeshConfig } from "./simulation";
import { savedDrawingSchema } from "./savedDrawing";

const radius = 50;
const table = buildArcLengthTable("circle", radius, 0, 800);
const fixedTable = buildArcLengthTable("circle", 155, 0, 800);
const near = (a: number, b: number, tolerance = 1e-4) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

for (const shape of ["straight", "arc", "wave", "spiral"] as const) {
  for (const bend of [0, 0.5, 1]) {
    const path = buildRackPathTable(shape, bend, radius * RACK_SPAN, 600);
    const config: MeshConfig = {
      fixedShape: "circle", fixedRadius: 155, fixedEcc: 0, fixedSides: 5, fixedTable,
      movingShape: "circle", movingRadius: radius, movingEcc: 0, movingSides: 5, movingTable: table,
      rackPath: path, rackAngle: 0, mode: "rack",
    };
    test(`${shape}, bend ${bend}: all endpoint joins preserve center, pen, and rotation`, () => {
      for (const seam of [RACK_SPAN, RACK_SPAN + Math.PI, 2 * RACK_SPAN + Math.PI, RACK_PERIOD]) {
        const before = evaluateMesh(seam - 1e-7, 0.65, config);
        const after = evaluateMesh(seam + 1e-7, 0.65, config);
        assert.ok(distance({ x: before.movingCenterX, y: before.movingCenterY }, { x: after.movingCenterX, y: after.movingCenterY }) < 0.001);
        assert.ok(distance({ x: before.penX, y: before.penY }, { x: after.penX, y: after.penY }) < 0.001);
        near(Math.sin(before.psi), Math.sin(after.psi));
        near(Math.cos(before.psi), Math.cos(after.psi));
      }
    });
    test(`${shape}, bend ${bend}: contact stays a gear radius away through both sides and caps`, () => {
      for (let i = 0; i <= 100; i++) {
        const route = evaluateRackRoute(i / 100 * RACK_PERIOD, radius, path);
        near(Math.hypot(route.centerX - route.contactX, route.centerY - route.contactY), radius);
      }
    });
    test(`${shape}, bend ${bend}: extra pens share center and rotate with global orientation`, () => {
      for (const phase of [0, RACK_SPAN + 1, RACK_SPAN + Math.PI + 2, RACK_PERIOD - 1]) {
        const primary = evaluateMesh(phase, 0.9, config);
        const extra = evaluateMesh(phase, 0.3, config);
        near(primary.movingCenterX, extra.movingCenterX);
        near(primary.movingCenterY, extra.movingCenterY);
        near(Math.hypot(extra.penX - extra.movingCenterX, extra.penY - extra.movingCenterY), radius * 0.3);
        const rotated = evaluateMesh(phase, 0.9, { ...config, rackAngle: Math.PI / 2 });
        near(rotated.penX, -primary.penY); near(rotated.penY, primary.penX);
      }
    });
  }
}

test("far-end turnaround travels outside the endpoint rather than teleporting through the bar", () => {
  const route = evaluateRackRoute(RACK_SPAN + Math.PI / 2, radius);
  near(route.centerX, radius * RACK_SPAN + radius);
  near(route.centerY, 0);
  assert.equal(route.side, "far-end");
});

test("curved return retraces original path on opposite normal, not a mirrored different path", () => {
  const path = buildRackPathTable("spiral", 0.8, radius * RACK_SPAN, 600);
  const s = 2.5 * radius;
  const contact = evalRackPath(path, s, radius * RACK_SPAN);
  const front = evaluateRackRoute(2.5, radius, path);
  const back = evaluateRackRoute(2 * RACK_SPAN + Math.PI - 2.5, radius, path);
  near((front.centerX + back.centerX) / 2, contact.x);
  near((front.centerY + back.centerY) / 2, contact.y);
});

test("custom rack endpoint transitions are continuous", () => {
  const profile = Float64Array.from({ length: 256 }, (_, i) => Math.sin(i / 255 * Math.PI));
  for (const seam of [RACK_SPAN, RACK_SPAN + Math.PI, 2 * RACK_SPAN + Math.PI, RACK_PERIOD]) {
    const a = evaluateRackRoute(seam - 1e-8, radius, null, profile);
    const b = evaluateRackRoute(seam + 1e-8, radius, null, profile);
    assert.ok(Math.hypot(a.centerX - b.centerX, a.centerY - b.centerY) < 0.001);
  }
});

test("nested pen belongs to the displayed nested gear for every mesh mode", () => {
  for (const mode of ["internal", "external", "rack"] as const) {
    const parent = computeMeshState(2, "circle", 155, 0, fixedTable, 5, "circle", radius, 0, table, 5, 0.65, mode);
    const orientation = gearOrientation(2, parent.psi, mode);
    const nested = computeNestedGear(2, orientation, parent.movingCenterX, parent.movingCenterY, radius, 20, 3, 0.7);
    near(Math.hypot(nested.centerX - parent.movingCenterX, nested.centerY - parent.movingCenterY), 30);
    near(Math.hypot(nested.penX - nested.centerX, nested.penY - nested.centerY), 14);
  }
});

test("60 Hz and 120 Hz displays advance the same simulation distance", () => {
  const steps = (hz: number) => {
    const clock = new FixedStepClock();
    let count = 0;
    for (let i = 0; i <= hz * 10; i++) count += clock.consume(i * 1000 / hz);
    return count;
  };
  assert.equal(steps(60), steps(120));
  assert.equal(steps(60), 601);
});

test("background tabs have capped catch-up and resume starts a fresh clock", () => {
  const clock = new FixedStepClock();
  clock.consume(0);
  assert.ok(clock.consume(100000) <= 6);
  assert.equal(new FixedStepClock().consume(100000), 1);
});

test("three-body ring buffer stays bounded and preserves chronological order", () => {
  const trail = new PointRing(4);
  for (let i = 0; i < 10000; i++) trail.push({ x: i, y: -i });
  assert.equal(trail.length, 4);
  assert.deepEqual(trail.toArray().map(p => p.x), [9996, 9997, 9998, 9999]);
});

test("saved drawing rejects incomplete or malformed data rather than overwriting artwork", () => {
  assert.equal(savedDrawingSchema.safeParse({ version: 1, runs: [] }).success, false);
  assert.equal(savedDrawingSchema.safeParse({ version: 99 }).success, false);
});
