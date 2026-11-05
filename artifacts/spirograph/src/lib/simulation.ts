import { computeMeshState, type GearMeshState, type GearShape, type MeshMode } from "./gearMath";

export interface Point { x: number; y: number }
export interface NestedState {
  penX: number; penY: number; centerX: number; centerY: number; theta2: number;
}
export interface MeshConfig {
  fixedShape: GearShape; fixedRadius: number; fixedEcc: number; fixedSides: number;
  movingShape: GearShape; movingRadius: number; movingEcc: number; movingSides: number;
  fixedTable: Float64Array; movingTable: Float64Array;
  customFixed?: Float64Array | null; customMoving?: Float64Array | null;
  rackPath?: Float64Array | null; rackAngle: number; mode: MeshMode;
}

export function rotatePoint(x: number, y: number, angle: number): Point {
  return { x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) };
}

/** Shared world-space evaluator used by preview and animation, for every pen. */
export function evaluateMesh(phi: number, pen: number, c: MeshConfig): GearMeshState {
  const state = computeMeshState(
    phi, c.fixedShape, c.fixedRadius, c.fixedEcc, c.fixedTable, c.fixedSides,
    c.movingShape, c.movingRadius, c.movingEcc, c.movingTable, c.movingSides,
    pen, c.mode, c.customFixed, c.customMoving, c.rackPath,
  );
  if (c.mode !== "rack") return state;
  const center = rotatePoint(state.movingCenterX, state.movingCenterY, c.rackAngle);
  const tip = rotatePoint(state.penX, state.penY, c.rackAngle);
  return { ...state, movingCenterX: center.x, movingCenterY: center.y, penX: tip.x, penY: tip.y };
}

export function gearOrientation(phi: number, psi: number, mode: MeshMode, rackAngle = 0): number {
  return mode === "rack" ? psi + rackAngle
    : mode === "external" ? phi + psi + Math.PI : phi - psi;
}

export function computeNestedGear(
  phi: number, orientation: number, cx: number, cy: number,
  radius: number, nestedRadius: number, orbits: number, offset: number,
): NestedState {
  const orbit = orbits * phi;
  const centerX = cx + (radius - nestedRadius) * Math.cos(orientation + orbit);
  const centerY = cy + (radius - nestedRadius) * Math.sin(orientation + orbit);
  const theta2 = orientation - orbit * (radius / nestedRadius - 1);
  return {
    centerX, centerY, theta2,
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
