export type GearShape = "circle" | "ellipse" | "polygon";
export type MeshMode  = "internal" | "external" | "rack";

const TWO_PI = 2 * Math.PI;

export function gearRadius(
  shape: GearShape,
  baseR: number,
  ecc: number,
  theta: number,
  sides = 5
): number {
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
  sides: number
): number {
  const dt = 1e-5;
  const r  = gearRadius(shape, baseR, ecc, t,      sides);
  const rp = gearRadius(shape, baseR, ecc, t + dt, sides);
  const rm = gearRadius(shape, baseR, ecc, t - dt, sides);
  const dr = (rp - rm) / (2 * dt);
  return Math.sqrt(r * r + dr * dr);
}

export function buildArcLengthTable(
  shape: GearShape,
  baseR: number,
  ecc: number,
  N = 1000,
  sides = 5
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
        (integrand(shape, baseR, ecc, t0, sides) +
         4 * integrand(shape, baseR, ecc, tm, sides) +
         integrand(shape, baseR, ecc, t1, sides));
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
 */
export function computeMeshState(
  phi: number,
  fixedShape: GearShape, fixedBaseR: number, fixedEcc: number,
  fixedTable: Float64Array, fixedSides: number,
  movingShape: GearShape, movingBaseR: number, movingEcc: number,
  movingTable: Float64Array, movingSides: number,
  penOffset: number,
  meshMode: MeshMode = "internal",
): GearMeshState {
  // ── Rack mode ────────────────────────────────────────────────────────────
  if (meshMode === "rack") {
    // Arc on rack = distance rolled = movingBaseR × phi (for a circle).
    // For NCG gears we still use movingBaseR × phi as the rack displacement
    // and look up the correct gear angle from the moving table.
    const arcLen = movingBaseR * phi;
    const psi    = angleForArcLength(movingTable, arcLen);
    // Screen convention: y increases downward.
    // Rack lies at y = 0. Gear center is ABOVE the rack: y = -movingBaseR.
    // As the gear rolls right, it rotates CW in screen coords → +psi.
    const cx = arcLen;
    const cy = -movingBaseR;
    const penAngleWorld = psi; // CW rotation in screen coords
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
  const Rf     = gearRadius(fixedShape,  fixedBaseR,  fixedEcc,  phi, fixedSides);
  const Rm     = gearRadius(movingShape, movingBaseR, movingEcc, psi, movingSides);

  // ── External mode (epicycloid) ───────────────────────────────────────────
  if (meshMode === "external") {
    const centerDist = Rf + Rm;
    const cx = centerDist * Math.cos(phi);
    const cy = centerDist * Math.sin(phi);
    // For epicycloid: pen angle = phi + psi + π (classical formula)
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
  N = 360
): void {
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const t          = (i / N) * TWO_PI;
    const r          = gearRadius(shape, baseR, ecc, t, sides);
    const worldAngle = t + rotAngle;
    if (i === 0) ctx.moveTo(cx + r * Math.cos(worldAngle), cy + r * Math.sin(worldAngle));
    else         ctx.lineTo(cx + r * Math.cos(worldAngle), cy + r * Math.sin(worldAngle));
  }
  ctx.closePath();
}
