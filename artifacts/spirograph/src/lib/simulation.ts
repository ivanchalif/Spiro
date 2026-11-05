import { computeMeshState, gearContour, type GearMeshState, type GearShape, type MeshMode } from "./gearMath";
import { boundaryContact, fittingScale, outline, transformOutline, TOOTH_HEIGHT, type Vertex } from "./contactGeometry";

export interface Point { x: number; y: number }
export interface NestedState {
  penX: number; penY: number; centerX: number; centerY: number; theta2: number;
  r2: number; teeth: number; toothHeight: number;
}
export interface MeshConfig {
  fixedShape: GearShape; fixedRadius: number; fixedEcc: number; fixedSides: number;
  movingShape: GearShape; movingRadius: number; movingEcc: number; movingSides: number;
  fixedTable: Float64Array; movingTable: Float64Array;
  customFixed?: Float64Array | null; customMoving?: Float64Array | null;
  rackPath?: Float64Array | null; rackAngle: number; mode: MeshMode;
  movingTeeth?: number;
}

export function rotatePoint(x: number, y: number, angle: number): Point {
  return { x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) };
}

/** Shared world-space evaluator used by preview and animation, for every pen. */
export function evaluateMesh(phi: number, pen: number, c: MeshConfig): GearMeshState {
  const state = computeMeshState(
    phi, c.fixedShape, c.fixedRadius, c.fixedEcc, c.fixedTable, c.fixedSides,
    c.movingShape, c.movingRadius, c.movingEcc, c.movingTable, c.movingSides,
    pen, c.mode, c.customFixed, c.customMoving, c.rackPath, c.movingTeeth,
  );
  if (c.mode !== "rack") return state;
  const center = rotatePoint(state.movingCenterX, state.movingCenterY, c.rackAngle);
  const tip = rotatePoint(state.penX, state.penY, c.rackAngle);
  const contact = rotatePoint(state.contactX, state.contactY, c.rackAngle);
  return { ...state, movingCenterX: center.x, movingCenterY: center.y, penX: tip.x, penY: tip.y, contactX: contact.x, contactY: contact.y };
}

export function gearOrientation(phi: number, psi: number, mode: MeshMode, rackAngle = 0): number {
  return mode === "rack" ? psi + rackAngle
    : mode === "external" ? phi + psi + Math.PI : phi - psi;
}

const nestedContours = new WeakMap<Float64Array, Map<string, { fixed: Vertex[]; moving: Vertex[]; fit: number; teeth: number }>>();
export function computeNestedGear(
  phi: number, orientation: number, cx: number, cy: number,
  radius: number, nestedRadius: number, orbits: number, offset: number,
  parent?: MeshConfig, parentScale = 1,
): NestedState {
  const orbit = orbits * phi;
  if (parent) {
    let cache = nestedContours.get(parent.movingTable);
    if (!cache) { cache = new Map(); nestedContours.set(parent.movingTable, cache); }
    const key = [radius, nestedRadius, parentScale, parent.movingShape, parent.movingEcc, parent.movingSides, parent.movingTeeth].join(":");
    let geometry = cache.get(key);
    if (!geometry) {
      const fixed = transformOutline(gearContour(parent.movingTable, parent.movingShape, radius,
        parent.movingEcc, parent.movingSides, parent.customMoving, parent.movingTeeth), 0, parentScale);
      const teeth = Math.max(6, Math.round((parent.movingTeeth ?? 68) * nestedRadius / radius));
      const moving = outline(() => nestedRadius * parentScale, teeth, TOOTH_HEIGHT * parentScale);
      geometry = { fixed, moving, teeth, fit: fittingScale(fixed, moving) };
      if (cache.size >= 32) cache.delete(cache.keys().next().value!);
      cache.set(key, geometry);
    }
    const { fixed, moving, fit, teeth } = geometry;
    const theta = -orbit * (radius / (nestedRadius * fit) - 1);
    const contact = boundaryContact(fixed, transformOutline(moving, theta, fit),
      { x: 0, y: 0 }, { x: Math.cos(orbit), y: Math.sin(orbit) }, true);
    const center = rotatePoint(contact.centerX, contact.centerY, orientation);
    const r2 = nestedRadius * parentScale * fit;
    const theta2 = orientation + theta;
    return {
      centerX: cx + center.x, centerY: cy + center.y, theta2, r2, teeth,
      toothHeight: TOOTH_HEIGHT * parentScale * fit,
      penX: cx + center.x + offset * r2 * Math.cos(theta2),
      penY: cy + center.y + offset * r2 * Math.sin(theta2),
    };
  }
  const centerX = cx + (radius - nestedRadius) * Math.cos(orientation + orbit);
  const centerY = cy + (radius - nestedRadius) * Math.sin(orientation + orbit);
  const theta2 = orientation - orbit * (radius / nestedRadius - 1);
  return {
    centerX, centerY, theta2,
    r2: nestedRadius, teeth: Math.max(6, Math.round(nestedRadius * 0.8)), toothHeight: TOOTH_HEIGHT,
    penX: centerX + offset * nestedRadius * Math.cos(theta2),
    penY: centerY + offset * nestedRadius * Math.sin(theta2),
  };
}

/** Fixed 60 Hz simulation, capped catch-up after throttled/background frames. */
export class FixedStepClock {
  private previous: number | undefined;
  private accumulated = 0;
  consume(timestamp: number): number {
    if (this.previous === undefined) { this.previous = timestamp; return 1; }
    this.accumulated += Math.max(0, Math.min(100, timestamp - this.previous));
    this.previous = timestamp;
    const steps = Math.min(6, Math.floor((this.accumulated + 1e-7) / (1000 / 60)));
    this.accumulated -= steps * (1000 / 60);
    return steps;
  }
}

/** O(1) bounded trail insertion; no Array.shift on each frame. */
export class PointRing {
  private data: Point[];
  private head = 0;
  length = 0;
  constructor(readonly capacity: number) { this.data = new Array(capacity); }
  push(point: Point) {
    this.data[this.head] = point;
    this.head = (this.head + 1) % this.capacity;
    this.length = Math.min(this.length + 1, this.capacity);
  }
  at(index: number): Point {
    return this.data[(this.head - this.length + index + this.capacity) % this.capacity];
  }
  toArray(): Point[] { return Array.from({ length: this.length }, (_, i) => this.at(i)); }
}
