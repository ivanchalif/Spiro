import { evaluateRackRoute, rackOutline } from "./rackRoute";
import { outline, transformOutline, fittingScale, boundaryContact, TOOTH_HEIGHT, type Vertex } from "./contactGeometry";

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
  movingScale: number;
  contactX: number;
  contactY: number;
}

const contourCache = new WeakMap<Float64Array, Map<string, Vertex[]>>();
export function gearContour(
  table: Float64Array, shape: GearShape, radius: number, ecc: number, sides: number,
  profile?: Float64Array | null, teeth = Math.max(4, Math.round(124 * radius / 155)),
): Vertex[] {
  let entries = contourCache.get(table);
  if (!entries) { entries = new Map(); contourCache.set(table, entries); }
  const key = `${shape}:${radius}:${ecc}:${sides}:${teeth}:${identity(profile)}`;
  let points = entries.get(key);
  if (!points) {
    points = outline(a => gearRadius(shape, radius, ecc, a, sides, profile), teeth, shape === "custom" ? 0 : TOOTH_HEIGHT);
    entries.set(key, points);
  }
  return points;
}

const fitCache = new WeakMap<Vertex[], WeakMap<Vertex[], number>>();
function cachedFit(fixed: Vertex[], moving: Vertex[]) {
  let entries = fitCache.get(fixed);
  if (!entries) { entries = new WeakMap(); fitCache.set(fixed, entries); }
  let scale = entries.get(moving);
  if (scale === undefined) { scale = fittingScale(fixed, moving); entries.set(moving, scale); }
  return scale;
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
 *   "rack"     — a closed route along both rack sides and around its endpoints.
 * Complete rendered boundaries determine contact, not radial subtraction.
 * customFixedRTable / customMovingRTable: normalized r(θ) for custom gear shapes.
 */
function solveMeshState(
  phi: number,
  fixedShape: GearShape, fixedBaseR: number, fixedEcc: number,
  fixedTable: Float64Array, fixedSides: number,
  movingShape: GearShape, movingBaseR: number, movingEcc: number,
  movingTable: Float64Array, movingSides: number,
  penOffset: number,
  meshMode: MeshMode = "internal",
  customFixedRTable?: Float64Array | null,
  customMovingRTable?: Float64Array | null,
  rackPathTable?: Float64Array | null,   // curved rack path (from buildRackPathTable)
  movingTeeth = Math.max(4, Math.round(124 * movingBaseR / 155)),
): GearMeshState {
  const moving = gearContour(movingTable, movingShape, movingBaseR, movingEcc, movingSides, customMovingRTable, movingTeeth);
  // ── Rack mode ────────────────────────────────────────────────────────────
  if (meshMode === "rack") {
    const route = evaluateRackRoute(phi, movingBaseR, rackPathTable, customFixedRTable);
    const arcLen = movingBaseR * phi;
    const circumference = totalArcLength(movingTable);
    // Keep complete rotations instead of a modulo angle so endpoint rotations are continuous.
    const psiRolling = Math.floor(arcLen / circumference) * TWO_PI
      + angleForArcLength(movingTable, arcLen);
    const psi = psiRolling + route.heading;
    const dx = (route.centerX - route.contactX) / movingBaseR;
    const dy = (route.centerY - route.contactY) / movingBaseR;
    const contact = boundaryContact(
      rackOutline(movingBaseR, rackPathTable, customFixedRTable),
      transformOutline(moving, psi),
      { x: route.contactX, y: route.contactY }, { x: dx, y: dy }, false,
    );
    const cx = contact.centerX, cy = contact.centerY;
    const d = penOffset * movingBaseR;
    return {
      phi, psi, arcLenFixed: arcLen,
      movingCenterX: cx, movingCenterY: cy,
      penX: cx + d * Math.cos(psi),
      penY: cy + d * Math.sin(psi),
      movingScale: 1, contactX: contact.contactX, contactY: contact.contactY,
    };
  }

  // ── Shared arc-length lookup (internal / external) ───────────────────────
  const arcLen = arcLengthAlongFixed(fixedTable, phi);
  const fixed = gearContour(fixedTable, fixedShape, fixedBaseR, fixedEcc, fixedSides, customFixedRTable, 124);
  const movingScale = meshMode === "internal" ? cachedFit(fixed, moving) : 1;
  const psi = angleForArcLength(movingTable, arcLen / movingScale);
  const penAngleWorld = meshMode === "external" ? phi + psi + Math.PI : phi - psi;
  const contact = boundaryContact(fixed, transformOutline(moving, penAngleWorld, movingScale),
    { x: 0, y: 0 }, { x: Math.cos(phi), y: Math.sin(phi) }, meshMode === "internal");
  const cx = contact.centerX, cy = contact.centerY;
  const d = penOffset * movingBaseR * movingScale;
  return {
    phi, psi, arcLenFixed: arcLen,
    movingCenterX: cx, movingCenterY: cy,
    penX: cx + d * Math.cos(penAngleWorld),
    penY: cy + d * Math.sin(penAngleWorld),
    movingScale, contactX: contact.contactX, contactY: contact.contactY,
  };
}

const poses = new WeakMap<Float64Array, WeakMap<Float64Array, Map<string, GearMeshState>>>();
const identities = new WeakMap<Float64Array, number>();
let nextIdentity = 0;
function identity(table?: Float64Array | null) {
  if (!table) return 0;
  if (!identities.has(table)) identities.set(table, ++nextIdentity);
  return identities.get(table)!;
}

/** Multiple pens and the renderer share a contact pose, not separate solvers. */
export function computeMeshState(...args: Parameters<typeof solveMeshState>): GearMeshState {
  const [phi, fs, fr, fe, ft, fn, ms, mr, me, mt, mn, pen, mode = "internal", cf, cm, rack, teeth] = args;
  let movingCaches = poses.get(ft);
  if (!movingCaches) { movingCaches = new WeakMap(); poses.set(ft, movingCaches); }
  let cache = movingCaches.get(mt);
  if (!cache) { cache = new Map(); movingCaches.set(mt, cache); }
  const key = [phi, fs, fr, fe, fn, ms, mr, me, mn, mode, identity(cf), identity(cm), identity(rack), teeth].join(":");
  let state = cache.get(key);
  if (!state) {
    state = solveMeshState(...args);
    if (cache.size >= 2048) cache.delete(cache.keys().next().value!);
    cache.set(key, state);
  }
  const angle = mode === "rack" ? state.psi : mode === "external" ? phi + state.psi + Math.PI : phi - state.psi;
  const d = pen * mr * state.movingScale;
  return { ...state, penX: state.movingCenterX + d * Math.cos(angle), penY: state.movingCenterY + d * Math.sin(angle) };
}

// ── Rack curve types ─────────────────────────────────────────────────────────
export type RackCurveType = "straight" | "arc" | "wave" | "spiral";

/**
 * buildRackPathTable
 *
 * Builds a lookup table for a curved rack path using the intrinsic-curve
 * representation (tangent angle as a function of arc length).
 *
 * Returns a Float64Array packed as [x0,y0,α0, x1,y1,α1, …] for N+1 samples
 * covering arc lengths 0..totalLen.  At arc length s the gear's contact point
 * is at (x(s), y(s)) and the path tangent angle is α(s).
 *
 * Gear-centre offset and pen position are computed in computeMeshState using
 * the normal direction derived from α.
 */
export function buildRackPathTable(
  curveType: RackCurveType,
  bend: number,     // 0..1, curvature intensity
  totalLen: number, // total arc length of the rack (= movingBaseR * RACK_MAX_PHI)
  N = 600,
): Float64Array {
  const out = new Float64Array((N + 1) * 3);
  // straight or zero bend → degenerate: x=s, y=0, α=0
  if (curveType === "straight" || bend <= 0 || totalLen <= 0) {
    for (let i = 0; i <= N; i++) {
      out[i * 3]     = (i / N) * totalLen;
      out[i * 3 + 1] = 0;
      out[i * 3 + 2] = 0;
    }
    return out;
  }

  // tangent angle α(s) for each curve type
  const getAlpha = (s: number): number => {
    switch (curveType) {
      case "arc": {
        // Constant curvature → circular arc.
        // Total angle = bend * π  (full 180° at bend=1).
        return (bend * Math.PI / totalLen) * s;
      }
      case "wave": {
        // Two oscillations, ±45° maximum. With L=4πR this keeps R|curvature|<1,
        // so the reverse-side offset cannot fold into a cusp.
        return (bend * Math.PI / 4) * Math.sin((TWO_PI * 2 * s) / totalLen);
      }
      case "spiral": {
        // Euler / clothoid: curvature grows linearly → α(s) ∝ s².
        // Produces a spiral-like expanding curve.
        return (bend * TWO_PI / (2 * totalLen)) * s * s / totalLen;
      }
      default: return 0;
    }
  };

  // Numerically integrate path position via Simpson's rule.
  let x = 0, y = 0;
  out[0] = 0; out[1] = 0; out[2] = 0;
  const ds = totalLen / N;
  for (let i = 1; i <= N; i++) {
    const s0 = (i - 1) * ds;
    const s1 = i * ds;
    const sm = (s0 + s1) * 0.5;
    const a0 = getAlpha(s0), am = getAlpha(sm), a1 = getAlpha(s1);
    x += (ds / 6) * (Math.cos(a0) + 4 * Math.cos(am) + Math.cos(a1));
    y += (ds / 6) * (Math.sin(a0) + 4 * Math.sin(am) + Math.sin(a1));
    out[i * 3]     = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = a1;
  }
  return out;
}

/**
 * evalRackPath — interpolate path position and tangent at arc length s.
 * totalLen must match the value used in buildRackPathTable.
 */
export function evalRackPath(
  table: Float64Array,
  s: number,
  totalLen: number,
): { x: number; y: number; alpha: number } {
  const N = (table.length / 3) - 1;
  if (N <= 0 || totalLen <= 0) return { x: s, y: 0, alpha: 0 };
  const sc   = Math.max(0, Math.min(s, totalLen));
  const t    = (sc / totalLen) * N;
  const lo   = Math.min(Math.floor(t), N - 1);
  const hi   = lo + 1;
  const frac = t - lo;
  return {
    x:     table[lo * 3]     * (1 - frac) + table[hi * 3]     * frac,
    y:     table[lo * 3 + 1] * (1 - frac) + table[hi * 3 + 1] * frac,
    alpha: table[lo * 3 + 2] * (1 - frac) + table[hi * 3 + 2] * frac,
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
