export type GearShape = "circle" | "ellipse" | "polygon" | "custom";
export type MeshMode  = "internal" | "external" | "rack";

const TWO_PI = 2 * Math.PI;

export function gearRadius(
  shape: GearShape,
  baseR: number,
  ecc: number,
  theta: number,
  sides = 5,
  customRTable?: Float64Array | null,
): number {
  if (shape === "custom") {
    if (!customRTable || customRTable.length === 0) return baseR;
    const N    = customRTable.length;
    const norm = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
    const idx  = (norm / TWO_PI) * N;
    const lo   = Math.floor(idx) % N;
    const hi   = (lo + 1) % N;
    const frac = idx - Math.floor(idx);
    return (customRTable[lo] * (1 - frac) + customRTable[hi] * frac) * baseR;
  }
  switch (shape) {
    case "circle":
      return baseR;
    case "ellipse": {
      const a = baseR;
      const b = baseR * (1 - ecc * 0.95);
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const denom = Math.sqrt(b * b * cos * cos + a * a * sin * sin);
      return denom < 1e-10 ? baseR : (a * b) / denom;
    }
    case "polygon": {
      const n = Math.max(3, Math.round(sides));
      return baseR * (1 - ecc * 0.4 * Math.cos(n * theta));
    }
  }
}

function integrand(
  shape: GearShape,
  baseR: number,
  ecc: number,
  t: number,
  sides: number,
  customRTable?: Float64Array | null,
): number {
  const dt = 1e-5;
  const r  = gearRadius(shape, baseR, ecc, t,      sides, customRTable);
  const rp = gearRadius(shape, baseR, ecc, t + dt, sides, customRTable);
  const rm = gearRadius(shape, baseR, ecc, t - dt, sides, customRTable);
  const dr = (rp - rm) / (2 * dt);
  return Math.sqrt(r * r + dr * dr);
}

export function buildArcLengthTable(
  shape: GearShape,
  baseR: number,
  ecc: number,
  N = 1000,
  sides = 5,
  customRTable?: Float64Array | null,
): Float64Array<ArrayBuffer> {
  const table  = new Float64Array(N + 1) as Float64Array<ArrayBuffer>;
  const dTheta = TWO_PI / N;
  table[0] = 0;
  for (let i = 1; i <= N; i++) {
    const t0 = (i - 1) * dTheta;
    const t1 = i * dTheta;
    const tm = (t0 + t1) / 2;
    table[i] =
      table[i - 1] +
      (dTheta / 6) *
        (integrand(shape, baseR, ecc, t0, sides, customRTable) +
         4 * integrand(shape, baseR, ecc, tm, sides, customRTable) +
         integrand(shape, baseR, ecc, t1, sides, customRTable));
  }
  return table;
}

export function angleForArcLength(table: Float64Array, targetLen: number): number {
  const N        = table.length - 1;
  const totalLen = table[N];
  if (totalLen < 1e-10) return 0;
  const normalised = ((targetLen % totalLen) + totalLen) % totalLen;
  let lo = 0, hi = N;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid] <= normalised) lo = mid; else hi = mid;
  }
  const diff = table[lo + 1] - table[lo];
  const frac  = diff < 1e-14 ? 0 : (normalised - table[lo]) / diff;
  return ((lo + frac) / N) * TWO_PI;
}

export function totalArcLength(table: Float64Array): number {
  return table[table.length - 1];
}

export interface GearMeshState {
  phi: number;
  psi: number;
  arcLenFixed: number;
  movingCenterX: number;
  movingCenterY: number;
  penX: number;
  penY: number;
}

function arcLengthAlongFixed(table: Float64Array, phi: number): number {
  const N        = table.length - 1;
  const totalLen = table[N];
  const dTheta   = TWO_PI / N;
  const normalizedPhi = ((phi % TWO_PI) + TWO_PI) % TWO_PI;
  const idx  = normalizedPhi / dTheta;
  const lo   = Math.floor(idx);
  const hi   = Math.min(lo + 1, N);
  const frac = idx - lo;
  const baseArc    = table[lo] + frac * (table[hi] - table[lo]);
  const fullRounds = Math.floor(phi / TWO_PI);
  return baseArc + fullRounds * totalLen;
}

