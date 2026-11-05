import assert from "node:assert/strict";
import { test } from "node:test";
import { boundaryContact, transformOutline, outline, type Vertex } from "./contactGeometry";
import { buildArcLengthTable, buildRackPathTable, computeMeshState, gearContour, type GearShape } from "./gearMath";
import { rackOutline, RACK_PERIOD, RACK_SPAN } from "./rackRoute";
import { computeNestedGear, gearOrientation, type MeshConfig } from "./simulation";

// Independent winding/edge-distance check, not the translation solver.
function classify(p: Vertex, polygon: Vertex[]) {
  let inside = false, distance = Infinity;
  polygon.forEach((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    distance = Math.min(distance, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
    if ((a.y > p.y) !== (b.y > p.y) && p.x < a.x + (p.y - a.y) * dx / dy) inside = !inside;
  });
  return { inside, distance };
}
function samples(polygon: Vertex[]) {
  const points: Vertex[] = [];
  for (let i = 0; i < polygon.length; i += Math.max(1, Math.floor(polygon.length / 32))) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    points.push(a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  return points;
}
function assertPose(fixed: Vertex[], moving: Vertex[], contact: Vertex, internal: boolean) {
  assert.ok(classify(contact, fixed).distance < 1e-5, "contact must lie on the governing edge");
  assert.ok(classify(contact, moving).distance < 1e-5, "contact must also lie on the moving edge");
  for (const p of samples(moving)) {
    const c = classify(p, fixed);
    assert.ok(c.distance < 1e-5 || c.inside === internal, "moving boundary crossed governing boundary");
  }
  if (!internal) for (const p of samples(fixed)) {
    const c = classify(p, moving);
    assert.ok(c.distance < 1e-5 || !c.inside, "moving gear encloses part of fixed shape");
  }
}
const custom = Float64Array.from({ length: 256 }, (_, i) => 0.7 + 0.2 * Math.cos(i / 256 * Math.PI * 6));
const shapes: GearShape[] = ["circle", "ellipse", "polygon", "custom"];
for (const fixedShape of shapes) for (const movingShape of shapes) {
  for (const mode of ["internal", "external"] as const) {
    test(`${fixedShape}/${movingShape} ${mode}: complete toothed boundaries remain in contact without overlap`, () => {
      const ft = buildArcLengthTable(fixedShape, 155, 0.85, 800, 5, custom);
      const mt = buildArcLengthTable(movingShape, 85, 0.8, 800, 3, custom);
      const fixed = gearContour(ft, fixedShape, 155, 0.85, 5, custom, 124);
      const moving = gearContour(mt, movingShape, 85, 0.8, 3, custom, 68);
      for (let i = 0; i < 12; i++) {
        const phi = i * Math.PI / 6 + 0.013;
        const state = computeMeshState(phi, fixedShape, 155, 0.85, ft, 5, movingShape, 85, 0.8, mt, 3, 0.7, mode, custom, custom, null, 68);
        const rotated = transformOutline(moving, gearOrientation(phi, state.psi, mode), state.movingScale)
          .map(p => ({ x: p.x + state.movingCenterX, y: p.y + state.movingCenterY }));
        assertPose(fixed, rotated, { x: state.contactX, y: state.contactY }, mode === "internal");
      }
    });
  }
}

for (const curve of ["straight", "arc", "wave", "spiral"] as const) for (const movingShape of shapes) {
  test(`${movingShape} gear follows ${curve} rack edges, both faces and rounded ends`, () => {
    const radius = 50;
    const ft = buildArcLengthTable("circle", 155, 0);
    const mt = buildArcLengthTable(movingShape, radius, 0.8, 800, 3, custom);
    const path = buildRackPathTable(curve, 1, radius * RACK_SPAN);
    const rack = rackOutline(radius, path);
    for (let i = 0; i < 18; i++) {
      const phi = i / 18 * RACK_PERIOD;
      const state = computeMeshState(phi, "circle", 155, 0, ft, 5, movingShape, radius, 0.8, mt, 3, 0.7, "rack", null, custom, path, 40);
      const moving = transformOutline(gearContour(mt, movingShape, radius, 0.8, 3, custom, 40), state.psi)
        .map(p => ({ x: p.x + state.movingCenterX, y: p.y + state.movingCenterY }));
      assertPose(rack, moving, { x: state.contactX, y: state.contactY }, false);
    }
  });
}

test("oversized interior gears use one rotation-independent fit factor", () => {
  const ft = buildArcLengthTable("ellipse", 155, 0.95);
  const mt = buildArcLengthTable("polygon", 120, 1, 800, 3);
  const factors = [0, 1, 2, 3, 4].map(phi =>
    computeMeshState(phi, "ellipse", 155, 0.95, ft, 5, "polygon", 120, 1, mt, 3, 0.7).movingScale);
  assert.ok(factors[0] < 0.2);
  assert.ok(factors.every(f => f === factors[0]));
});

for (const shape of shapes) test(`nested gear remains inside a ${shape} parent`, () => {
  const ft = buildArcLengthTable("circle", 155, 0);
  const mt = buildArcLengthTable(shape, 85, 0.85, 800, 3, custom);
  const config: MeshConfig = { fixedShape: "circle", fixedRadius: 155, fixedEcc: 0, fixedSides: 5,
    movingShape: shape, movingRadius: 85, movingEcc: 0.85, movingSides: 3,
    fixedTable: ft, movingTable: mt, customMoving: custom, movingTeeth: 68, mode: "internal", rackAngle: 0 };
  for (let i = 0; i < 12; i++) {
    const phi = i * 0.4;
    const n = computeNestedGear(phi, 0, 0, 0, 85, 40, 3, 0.7, config);
    const fixed = gearContour(mt, shape, 85, 0.85, 3, custom, 68);
    const moving = transformOutline(outline(() => n.r2, n.teeth, n.toothHeight), n.theta2)
      .map(p => ({ x: p.x + n.centerX, y: p.y + n.centerY }));
    for (const p of samples(moving)) {
      const c = classify(p, fixed);
      assert.ok(c.inside || c.distance < 1e-5);
    }
  }
});

test("polygon contact preserves exact edge touching for flat-sided shapes", () => {
  const square = [{x:-10,y:-10},{x:10,y:-10},{x:10,y:10},{x:-10,y:10}];
  const little = square.map(p => ({x:p.x / 5,y:p.y / 5}));
  assert.equal(boundaryContact(square, little, {x:0,y:0}, {x:1,y:0}, true).centerX, 8);
  assert.equal(boundaryContact(square, little, {x:0,y:0}, {x:1,y:0}, false).centerX, 12);
});