/**
 * computeMeshState
 *
 * fixedSides / movingSides: polygon side count for each gear (ignored for circle/ellipse).
 * meshMode:
 *   "internal" — hypocycloid: moving gear rolls inside the fixed ring (default).
 *   "external" — epicycloid:  moving gear orbits outside a fixed hub.
 *   "rack"     — trochoid:    moving gear rolls along a straight rack.
 *                The rack lies along y = 0; gear center at y = movingBaseR.
 *                x grows as phi increases (not periodic in screen space).
 * customFixedRTable / customMovingRTable: normalized r(θ) for custom gear shapes.
 */
export function computeMeshState(
  phi: number,
  fixedShape: GearShape, fixedBaseR: number, fixedEcc: number,
  fixedTable: Float64Array, fixedSides: number,
  movingShape: GearShape, movingBaseR: number, movingEcc: number,
  movingTable: Float64Array, movingSides: number,
  penOffset: number,
  meshMode: MeshMode = "internal",
  customFixedRTable?: Float64Array | null,
  customMovingRTable?: Float64Array | null,
): GearMeshState {
  // ── Rack mode ────────────────────────────────────────────────────────────
  if (meshMode === "rack") {
    const arcLen = movingBaseR * phi;
    const psi    = angleForArcLength(movingTable, arcLen);
    const cx = arcLen;
    const cy = -movingBaseR;
    const penAngleWorld = psi;
    const d  = penOffset * movingBaseR;
    return {
      phi, psi, arcLenFixed: arcLen,
      movingCenterX: cx, movingCenterY: cy,
      penX: cx + d * Math.cos(penAngleWorld),
      penY: cy + d * Math.sin(penAngleWorld),
    };
  }

  // ── Shared arc-length lookup (internal / external) ───────────────────────
  const arcLen = arcLengthAlongFixed(fixedTable, phi);
  const psi    = angleForArcLength(movingTable, arcLen);
  const Rf     = gearRadius(fixedShape,  fixedBaseR,  fixedEcc,  phi, fixedSides,  customFixedRTable);
  const Rm     = gearRadius(movingShape, movingBaseR, movingEcc, psi, movingSides, customMovingRTable);

  // ── External mode (epicycloid) ───────────────────────────────────────────
  if (meshMode === "external") {
    const centerDist = Rf + Rm;
    const cx = centerDist * Math.cos(phi);
    const cy = centerDist * Math.sin(phi);
    const penAngleWorld = phi + psi + Math.PI;
    const d = penOffset * movingBaseR;
    return {
      phi, psi, arcLenFixed: arcLen,
      movingCenterX: cx, movingCenterY: cy,
      penX: cx + d * Math.cos(penAngleWorld),
      penY: cy + d * Math.sin(penAngleWorld),
    };
  }

  // ── Internal mode (hypocycloid, default) ─────────────────────────────────
  const centerDist = Math.max(0, Rf - Rm);
  const cx = centerDist * Math.cos(phi);
  const cy = centerDist * Math.sin(phi);
  const penAngleWorld = phi - psi;
  const d = penOffset * movingBaseR;
  return {
    phi, psi, arcLenFixed: arcLen,
    movingCenterX: cx, movingCenterY: cy,
    penX: cx + d * Math.cos(penAngleWorld),
    penY: cy + d * Math.sin(penAngleWorld),
  };
}

export function drawPolarCurve(
  ctx: CanvasRenderingContext2D,
  shape: GearShape,
  baseR: number,
  ecc: number,
  cx: number,
  cy: number,
  rotAngle: number,
  sides: number,
  N = 360,
  customRTable?: Float64Array | null,
): void {
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const t          = (i / N) * TWO_PI;
    const r          = gearRadius(shape, baseR, ecc, t, sides, customRTable);
    const worldAngle = t + rotAngle;
    if (i === 0) ctx.moveTo(cx + r * Math.cos(worldAngle), cy + r * Math.sin(worldAngle));
    else         ctx.lineTo(cx + r * Math.cos(worldAngle), cy + r * Math.sin(worldAngle));
  }
  ctx.closePath();
}
