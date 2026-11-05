import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildArcLengthTable,
  buildRackPathTable,
  computeMeshState,
  evalRackPath,
  totalArcLength,
  type GearShape,
  type MeshMode,
  type RackCurveType,
} from "@/lib/gearMath";
import { DrawShapeModal } from "@/components/DrawShapeModal";
import { RACK_PERIOD, RACK_SPAN, rackOutline } from "@/lib/rackRoute";
import { evaluateMesh, gearOrientation, computeNestedGear as nestedGear, FixedStepClock, PointRing, type MeshConfig, type NestedState } from "@/lib/simulation";
import { TraceLayer, getCopyColor, type TraceRun } from "@/lib/traceLayer";
import { ControlSlider } from "@/components/ControlSlider";
import { SimulationLayout } from "@/components/SimulationLayout";
import { SAVE_KEY, savedDrawingSchema, type SavedDrawing } from "@/lib/savedDrawing";
import { DrawingActions } from "@/components/DrawingActions";
import { gearPath } from "@/lib/gearPaths";
import { renderNBody } from "@/lib/nbodyRenderer";

const TWO_PI = 2 * Math.PI;
const TABLE_N = 800;
const FIXED_BASE_R = 155;
const FIXED_TEETH  = 124;
const PEN_HOLES = [0.18, 0.32, 0.46, 0.60, 0.74, 0.88];
// Colors assigned to rings 2–5 (ring 1 always uses the user's ink color)
const MULTI_RING_COLORS = ["#f472b6", "#34d399", "#fbbf24", "#a78bfa"];
const RAINBOW_HUE_STEP    = 2;
const RAINBOW_CHUNK_FRAMES = 4;
// Rack mode: 2 full gear rotations visible
const RACK_CYCLES = 2;
const RACK_MAX_PHI = RACK_CYCLES * TWO_PI;

// ─── Gear presets ─────────────────────────────────────────────────────────────
const GEAR_PRESETS = [
  { id: "24", teeth: 24, radius: 30,  color: "#f87171", name: "Mini"     },
  { id: "32", teeth: 32, radius: 40,  color: "#fb923c", name: "Petite"   },
  { id: "40", teeth: 40, radius: 50,  color: "#fbbf24", name: "Small"    },
  { id: "52", teeth: 52, radius: 65,  color: "#34d399", name: "Medium"   },
  { id: "68", teeth: 68, radius: 85,  color: "#60a5fa", name: "Standard" },
  { id: "80", teeth: 80, radius: 100, color: "#a78bfa", name: "Large"    },
  { id: "96", teeth: 96, radius: 120, color: "#f472b6", name: "Max"      },
] as const;

interface GearPreset { id: string; teeth: number; radius: number; color: string; name: string }
const DEFAULT_GEAR_IDX = 4;
const MAX_GEAR_R = GEAR_PRESETS[GEAR_PRESETS.length - 1].radius;

// Build an effective gear object by overriding radius+teeth from a ratio value
function makeEffectiveGear(
  idx: number,
  ratio: number // 0–100, percent of FIXED_BASE_R
): GearPreset {
  const base = GEAR_PRESETS[idx];
  const r = Math.max(10, Math.round(FIXED_BASE_R * ratio / 100));
  const t = Math.max(4, Math.round(FIXED_TEETH * ratio / 100));
  return { ...base, radius: r, teeth: t };
}

type SpeedMode = "partial" | "full" | "accelerated";
const SPEED_DELTAS: Record<SpeedMode, number> = { partial: 0.005, full: 0.018, accelerated: 0.07 };


// ─── 3-Body simulation ────────────────────────────────────────────────────────
interface NBodyState { x: number; y: number; vx: number; vy: number; m: number; }
interface NBodyDeriv  { dx: number; dy: number; dvx: number; dvy: number; }
interface NBodyPresetDef {
  name: string; desc: string; scale: number; dt: number; bodies: NBodyState[];
}

const NBODY_COLORS = ["#f87171", "#60a5fa", "#34d399"] as const;

const NBODY_PRESETS: Record<string, NBodyPresetDef> = {
  figure8: {
    name: "Figure-8", desc: "Stable choreography — all three trace a shared figure-8",
    scale: 190, dt: 0.004,
    bodies: [
      { x: -0.97000436, y:  0.24308753, vx:  0.466203685, vy:  0.43236573, m: 1 },
      { x:  0.97000436, y: -0.24308753, vx:  0.466203685, vy:  0.43236573, m: 1 },
      { x:  0,          y:  0,          vx: -0.93240737,  vy: -0.86473146, m: 1 },
    ],
  },
  lagrange: {
    name: "Lagrange Triangle", desc: "Equal masses at equilateral triangle vertices — stable orbit",
    scale: 200, dt: 0.006,
    bodies: [
      { x:  1,    y:  0,     vx:  0,       vy:  0.7603, m: 1 },
      { x: -0.5,  y:  0.866, vx: -0.6585,  vy: -0.3802, m: 1 },
      { x: -0.5,  y: -0.866, vx:  0.6585,  vy: -0.3802, m: 1 },
    ],
  },
  pythagorean: {
    name: "Pythagorean", desc: "Masses 3-4-5 in right triangle — chaotic, one body escapes",
    scale: 55, dt: 0.003,
    bodies: [
      { x:  1,  y:  3,  vx: 0, vy: 0, m: 3 },
      { x: -2,  y: -1,  vx: 0, vy: 0, m: 4 },
      { x:  1,  y: -1,  vx: 0, vy: 0, m: 5 },
    ],
  },
  butterfly: {
    name: "Butterfly", desc: "Two bodies on figure-8 lobes with a central oscillator",
    scale: 190, dt: 0.004,
    bodies: [
      { x: -1,  y:  0, vx:  0.306893, vy:  0.125507, m: 1 },
      { x:  1,  y:  0, vx:  0.306893, vy:  0.125507, m: 1 },
      { x:  0,  y:  0, vx: -0.613786, vy: -0.251014, m: 1 },
    ],
  },
  binaryguest: {
    name: "Binary + Visitor", desc: "Tight binary pair with a hyperbolic third body",
    scale: 90, dt: 0.005,
    bodies: [
      { x: -0.5, y:  0, vx:  0,   vy:  0.8, m: 1 },
      { x:  0.5, y:  0, vx:  0,   vy: -0.8, m: 1 },
      { x:  0,   y:  3, vx:  0.4, vy: -0.3, m: 0.3 },
    ],
  },
  chaos: {
    name: "Chaos", desc: "Nearly collinear — rapid divergence to chaos",
    scale: 100, dt: 0.003,
    bodies: [
      { x: -1,   y:  0.01, vx: 0.1,  vy:  0.3, m: 1 },
      { x:  0,   y:  0,    vx: 0.1,  vy: -0.5, m: 1.2 },
      { x:  1.1, y: -0.01, vx: -0.2, vy:  0.2, m: 0.8 },
    ],
  },
};

function nbodyDerivs(bodies: NBodyState[]): NBodyDeriv[] {
  const d: NBodyDeriv[] = bodies.map(b => ({ dx: b.vx, dy: b.vy, dvx: 0, dvy: 0 }));
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const ddx = bodies[j].x - bodies[i].x;
      const ddy = bodies[j].y - bodies[i].y;
      const r2  = ddx * ddx + ddy * ddy + 1e-5; // softening
      const r3  = r2 * Math.sqrt(r2);
      const fij = 1 / r3; // G = 1
      d[i].dvx += fij * bodies[j].m * ddx;
      d[i].dvy += fij * bodies[j].m * ddy;
      d[j].dvx -= fij * bodies[i].m * ddx;
      d[j].dvy -= fij * bodies[i].m * ddy;
    }
  }
  return d;
}

function nbodyAddScaled(b: NBodyState[], d: NBodyDeriv[], s: number): NBodyState[] {
  return b.map((body, i) => ({
    ...body,
    x: body.x + s * d[i].dx, y: body.y + s * d[i].dy,
    vx: body.vx + s * d[i].dvx, vy: body.vy + s * d[i].dvy,
  }));
}

function nbodyRK4(bodies: NBodyState[], dt: number): NBodyState[] {
  const k1 = nbodyDerivs(bodies);
  const k2 = nbodyDerivs(nbodyAddScaled(bodies, k1, dt / 2));
  const k3 = nbodyDerivs(nbodyAddScaled(bodies, k2, dt / 2));
  const k4 = nbodyDerivs(nbodyAddScaled(bodies, k3, dt));
  return bodies.map((b, i) => ({
    ...b,
    x:  b.x  + (dt / 6) * (k1[i].dx  + 2 * k2[i].dx  + 2 * k3[i].dx  + k4[i].dx),
    y:  b.y  + (dt / 6) * (k1[i].dy  + 2 * k2[i].dy  + 2 * k3[i].dy  + k4[i].dy),
    vx: b.vx + (dt / 6) * (k1[i].dvx + 2 * k2[i].dvx + 2 * k3[i].dvx + k4[i].dvx),
    vy: b.vy + (dt / 6) * (k1[i].dvy + 2 * k2[i].dvy + 2 * k3[i].dvy + k4[i].dvy),
  }));
}

// ─── Closure period helper ────────────────────────────────────────────────────
// Given arc-length ratio = fixedArc/movingArc, find the denominator q such that
// the spirograph closes after exactly q full phi-cycles (2π each).
// Uses best-rational-approximation (Stern-Brocot / continued fraction).
function closureLoops(ratio: number, maxQ = 300): number {
  let bestQ = 1, bestErr = Infinity;
  for (let q = 1; q <= maxQ; q++) {
    const p = Math.round(ratio * q);
    const err = Math.abs(ratio - p / q);
    if (err < bestErr) { bestErr = err; bestQ = q; }
    if (bestErr < 5e-4) break; // good enough — stop early
  }
  return bestQ;
}

// ─── Scale helper ─────────────────────────────────────────────────────────────
function computeScale(mode: MeshMode, gear: GearPreset, canvasSize: number, rackBounds?: number): number {
  if (mode === "rack") {
    const base = rackBounds && rackBounds > 0 ? rackBounds : gear.radius * RACK_MAX_PHI / 2;
    return (canvasSize * 0.82) / (base * 2);
  }
  if (mode === "external") {
    const maxR = FIXED_BASE_R + 2 * gear.radius;
    return canvasSize / (maxR * 2.3);
  }
  return canvasSize / 380;
}

// ─── Gear icon SVG ────────────────────────────────────────────────────────────
function GearIcon({ gear, selected, iconSize = 56 }: { gear: GearPreset; selected: boolean; iconSize?: number }) {
  const cx = iconSize / 2, cy = iconSize / 2;
  const maxR = iconSize * 0.42;
  const gearR = maxR * (gear.radius / MAX_GEAR_R);
  const toothH = gearR * 0.18;
  const nTeeth = 10, N = nTeeth * 12;
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * TWO_PI;
    const r = gearR + toothH * 0.5 * (1 - Math.cos(t * nTeeth));
    pts.push(`${i === 0 ? "M" : "L"}${(cx + r * Math.cos(t - Math.PI / 2)).toFixed(1)},${(cy + r * Math.sin(t - Math.PI / 2)).toFixed(1)}`);
  }
  pts.push("Z");
  const holes = [0.35, 0.60, 0.82].map((f) => ({
    x: cx + gearR * f * Math.cos(-Math.PI / 2),
    y: cy + gearR * f * Math.sin(-Math.PI / 2),
    r: Math.max(1.5, gearR * 0.08),
  }));
  return (
    <svg width={iconSize} height={iconSize} viewBox={`0 0 ${iconSize} ${iconSize}`}>
      <circle cx={cx} cy={cy} r={maxR * 1.04} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
      <path d={pts.join(" ")} fill={selected ? gear.color + "22" : "rgba(255,255,255,0.04)"}
        stroke={gear.color} strokeWidth={selected ? 1.8 : 1.2} opacity={selected ? 1 : 0.55} />
      {holes.map((h, i) => (
        <circle key={i} cx={h.x} cy={h.y} r={h.r}
          fill="none" stroke={gear.color} strokeWidth="0.8" opacity={selected ? 0.8 : 0.4} />
      ))}
      <circle cx={cx} cy={cy} r={gearR * 0.1} fill={gear.color} opacity={selected ? 0.7 : 0.3} />
      <text x={cx} y={cy + gearR * 0.32} textAnchor="middle"
        fontSize={Math.max(7, gearR * 0.5)} fontWeight="700" fill={gear.color}
        opacity={selected ? 1 : 0.5} fontFamily="monospace">{gear.teeth}</text>
    </svg>
  );
}

// ─── Slider ───────────────────────────────────────────────────────────────────
// ─── Shape + ecc + sides section ─────────────────────────────────────────────
interface GearShapeSectionProps {
  label: string; shape: GearShape; ecc: number; sides: number; disabled?: boolean;
  hasCustomShape?: boolean;
  showDraw?: boolean;
  onShapeChange:  (s: GearShape) => void;
  onEccChange:    (v: number)    => void;
  onEccInput:     (v: number)    => void;
  onSidesChange:  (v: number)    => void;
  onSidesInput:   (v: number)    => void;
  onDrawCustom?:  () => void;
}
function GearShapeSection({ label, shape, ecc, sides, disabled, hasCustomShape, showDraw,
  onShapeChange, onEccChange, onEccInput, onSidesChange, onSidesInput, onDrawCustom,
}: GearShapeSectionProps) {
  const POLYGON_NAMES: Record<number, string> = { 3:"▲ Tri", 4:"■ Sq", 5:"⬠ Pent", 6:"⬡ Hex", 7:"Hept", 8:"Oct" };
  const shapes: GearShape[] = showDraw ? ["circle", "ellipse", "polygon", "custom"] : ["circle", "ellipse", "polygon"];
  return (
    <section className="flex flex-col gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
      <div className="flex gap-1">
        {shapes.map((s) => (
          <button key={s} aria-pressed={shape === s} onClick={() => onShapeChange(s)} disabled={disabled}
            className={["px-2 py-1 rounded text-[10px] font-medium flex-1 border transition-all",
              shape === s ? "bg-primary/14 text-primary border-primary/25"
                : "text-muted-foreground hover:text-foreground border-transparent hover:bg-secondary/50",
              disabled ? "opacity-40 cursor-not-allowed" : ""].join(" ")}>
            {s === "custom" ? "Draw" : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      {shape === "custom" && (
        <button
          onClick={onDrawCustom}
          disabled={disabled}
          className={[
            "w-full py-1.5 rounded text-[10px] font-semibold border transition-all",
            hasCustomShape
              ? "border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
              : "border-primary/30 text-primary hover:bg-primary/10",
            disabled ? "opacity-40 cursor-not-allowed" : "",
          ].join(" ")}
        >
          {hasCustomShape ? "✓ Shape drawn — redraw?" : "Open drawing canvas →"}
        </button>
      )}
      {shape === "polygon" && (
        <div className="flex flex-col gap-2">
          {/* Sides picker — 3-side to 8-side buttons */}
          <div className="flex gap-1">
            {[3, 4, 5, 6, 7, 8].map((n) => (
              <button key={n} aria-pressed={sides === n} onClick={() => onSidesChange(n)} disabled={disabled}
                className={["w-7 h-6 rounded text-[10px] font-bold border transition-all",
                  sides === n ? "bg-primary/14 text-primary border-primary/25"
                    : "text-muted-foreground hover:text-foreground border-transparent hover:bg-secondary/50",
                ].join(" ")}>
                {n}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground/50 leading-tight">
            {POLYGON_NAMES[sides] ?? `${sides}-gon`} ring
          </p>
          <ControlSlider label="Star Depth" value={ecc} min={0.05} max={0.85} step={0.01}
            onChange={onEccChange} onInput={onEccInput} display={(v) => v.toFixed(2)} />
        </div>
      )}
      {shape === "ellipse" && (
        <ControlSlider label="Eccentricity" value={ecc} min={0.05} max={0.85} step={0.01}
          onChange={onEccChange} onInput={onEccInput} display={(v) => v.toFixed(2)} />
      )}
    </section>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function SpirographPage() {
  const [gearIdx,     setGearIdx]     = useState(DEFAULT_GEAR_IDX);
  // Moving gear radius as % of FIXED_BASE_R (20–80). Default ≈ 55 matches Standard preset R85.
  const [gearRatio,   setGearRatio]   = useState(55);
  const [fitScale, setFitScale] = useState(1);
  const [meshMode,    setMeshMode]    = useState<MeshMode>("internal");
  const [fixedShape,  setFixedShape]  = useState<GearShape>("circle");
  const [fixedEcc,    setFixedEcc]    = useState(0.3);
  const [fixedSides,  setFixedSides]  = useState(5);
  const [movingShape, setMovingShape] = useState<GearShape>("circle");
  const [movingEcc,   setMovingEcc]   = useState(0.3);
  const [movingSides, setMovingSides] = useState(5);
  const [nestedEnabled,   setNestedEnabled]   = useState(false);
  const [nestedRatio,     setNestedRatio]     = useState(40);  // % of gear 1 radius (20–70)
  const [nestedSpeed,     setNestedSpeed]     = useState(3);   // integer N (1–8)
  const [nestedPenOffset, setNestedPenOffset] = useState(0.7); // 0–1 of nested gear radius
  const [penMode,     setPenMode]     = useState<"interior" | "circumference">("interior");
  const [penOffset,   setPenOffset]   = useState(0.65);
  const [penCount,    setPenCount]    = useState(1);
  const [rotCopies,   setRotCopies]   = useState(1);
  const [penWeight,   setPenWeight]   = useState(2);
  const [penColor,    setPenColor]    = useState("#60a5fa");
  const [rainbow,     setRainbow]     = useState(true);
  const [compositeMode, setCompositeMode] = useState(false);
  const [speed,       setSpeed]       = useState<SpeedMode>("full");
  const [isPlaying,   setIsPlaying]   = useState(false);
  const [hasTrace,    setHasTrace]    = useState(false);

  // ── 3-Body engine state ──────────────────────────────────────────────────────
  const [drawingEngine, setDrawingEngine] = useState<"spirograph" | "threebody">("spirograph");
  const [nbodyPreset,   setNbodyPreset]   = useState("figure8");
  const [nbodyTrail,    setNbodyTrail]    = useState(1200); // max points per body trail
  const [nbodySteps,    setNbodySteps]    = useState(6);    // RK4 sub-steps per frame

  const effectivePenOffset = penMode === "circumference" ? 1.0 : penOffset;

  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const traceRunsRef  = useRef<TraceRun[]>([]);
  const currentRunRef = useRef<TraceRun | null>(null);
  // Extra runs for rings 2–5 (index 0 = ring 2, etc.)
  const extraRunsRef  = useRef<TraceRun[]>([]);
  const rafRef        = useRef<number | null>(null);
  const nbodyRafRef   = useRef<number | null>(null);
  const traceLayerRef = useRef(new TraceLayer());
  const drawingActionRef = useRef(0);
  const canResumeRef = useRef(false);
  const [canResume, setCanResume] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [notice, setNotice] = useState("");
  const redoRef = useRef<TraceRun[][]>([]);
  const loadingRef = useRef(false);
  const [restoring, setRestoring] = useState(false);
  const [hasSaved, setHasSaved] = useState(() => {
    try { return !!localStorage.getItem(SAVE_KEY); } catch { return false; }
  });
  const hueRef        = useRef(0);
  // 3-body refs
  const nbodyBodiesRef = useRef<NBodyState[]>([]);
  const nbodyTrailsRef = useRef<PointRing[]>([new PointRing(1200), new PointRing(1200), new PointRing(1200)]);
  // Custom shape refs — stable mutable refs so callbacks always see latest
  const customFixedRRef  = useRef<Float64Array | null>(null);
  const customMovingRRef = useRef<Float64Array | null>(null);
  // Rack path table ref (non-linear racks)
  const rackPathTableRef = useRef<Float64Array | null>(null);
  // Custom shape UI state
  const [drawShapeFor,  setDrawShapeFor]  = useState<"fixed" | "moving" | null>(null);
  const [hasCustomFixed,  setHasCustomFixed]  = useState(false);
  const [hasCustomMoving, setHasCustomMoving] = useState(false);
  const [rackAngle,     setRackAngle]     = useState(0);           // degrees, UI only
  const [rackCurveType, setRackCurveType] = useState<RackCurveType>("straight");
  const [rackBend,      setRackBend]      = useState(50);          // 0–100
  // Stable mutable mirrors so zero-dep callbacks always see the latest values
  const rackCurveTypeRef = useRef<RackCurveType>("straight");
  const rackBendRef      = useRef<number>(50);

  const simRef = useRef({
    phi: 0,
    fixedTable:  new Float64Array(TABLE_N + 1) as Float64Array<ArrayBuffer>,
    movingTable: new Float64Array(TABLE_N + 1) as Float64Array<ArrayBuffer>,
    fixedShape:  "circle"   as GearShape,
    fixedEcc:    0.3,
    fixedSides:  5,
    movingShape: "circle"   as GearShape,
    movingEcc:   0.3,
    movingSides: 5,
    meshMode:    "internal" as MeshMode,
    gear:        GEAR_PRESETS[DEFAULT_GEAR_IDX] as GearPreset,
    rackOffX:    0,        // world-space centering offset for rack mode (rotated)
    rackOffY:    0,
    rackAngle:   0,        // rack orientation in radians
    rackHalfLen: 0,        // half the straight-rack span
    // Curved rack extras
    rackPathMidX: 0,       // path midpoint x in pre-rotation rack space
    rackPathMidY: 0,       // path midpoint y in pre-rotation rack space
    rackBounds:   0,       // half-width used for scale computation
    tablesReady: false,
  });

  // ─── Table builder ─────────────────────────────────────────────────────────
  const rebuildTables = useCallback((
    fShape: GearShape, fEcc: number, fSides: number,
    mShape: GearShape, mEcc: number, mSides: number,
    gear: GearPreset, mode: MeshMode,
  ) => {
    const sim = simRef.current;
    sim.fixedTable   = buildArcLengthTable(fShape, FIXED_BASE_R, fEcc, TABLE_N, fSides, customFixedRRef.current);
    sim.movingTable  = buildArcLengthTable(mShape, gear.radius,  mEcc, TABLE_N, mSides, customMovingRRef.current);
    sim.fixedShape   = fShape; sim.fixedEcc   = fEcc; sim.fixedSides  = fSides;
    sim.movingShape  = mShape; sim.movingEcc  = mEcc; sim.movingSides = mSides;
    sim.meshMode     = mode;
    sim.gear         = gear;

    const rackA       = sim.rackAngle;
    const halfRackLen = gear.radius * RACK_MAX_PHI / 2;
    const totalLen    = gear.radius * RACK_MAX_PHI;
    sim.rackHalfLen   = halfRackLen;

    // ── Build curved rack path table when applicable ──────────────────────
    const curveType: RackCurveType = (rackCurveTypeRef.current ?? "straight");
    const bend = (rackBendRef.current ?? 50) / 100; // normalise 0..1

    if (mode === "rack" && curveType !== "straight" && bend > 0) {
      const table = buildRackPathTable(curveType, bend, totalLen, 600);
      rackPathTableRef.current = table;
      // Midpoint of path (at arc length totalLen/2)
      const mid = evalRackPath(table, totalLen / 2, totalLen);
      sim.rackPathMidX = mid.x;
      sim.rackPathMidY = mid.y;
      // Bounding radius: max distance from midpoint over all path points
      const N = (table.length / 3) - 1;
      let maxR = 0;
      for (let i = 0; i <= N; i++) {
        const dx = table[i * 3]     - mid.x;
        const dy = table[i * 3 + 1] - mid.y;
        const r  = Math.sqrt(dx * dx + dy * dy) + gear.radius * 1.5; // +gear clearance
        if (r > maxR) maxR = r;
      }
      sim.rackBounds = Math.max(maxR, halfRackLen * 0.5);
      // Centering offset in world space (rotated midpoint)
      sim.rackOffX = mid.x * Math.cos(rackA) - mid.y * Math.sin(rackA);
      sim.rackOffY = mid.x * Math.sin(rackA) + mid.y * Math.cos(rackA);
    } else {
      // Straight rack — clear table, use linear midpoint
      rackPathTableRef.current = null;
      sim.rackPathMidX = halfRackLen;
      sim.rackPathMidY = 0;
      sim.rackBounds   = halfRackLen + gear.radius * 2.2;
      sim.rackOffX     = halfRackLen * Math.cos(rackA);
      sim.rackOffY     = halfRackLen * Math.sin(rackA);
    }

    sim.tablesReady  = true;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const getCanvasSize = useCallback(() => {
    const c = canvasRef.current;
    return c ? c.width / (Number(c.dataset.dpr) || 1) : 600;
  }, []);

  const meshConfig = useCallback((): MeshConfig => {
    const s = simRef.current;
    return {
      fixedShape: s.fixedShape, fixedRadius: FIXED_BASE_R, fixedEcc: s.fixedEcc, fixedSides: s.fixedSides,
      movingShape: s.movingShape, movingRadius: s.gear.radius, movingEcc: s.movingEcc, movingSides: s.movingSides,
      fixedTable: s.fixedTable, movingTable: s.movingTable, mode: s.meshMode, rackAngle: s.rackAngle, movingTeeth: s.gear.teeth,
      customFixed: customFixedRRef.current, customMoving: customMovingRRef.current, rackPath: rackPathTableRef.current,
    };
  }, []);

  // ─── Core renderer ─────────────────────────────────────────────────────────
  const renderFrame = useCallback((
    phi: number, psi: number,
    mcx: number, mcy: number,
    penX: number, penY: number,
    scale: number,
    curPenColor: string,
    curPenOffset: number,
    extraPens?: { x: number; y: number; color: string }[],
    nested?: NestedState & { r2: number },
    rotCopies = 1,
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.dataset.engine = "spirograph";
    canvas.dataset.phase = String(phi);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sim  = simRef.current;
    const gear = sim.gear;
    const dpr = Number(canvas.dataset.dpr) || 1;
    const W = canvas.width / dpr, H = canvas.height / dpr;
    const cx = W / 2, cy = H / 2;

    // Custom shape tables (mutable refs — always current, no dep needed)
    const customFixedRT  = customFixedRRef.current;
    const customMovingRT = customMovingRRef.current;
    const rackPathT      = rackPathTableRef.current;

    // World-to-screen coordinate offset (rack mode shifts origin)
    const offX = sim.meshMode === "rack" ? sim.rackOffX : 0;
    const offY = sim.meshMode === "rack" ? sim.rackOffY : 0;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // ── Trace runs ───────────────────────────────────────────────────────────
    traceLayerRef.current.draw(ctx, traceRunsRef.current, {
      size: W, scale, offX, offY, dpr, copies: sim.meshMode === "rack" ? 1 : rotCopies,
    });

    // ── Gear geometry setup ──────────────────────────────────────────────────
    const pose = evaluateMesh(phi, curPenOffset, meshConfig());
    setFitScale(pose.movingScale);
    canvas.dataset.fitScale = String(pose.movingScale);
    const fixedR  = FIXED_BASE_R * scale;
    const movingR = gear.radius * pose.movingScale * scale;
    const ringW   = Math.max(5, fixedR * 0.12);
    const toothPitch = (TWO_PI * fixedR) / FIXED_TEETH;
    const toothH  = toothPitch * 0.38;
    const movingTeeth   = gear.teeth;

    // Rotation angle for moving gear body in world frame.
    // Rack: gear rolls right → CW in screen coords → +psi, plus global rack angle.
    const rotAngle = sim.meshMode === "external" ? phi + psi + Math.PI
                   : sim.meshMode === "rack"     ? psi + sim.rackAngle
                   : phi - psi; // internal

    // Moving gear center in screen space
    const mcxS = (mcx - offX) * scale;
    const mcyS = (mcy - offY) * scale;

    ctx.save();
    ctx.translate(cx, cy);

    // ── Fixed gear / rack rendering ──────────────────────────────────────────
    if (sim.meshMode === "rack") {
      // The rounded solid rack uses the very same polygon as contact physics.
      ctx.save(); ctx.rotate(sim.rackAngle);
      ctx.beginPath();
      rackOutline(gear.radius, rackPathT, customFixedRT).forEach((p, i) => {
        const x = (p.x - sim.rackPathMidX) * scale, y = (p.y - sim.rackPathMidY) * scale;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = "rgba(200,215,245,0.10)"; ctx.fill();
      ctx.strokeStyle = "rgba(195,210,255,0.75)"; ctx.lineWidth = 1.3; ctx.stroke();
      ctx.restore();

    } else if (sim.meshMode === "external") {
      // Hub fill and edge use exactly the contact solver's toothed outline.
      const hub = gearPath(sim.fixedShape, fixedR, sim.fixedEcc, sim.fixedSides, FIXED_TEETH, toothH, 1, customFixedRT);
      ctx.fillStyle = "rgba(200, 215, 245, 0.10)";
      ctx.fill(hub);

      // Outward teeth on hub.
      ctx.save();
      ctx.shadowColor = "rgba(160, 175, 255, 0.3)";
      ctx.shadowBlur  = 6;
      ctx.strokeStyle = "rgba(195, 210, 255, 0.70)";
      ctx.lineWidth = 1.3;
      ctx.stroke(hub);
      ctx.restore();

      // Contact point
      ctx.save();
      ctx.shadowColor = "rgba(255,210,80,0.7)";
      ctx.shadowBlur  = 9;
      ctx.beginPath();
      ctx.arc(pose.contactX * scale, pose.contactY * scale, 3.5, 0, TWO_PI);
      ctx.fillStyle = "rgba(255,220,70,0.95)";
      ctx.fill();
      ctx.restore();

    } else {
      // ── INTERNAL RING (evenodd: outer smooth + inner toothed) ──────────────
      const outer = gearPath(sim.fixedShape, fixedR, sim.fixedEcc, sim.fixedSides, FIXED_TEETH, 0, 1, customFixedRT, ringW);
      const inner = gearPath(sim.fixedShape, fixedR, sim.fixedEcc, sim.fixedSides, FIXED_TEETH, toothH, 1, customFixedRT);
      const ring = new Path2D(outer); ring.addPath(inner);
      ctx.fillStyle = "rgba(200, 215, 245, 0.10)";
      ctx.fill(ring, "evenodd");

      // Outer rim
      ctx.save();
      ctx.strokeStyle = "rgba(180, 195, 240, 0.30)";
      ctx.lineWidth = 1; ctx.stroke(outer);
      ctx.restore();

      // Inner edge stroke
      ctx.save();
      ctx.shadowColor = "rgba(160, 175, 255, 0.25)";
      ctx.shadowBlur  = 6;
      ctx.strokeStyle = "rgba(195, 210, 255, 0.70)";
      ctx.lineWidth = 1.3; ctx.stroke(inner);
      ctx.restore();

      // Contact point
      ctx.save();
      ctx.shadowColor = "rgba(255,210,80,0.7)";
      ctx.shadowBlur  = 9;
      ctx.beginPath();
      ctx.arc(pose.contactX * scale, pose.contactY * scale, 3.5, 0, TWO_PI);
      ctx.fillStyle = "rgba(255,220,70,0.95)";
      ctx.fill();
      ctx.restore();

      // Center crosshair
      ctx.strokeStyle = "rgba(160, 180, 230, 0.15)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-fixedR * 0.055, 0); ctx.lineTo(fixedR * 0.055, 0);
      ctx.moveTo(0, -fixedR * 0.055); ctx.lineTo(0, fixedR * 0.055);
      ctx.stroke();
    }

    // ── MOVING GEAR ──────────────────────────────────────────────────────────
    // Fill the actual shape, not a circular disk that can cross its boundary.
    const movingPath = gearPath(sim.movingShape, movingR, sim.movingEcc, sim.movingSides, movingTeeth, toothH * pose.movingScale, 1, customMovingRT);
    ctx.save();
    ctx.translate(mcxS, mcyS); ctx.rotate(rotAngle);
    ctx.fillStyle = gear.color + "18"; ctx.fill(movingPath);
    ctx.shadowColor = gear.color + "88"; ctx.shadowBlur = 8;
    ctx.strokeStyle = gear.color + "ee"; ctx.lineWidth = 1.5;
    ctx.stroke(movingPath);
    ctx.restore();

    // Keep decorative spokes, labels and holes inside noncircular gear material.
    ctx.save(); ctx.translate(mcxS, mcyS); ctx.rotate(rotAngle); ctx.clip(movingPath);
    ctx.rotate(-rotAngle); ctx.translate(-mcxS, -mcyS);
    // Spokes
    const nSpokes = Math.max(3, Math.round(movingTeeth / 22));
    ctx.save();
    ctx.strokeStyle = gear.color + "28"; ctx.lineWidth = 0.9;
    for (let s = 0; s < nSpokes; s++) {
      const sa = rotAngle + (s / nSpokes) * TWO_PI;
      ctx.beginPath();
      ctx.moveTo(mcxS, mcyS);
      ctx.lineTo(mcxS + movingR * 0.86 * Math.cos(sa), mcyS + movingR * 0.86 * Math.sin(sa));
      ctx.stroke();
    }
    ctx.restore();

    // Pen holes
    const holeR = Math.max(2, movingR * 0.052);
    for (const frac of PEN_HOLES) {
      const hr = frac * movingR;
      const hx = mcxS + hr * Math.cos(rotAngle);
      const hy = mcyS + hr * Math.sin(rotAngle);
      const active = Math.abs(frac - curPenOffset) < 0.08;
      ctx.beginPath();
      ctx.arc(hx, hy, holeR, 0, TWO_PI);
      ctx.fillStyle   = active ? gear.color + "44" : gear.color + "18";
      ctx.fill();
      ctx.strokeStyle = gear.color + "99"; ctx.lineWidth = 0.9;
      ctx.stroke();
    }

    // Tooth-count label
    const labelAngle = rotAngle + Math.PI * 0.55;
    const labelR = movingR * 0.48;
    ctx.save();
    ctx.font = `bold ${Math.max(8, movingR * 0.18)}px monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = gear.color + "66";
    ctx.fillText(String(gear.teeth), mcxS + labelR * Math.cos(labelAngle), mcyS + labelR * Math.sin(labelAngle));
    ctx.restore();

    // Hub
    ctx.beginPath();
    ctx.arc(mcxS, mcyS, Math.max(3, movingR * 0.07), 0, TWO_PI);
    ctx.fillStyle = gear.color + "44"; ctx.fill();
    ctx.strokeStyle = gear.color + "bb"; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();

    // Extra pen arms + dots (rings 2–5)
    if (extraPens && extraPens.length > 0) {
      for (const ep of extraPens) {
        const epxS = (ep.x - offX) * scale;
        const epyS = (ep.y - offY) * scale;
        ctx.beginPath();
        ctx.moveTo(mcxS, mcyS);
        ctx.lineTo(epxS, epyS);
        ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1;
        ctx.stroke();
        ctx.save();
        ctx.shadowColor = ep.color + "cc"; ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(epxS, epyS, 3.5, 0, TWO_PI);
        ctx.fillStyle = ep.color; ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 0.9; ctx.stroke();
        ctx.restore();
      }
    }

    // Primary pen arm + dot
    const penDotX = (penX - offX) * scale;
    const penDotY = (penY - offY) * scale;
    ctx.beginPath();
    ctx.moveTo(mcxS, mcyS);
    ctx.lineTo(penDotX, penDotY);
    ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.save();
    ctx.shadowColor = curPenColor + "cc"; ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(penDotX, penDotY, 4.5, 0, TWO_PI);
    ctx.fillStyle = curPenColor; ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();

    // ── NESTED GEAR (gear 2 rolling inside gear 1) ───────────────────────────
    if (nested) {
      const nrS   = nested.r2 * scale;
      const ncxS  = (nested.centerX - offX) * scale;
      const ncyS  = (nested.centerY - offY) * scale;
      const nTeeth = nested.teeth;
      const nToothH = nested.toothHeight * scale;

      ctx.save();
      ctx.translate(ncxS, ncyS); ctx.rotate(nested.theta2);
      const nestedPath = gearPath("circle", nrS, 0, 5, nTeeth, nToothH);
      ctx.fillStyle = "rgba(255, 200, 80, 0.06)"; ctx.fill(nestedPath);
      ctx.shadowColor = "rgba(255, 190, 60, 0.4)";
      ctx.shadowBlur = 6;
      ctx.strokeStyle = "rgba(255, 200, 80, 0.80)";
      ctx.lineWidth = 1.2;
      ctx.stroke(nestedPath);
      ctx.restore();

      // Hub of nested gear
      ctx.beginPath();
      ctx.arc(ncxS, ncyS, Math.max(2, nrS * 0.07), 0, TWO_PI);
      ctx.fillStyle = "rgba(255,200,80,0.4)"; ctx.fill();
      ctx.strokeStyle = "rgba(255,200,80,0.8)"; ctx.lineWidth = 0.9; ctx.stroke();

      // Nested pen arm + dot
      const npxS = (nested.penX - offX) * scale;
      const npyS = (nested.penY - offY) * scale;
      ctx.beginPath();
      ctx.moveTo(ncxS, ncyS);
      ctx.lineTo(npxS, npyS);
      ctx.strokeStyle = "rgba(255,255,255,0.15)"; ctx.lineWidth = 1;
      ctx.stroke();
      ctx.save();
      ctx.shadowColor = "rgba(255,200,60,0.9)"; ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(npxS, npyS, 4, 0, TWO_PI);
      ctx.fillStyle = "rgba(255,210,70,0.95)"; ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 0.9; ctx.stroke();
      ctx.restore();
    }

    ctx.restore(); // translate(cx, cy)
  }, [meshConfig]);

  // ─── Draw idle ──────────────────────────────────────────────────────────────
  const drawIdle = useCallback((
    fShape: GearShape, fEcc: number, fSides: number,
    mShape: GearShape, mEcc: number, mSides: number,
    gear: GearPreset, mode: MeshMode, pOff: number, color: string,
    copies = 1,
  ) => {
    const sim = simRef.current;
    if (!sim.tablesReady) return;
    const canvasSize = getCanvasSize();
    const scale = computeScale(mode, gear, canvasSize, mode === "rack" ? sim.rackBounds : undefined);
    // For rack mode, show gear at centre of its path (phi = halfway along rack)
    const phi0 = mode === "rack" ? RACK_SPAN / 2 : 0;
    const rackPath = rackPathTableRef.current;
    const state = computeMeshState(
      phi0,
      fShape, FIXED_BASE_R, fEcc, sim.fixedTable, fSides,
      mShape, gear.radius,  mEcc, sim.movingTable, mSides,
      pOff, mode,
      customFixedRRef.current, customMovingRRef.current, rackPath, gear.teeth,
    );
    // Apply rack rotation (no bottom-pass mirroring at idle phi0)
    let mcx = state.movingCenterX, mcy = state.movingCenterY;
    let penXr = state.penX, penYr = state.penY;
    if (mode === "rack" && sim.rackAngle !== 0) {
      const cosA = Math.cos(sim.rackAngle), sinA = Math.sin(sim.rackAngle);
      const rx = mcx * cosA - mcy * sinA; mcy = mcx * sinA + mcy * cosA; mcx = rx;
      const rpx = penXr * cosA - penYr * sinA; penYr = penXr * sinA + penYr * cosA; penXr = rpx;
    }
    renderFrame(phi0, state.psi, mcx, mcy, penXr, penYr, scale, color, pOff, undefined, undefined, copies);
  }, [getCanvasSize, renderFrame]);

  // ─── Ghost trace ─────────────────────────────────────────────────────────────
  const drawGhost = useCallback((
    fShape: GearShape, fEcc: number, fSides: number,
    mShape: GearShape, mEcc: number, mSides: number,
    gear: GearPreset, mode: MeshMode, pOff: number, color: string, weight: number,
    rings = 1,
    nestedOn = false, nestedR2 = 0, nestedN = 1, nestedD = 0.7,
    rotCopies = 1,
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sim = simRef.current;
    if (!sim.tablesReady) return;

    const dpr = Number(canvas.dataset.dpr) || 1;
    const W = canvas.width / dpr, H = canvas.height / dpr;
    const canvasSize = Math.min(W, H);
    const scale = computeScale(mode, gear, canvasSize, mode === "rack" ? sim.rackBounds : undefined);
    const cx = W / 2, cy = H / 2;
    const offX = mode === "rack" ? sim.rackOffX : 0;
    const offY = mode === "rack" ? sim.rackOffY : 0;

    const ft = sim.fixedTable, mt = sim.movingTable;
    const ratio = totalArcLength(ft) / totalArcLength(mt);
    const baseLoops = closureLoops(ratio);

    // Preview uses the same closed route and world transform as live drawing.
    const rackPath  = rackPathTableRef.current;
    const totalPhi = mode === "rack"
      ? RACK_PERIOD
      : TWO_PI * (nestedOn ? baseLoops * nestedN : baseLoops);
    const numSteps = nestedOn ? Math.min(2000, 800 * nestedN) : Math.min(2000, baseLoops * 60);

    // idlePhi: at the midpoint of the current rack path
    const idlePhi = mode === "rack" ? RACK_SPAN / 2 : 0;
    const state0 = computeMeshState(
      idlePhi, fShape, FIXED_BASE_R, fEcc, ft, fSides,
      mShape, gear.radius, mEcc, mt, mSides, pOff, mode,
      customFixedRRef.current, customMovingRRef.current, rackPath, gear.teeth,
    );
    // Apply rack rotation to idle frame
    let idle0mcx = state0.movingCenterX, idle0mcy = state0.movingCenterY;
    let idle0px = state0.penX, idle0py = state0.penY;
    if (mode === "rack" && sim.rackAngle !== 0) {
      const cosA = Math.cos(sim.rackAngle), sinA = Math.sin(sim.rackAngle);
      const rx = idle0mcx * cosA - idle0mcy * sinA; idle0mcy = idle0mcx * sinA + idle0mcy * cosA; idle0mcx = rx;
      const rpx = idle0px * cosA - idle0py * sinA; idle0py = idle0px * sinA + idle0py * cosA; idle0px = rpx;
    }
    // Show idle gear frame
    renderFrame(idlePhi, state0.psi, idle0mcx, idle0mcy,
      idle0px, idle0py, scale, color, pOff, undefined, undefined, rotCopies);

    // Ghost trace overlays
    const config = meshConfig();
    const ghostColors = [color, ...MULTI_RING_COLORS];
    const numRings = nestedOn ? 1 : rings;
    const effectiveGhostCopies = Math.max(1, mode === "rack" ? 1 : rotCopies);
    for (let ri = 0; ri < numRings; ri++) {
      const ringOff = ri === 0 ? pOff : pOff * (rings - ri) / rings;
      const ringBaseColor = nestedOn ? "rgba(255,200,70,0.9)" : ghostColors[ri % ghostColors.length];

      // Pre-compute the path points for this ring once, then draw N rotated copies
      const pathPts: { px: number; py: number }[] = [];
      for (let i = 0; i <= numSteps; i++) {
        const ph = (i / numSteps) * totalPhi;
        const st = evaluateMesh(ph, ringOff, config);
        let px: number, py: number;
        if (nestedOn) {
          const ns = nestedGear(ph, gearOrientation(ph, st.psi, mode, sim.rackAngle),
            st.movingCenterX, st.movingCenterY,
            gear.radius, nestedR2, nestedN, nestedD, config, st.movingScale);
          px = cx + (ns.penX - offX) * scale;
          py = cy + (ns.penY - offY) * scale;
        } else {
          px = cx + (st.penX - offX) * scale;
          py = cy + (st.penY - offY) * scale;
        }
        pathPts.push({ px, py });
      }

      for (let ci = 0; ci < effectiveGhostCopies; ci++) {
        const ghostColor = getCopyColor(ci, effectiveGhostCopies, ringBaseColor);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(ci * TWO_PI / effectiveGhostCopies);
        ctx.translate(-cx, -cy);
        ctx.globalAlpha = 0.15;
        ctx.strokeStyle = ghostColor;
        ctx.lineWidth = weight * 0.8;
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.beginPath();
        for (let i = 0; i < pathPts.length; i++) {
          if (i === 0) ctx.moveTo(pathPts[i].px, pathPts[i].py);
          else ctx.lineTo(pathPts[i].px, pathPts[i].py);
        }
        ctx.stroke();
        ctx.restore();
      }
    }
  }, [renderFrame, meshConfig]);

  // Configuration changes start a new stroke; pausing does not change configuration.
  useEffect(() => {
    canResumeRef.current = false; setCanResume(false);
    const gear = makeEffectiveGear(gearIdx, gearRatio);
    rackCurveTypeRef.current = rackCurveType;
    rackBendRef.current = rackBend;
    simRef.current.rackAngle = rackAngle * Math.PI / 180;
    rebuildTables(fixedShape, fixedEcc, fixedSides,
      movingShape, movingEcc, movingSides, gear, meshMode);
  }, [gearIdx, gearRatio, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides,
    rackAngle, rackCurveType, rackBend, rebuildTables]);
  useEffect(() => {
    canResumeRef.current = false; setCanResume(false);
  }, [effectivePenOffset, penColor, penWeight, penCount, rainbow, nestedEnabled, nestedRatio, nestedSpeed, nestedPenOffset]);

  // Coalesce previews from slider/state changes to one paint per browser frame.
  const repaintRef = useRef<() => void>(() => {});
  repaintRef.current = () => {
    if (drawingEngine !== "spirograph") {
      if (!isPlaying && canvasRef.current) renderNBody(canvasRef.current, nbodyBodiesRef.current,
        nbodyTrailsRef.current, NBODY_PRESETS[nbodyPreset].scale);
      return;
    }
    if (isPlaying) return;
    const c = meshConfig();
    if (canResumeRef.current) {
      const state = evaluateMesh(simRef.current.phi, effectivePenOffset, c);
      const nested = nestedEnabled ? {
        ...nestedGear(simRef.current.phi, gearOrientation(simRef.current.phi, state.psi, c.mode, c.rackAngle),
          state.movingCenterX, state.movingCenterY, c.movingRadius, c.movingRadius * nestedRatio / 100,
          nestedSpeed, nestedPenOffset, c, state.movingScale),
      } : undefined;
      renderFrame(simRef.current.phi, state.psi, state.movingCenterX, state.movingCenterY, state.penX, state.penY,
        computeScale(c.mode, simRef.current.gear, getCanvasSize(), simRef.current.rackBounds), penColor, effectivePenOffset,
        undefined, nested, rotCopies);
    } else {
      drawGhost(fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides,
        simRef.current.gear, meshMode, effectivePenOffset, penColor, penWeight, penCount,
        nestedEnabled, c.movingRadius * nestedRatio / 100, nestedSpeed, nestedPenOffset, rotCopies);
    }
  };
  useEffect(() => {
    const id = requestAnimationFrame(() => repaintRef.current());
    return () => cancelAnimationFrame(id);
  }, [isPlaying, drawingEngine, historyVersion, gearIdx, gearRatio, meshMode, fixedShape, fixedEcc, fixedSides,
    movingShape, movingEcc, movingSides, rackAngle, rackCurveType, rackBend, effectivePenOffset, nbodyPreset,
    penColor, penWeight, penCount, rotCopies, nestedEnabled, nestedRatio, nestedSpeed, nestedPenOffset]);

  // ─── Animation loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying || drawingEngine !== "spirograph") {
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      return;
    }
    const sim = simRef.current;
    canResumeRef.current = true; setCanResume(true);
    const delta = SPEED_DELTAS[speed];
    const capGear    = makeEffectiveGear(gearIdx, gearRatio);
    const capMode    = meshMode;
    const capPen     = effectivePenOffset; const capColor = penColor; const capWeight = penWeight;
    const capRainbow = rainbow;     const capComposite = compositeMode;
    const capRings   = penCount;
    const capRotCopies = rotCopies;
    const capNested  = nestedEnabled;
    const capNR2     = capGear.radius * nestedRatio / 100;  // nested gear radius in world units
    const capNN      = nestedSpeed;
    const capND      = nestedPenOffset;
    const config = meshConfig();

    const ratio  = totalArcLength(sim.fixedTable) / totalArcLength(sim.movingTable);
    const baseLoops = closureLoops(ratio);
    const maxPhi = capMode === "rack"
      ? RACK_PERIOD
      : TWO_PI * (capNested ? baseLoops * capNN : baseLoops);

    let frameCount = 0;
    const clock = new FixedStepClock();
    const step = () => {
      const canvasSize = getCanvasSize();
      const scale = computeScale(capMode, capGear, canvasSize, capMode === "rack" ? sim.rackBounds : undefined);

      const state = evaluateMesh(sim.phi, capPen, config);
      const effMcx = state.movingCenterX, effMcy = state.movingCenterY;
      const effPenX = state.penX, effPenY = state.penY, effPsi = state.psi;

      let frameColor = capColor;
      if (capRainbow) {
        hueRef.current = (hueRef.current + RAINBOW_HUE_STEP) % 360;
        frameColor = `hsl(${Math.round(hueRef.current)}, 85%, 62%)`;
        if (frameCount % RAINBOW_CHUNK_FRAMES === 0 && currentRunRef.current) {
          const prev = currentRunRef.current;
          if (prev.points.length > 0) {
            const lastPt = prev.points[prev.points.length - 1];
            const newRun: TraceRun = { points: [lastPt], color: frameColor, weight: capWeight, action: drawingActionRef.current };
            traceRunsRef.current.push(newRun);
            currentRunRef.current = newRun;
          }
        }
      }

      // Nested gear computation (gear 2 rolling inside gear 1)
      let nestedState: (NestedState & { r2: number }) | undefined;
      if (capNested) {
        const rawNested = nestedGear(
          sim.phi, gearOrientation(sim.phi, state.psi, capMode, config.rackAngle),
          effMcx, effMcy,
          capGear.radius, capNR2, capNN, capND, config, state.movingScale,
        );
        nestedState = rawNested;
        currentRunRef.current?.points.push({ x: rawNested.penX, y: rawNested.penY });
      } else {
        currentRunRef.current?.points.push({ x: effPenX, y: effPenY });
      }

      // Extra rings (rings 2–5) — each at a closer offset, inward from the primary
      const extraPens: { x: number; y: number; color: string }[] = [];
      if (!capNested) {
        for (let ri = 0; ri < capRings - 1; ri++) {
          const off = capPen * (capRings - 1 - ri) / capRings;
          const st = evaluateMesh(sim.phi, off, config);
          const ringColor = MULTI_RING_COLORS[ri % MULTI_RING_COLORS.length];
          const rPenX = st.penX, rPenY = st.penY;
          extraRunsRef.current[ri]?.points.push({ x: rPenX, y: rPenY });
          extraPens.push({ x: rPenX, y: rPenY, color: ringColor });
        }
      }

      // Draw once per browser frame, after all fixed simulation substeps.
      const framePhi = sim.phi;
      pendingFrame = () => renderFrame(framePhi, effPsi,
        effMcx, effMcy, effPenX, effPenY, scale, frameColor, capPen, extraPens, nestedState, capRotCopies);

      sim.phi += delta;
      frameCount++;

      if (sim.phi >= maxPhi) {
        if (capComposite || capMode === "rack") {
          // Rack phase remains unwrapped: non-circular gear and nested rotations
          // retain their orientation through the seam. Geometry wraps internally.
          if (capMode !== "rack") sim.phi -= maxPhi;
        } else {
          setIsPlaying(false);
          canResumeRef.current = false; setCanResume(false);
          finished = true;
          return;
        }
      }
      if (frameCount % 120 === 0) {
        const runs = traceRunsRef.current;
        const points = runs.reduce((sum, run) => sum + run.points.length, 0);
        if (runs.length > 512 || points > 80000) {
          // Bound both vector memory and per-frame bookkeeping; keep artwork in an archive.
          const protectedRuns = new Set([currentRunRef.current, ...extraRunsRef.current]);
          const old = runs.filter(run => !protectedRuns.has(run)).slice(0, Math.max(1, runs.length - 256));
          const canvas = canvasRef.current!;
          const view = { size: canvasSize, scale, offX: capMode === "rack" ? sim.rackOffX : 0,
            offY: capMode === "rack" ? sim.rackOffY : 0, dpr: Number(canvas.dataset.dpr) || 1,
            copies: capMode === "rack" ? 1 : capRotCopies };
          traceLayerRef.current.archiveRuns(old, view);
          traceRunsRef.current = runs.filter(run => !old.includes(run));
          // A single continuous pen can itself exceed the budget.
          for (const run of protectedRuns) if (run && run.points.length > 12000) {
            const prefix = { ...run, points: run.points.slice(0, -1) };
            traceLayerRef.current.archiveRuns([prefix], view);
            run.points = run.points.slice(-2);
          }
        }
      }
    };
    let pendingFrame: (() => void) | undefined;
    let finished = false;
    const loop = (timestamp: number) => {
      const count = clock.consume(timestamp);
      for (let i = 0; i < count && !finished; i++) step();
      if (count > 0) pendingFrame?.();
      if (!finished) rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  }, [drawingEngine, isPlaying, speed, gearIdx, gearRatio, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides,
      effectivePenOffset, penOffset, penCount, rotCopies, penColor, penWeight, rainbow, compositeMode,
      nestedEnabled, nestedRatio, nestedSpeed, nestedPenOffset,
      getCanvasSize, renderFrame, meshConfig]);

  // ─── Canvas resize ───────────────────────────────────────────────────────────
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const canvas = canvasRef.current;
      const parent = canvas?.parentElement;
      if (!canvas || !parent) return;
      const rect = parent.getBoundingClientRect();
      const size = Math.max(100, Math.floor(Math.min(rect.width, rect.height)));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const pixels = Math.round(size * dpr);
      if (canvas.width === pixels && canvas.height === pixels) return;
      canvas.width = pixels; canvas.height = pixels;
      canvas.dataset.dpr = String(dpr);
      traceLayerRef.current.invalidate();
      repaintRef.current();
    });
    const parent = canvasRef.current?.parentElement;
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const g   = () => makeEffectiveGear(gearIdx, gearRatio);
  const cur = () => ({ fShape: fixedShape, fEcc: fixedEcc, fSides: fixedSides,
                       mShape: movingShape, mEcc: movingEcc, mSides: movingSides,
                       gear: g(), mode: meshMode });

  // ─── Handlers ────────────────────────────────────────────────────────────────
  const handleGearSelect = (idx: number) => {
    setGearIdx(idx);
    const presetRatio = Math.min(80, Math.max(20, Math.round((GEAR_PRESETS[idx].radius / FIXED_BASE_R) * 100)));
    setGearRatio(presetRatio);
  };

  const handleMeshMode = (mode: MeshMode) => {
    setMeshMode(mode);
    // Reset rack controls when switching away from rack
    if (mode !== "rack") {
      simRef.current.rackAngle = 0;
      setRackAngle(0);
      setRackCurveType("straight");
      rackCurveTypeRef.current = "straight";
      setRackBend(50);
      rackBendRef.current = 50;
      rackPathTableRef.current = null;
    }
    // Reset custom shapes when leaving rack mode — custom only makes sense on the rack
    if (mode !== "rack" && fixedShape === "custom") setFixedShape("circle");
    if (mode !== "rack" && movingShape === "custom") setMovingShape("circle");
  };

  const handleFixedShape = setFixedShape;
  const handleFixedEcc = setFixedEcc;
  const handleFixedSides = setFixedSides;
  const handleMovingShape = setMovingShape;
  const handleMovingEcc = setMovingEcc;
  const handleMovingSides = setMovingSides;
  const handlePenOffset = setPenOffset;

  const handleRackAngle = setRackAngle;
  const handleRackCurveType = setRackCurveType;
  const handleRackBend = setRackBend;

  // ─── Gear ratio slider ────────────────────────────────────────────────────────
  const handleGearRatioInput = setGearRatio;


  // ─── Classic Loops (photo pattern) handler ───────────────────────────────────
  // Replicates the 3-loop epicycloid from the physical spirograph photo:
  // small gear (40T, radius 50) orbiting outside a circular hub, pen at 92%
  const handleClassicLoops = useCallback(() => {
    const fShape: GearShape = "circle";
    const mShape: GearShape = "circle";
    const fEcc   = 0;
    const mEcc   = 0;
    const fSides = 6;
    const mSides = 6;
    const penOff = 0.92;
    const loopGearIdx   = 2; // "Small" preset — 40T, radius 50
    const loopGearRatio = 32; // ~32% of 155 = radius 50 → 40T → exactly 3 loops outside

    setFixedShape(fShape);
    setFixedEcc(fEcc);
    setFixedSides(fSides);
    setMovingShape(mShape);
    setMovingEcc(mEcc);
    setMovingSides(mSides);
    setPenOffset(penOff);
    setGearIdx(loopGearIdx);
    setGearRatio(loopGearRatio);
    setMeshMode("external");
    // Presets always reset rack angle to 0
    simRef.current.rackAngle = 0;
    setRackAngle(0);

    const gear = makeEffectiveGear(loopGearIdx, loopGearRatio);
    rebuildTables(fShape, fEcc, fSides, mShape, mEcc, mSides, gear, "external");
    drawGhost(fShape, fEcc, fSides, mShape, mEcc, mSides, gear, "external", penOff, penColor, penWeight, penCount,
      nestedEnabled, gear.radius * nestedRatio / 100, nestedSpeed, nestedPenOffset, rotCopies);

    simRef.current.phi = 0;
    hueRef.current = 0;
    const startColor = rainbow ? "hsl(0,85%,62%)" : penColor;
    drawingActionRef.current++;
    const newRun: TraceRun = { points: [], color: startColor, weight: penWeight, action: drawingActionRef.current };
    currentRunRef.current = newRun;
    traceRunsRef.current.push(newRun);
    extraRunsRef.current = [];
    for (let ri = 0; ri < penCount - 1; ri++) {
      const ringColor = MULTI_RING_COLORS[ri % MULTI_RING_COLORS.length];
      const extraRun: TraceRun = { points: [], color: ringColor, weight: penWeight, action: drawingActionRef.current };
      extraRunsRef.current.push(extraRun);
      traceRunsRef.current.push(extraRun);
    }
    setHasTrace(true);
    setIsPlaying(true);
  }, [penColor, penWeight, penCount, rotCopies, rainbow, nestedEnabled, nestedRatio, nestedSpeed, nestedPenOffset, rebuildTables, drawGhost]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Randomize handler ───────────────────────────────────────────────────────
  const handleRandomize = useCallback(() => {
    const shapes: GearShape[] = ["circle", "ellipse", "polygon"];
    const rFShape  = shapes[Math.floor(Math.random() * shapes.length)];
    const rFEcc    = parseFloat((0.05 + Math.random() * 0.80).toFixed(2));
    const rFSides  = 3 + Math.floor(Math.random() * 6); // 3–8
    const rMShape  = shapes[Math.floor(Math.random() * shapes.length)];
    const rMEcc    = parseFloat((0.05 + Math.random() * 0.80).toFixed(2));
    const rMSides  = 3 + Math.floor(Math.random() * 6); // 3–8
    const rPenOff  = parseFloat((0.1 + Math.random() * 0.85).toFixed(2));

    setFixedShape(rFShape);
    setFixedEcc(rFEcc);
    setFixedSides(rFSides);
    setMovingShape(rMShape);
    setMovingEcc(rMEcc);
    setMovingSides(rMSides);
    setPenOffset(rPenOff);
    // Presets always reset rack angle to 0
    simRef.current.rackAngle = 0;
    setRackAngle(0);

    const gear = makeEffectiveGear(gearIdx, gearRatio);
    rebuildTables(rFShape, rFEcc, rFSides, rMShape, rMEcc, rMSides, gear, meshMode);
    drawGhost(rFShape, rFEcc, rFSides, rMShape, rMEcc, rMSides, gear, meshMode, rPenOff, penColor, penWeight, penCount,
      nestedEnabled, gear.radius * nestedRatio / 100, nestedSpeed, nestedPenOffset, rotCopies);

    // Auto-play
    simRef.current.phi = 0;
    hueRef.current = 0;
    const startColor = rainbow ? "hsl(0,85%,62%)" : penColor;
    drawingActionRef.current++;
    const newRun: TraceRun = { points: [], color: startColor, weight: penWeight, action: drawingActionRef.current };
    currentRunRef.current = newRun;
    traceRunsRef.current.push(newRun);
    // Extra ring runs
    extraRunsRef.current = [];
    for (let ri = 0; ri < penCount - 1; ri++) {
      const ringColor = MULTI_RING_COLORS[ri % MULTI_RING_COLORS.length];
      const extraRun: TraceRun = { points: [], color: ringColor, weight: penWeight, action: drawingActionRef.current };
      extraRunsRef.current.push(extraRun);
      traceRunsRef.current.push(extraRun);
    }
    setHasTrace(true);
    setIsPlaying(true);
  }, [gearIdx, gearRatio, meshMode, penColor, penWeight, penCount, rotCopies, rainbow, compositeMode, rebuildTables, drawGhost]); // eslint-disable-line react-hooks/exhaustive-deps

  const startPlay = useCallback(() => {
    if (canResumeRef.current) { setIsPlaying(true); return; }
    const gear = makeEffectiveGear(gearIdx, gearRatio);
    rebuildTables(fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides, gear, meshMode);
    simRef.current.phi = 0;
    hueRef.current = 0;
    const startColor = rainbow ? "hsl(0,85%,62%)" : penColor;
    drawingActionRef.current++;
    redoRef.current = [];
    const newRun: TraceRun = { points: [], color: startColor, weight: penWeight, action: drawingActionRef.current };
    currentRunRef.current = newRun;
    traceRunsRef.current.push(newRun);
    // Extra ring runs (rings 2–5)
    extraRunsRef.current = [];
    for (let ri = 0; ri < penCount - 1; ri++) {
      const ringColor = MULTI_RING_COLORS[ri % MULTI_RING_COLORS.length];
      const extraRun: TraceRun = { points: [], color: ringColor, weight: penWeight, action: drawingActionRef.current };
      extraRunsRef.current.push(extraRun);
      traceRunsRef.current.push(extraRun);
    }
    setHasTrace(true);
    canResumeRef.current = true; setCanResume(true);
    setHistoryVersion(v => v + 1);
    setIsPlaying(true);
  }, [gearIdx, gearRatio, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides,
      penColor, penWeight, penCount, rainbow, compositeMode, rebuildTables]);

  // ─── 3-Body animation loop ───────────────────────────────────────────────────
  useEffect(() => {
    if (drawingEngine !== "threebody" || !isPlaying) {
      if (nbodyRafRef.current !== null) {
        cancelAnimationFrame(nbodyRafRef.current); nbodyRafRef.current = null;
      }
      return;
    }

    const preset = NBODY_PRESETS[nbodyPreset];
    const capTrail = nbodyTrail;
    const capSteps = nbodySteps;
    const capDt    = preset.dt;
    const speedFactor = speed === "partial" ? 0.25 : speed === "accelerated" ? 4 : 1;

    // Initialise bodies if empty
    if (nbodyBodiesRef.current.length === 0) {
      nbodyBodiesRef.current = preset.bodies.map(b => ({ ...b }));
      nbodyTrailsRef.current = Array.from({ length: 3 }, () => new PointRing(capTrail));
    }
    nbodyTrailsRef.current = nbodyTrailsRef.current.map(trail => {
      if (trail.capacity === capTrail) return trail;
      const replacement = new PointRing(capTrail);
      for (const point of trail.toArray().slice(-capTrail)) replacement.push(point);
      return replacement;
    });

    const canvas = canvasRef.current;
    if (!canvas) return;

    const clock = new FixedStepClock();
    const loop = (timestamp: number) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // RK4 sub-steps
      const ticks = clock.consume(timestamp);
      for (let tick = 0; tick < ticks; tick++) {
        for (let s = 0; s < capSteps; s++) {
          nbodyBodiesRef.current = nbodyRK4(nbodyBodiesRef.current, capDt * speedFactor);
        }
        for (let i = 0; i < 3; i++) {
          const b = nbodyBodiesRef.current[i];
          nbodyTrailsRef.current[i].push({ x: b.x, y: b.y });
        }
      }

      renderNBody(canvas, nbodyBodiesRef.current, nbodyTrailsRef.current, preset.scale);

      nbodyRafRef.current = requestAnimationFrame(loop);
    };

    nbodyRafRef.current = requestAnimationFrame(loop);
    return () => { if (nbodyRafRef.current !== null) { cancelAnimationFrame(nbodyRafRef.current); nbodyRafRef.current = null; } };
  }, [drawingEngine, isPlaying, nbodyPreset, nbodyTrail, nbodySteps, speed]);

  const stopPlay = useCallback(() => setIsPlaying(false), []);

  const clearAll = useCallback(() => {
    stopPlay();
    traceRunsRef.current = []; currentRunRef.current = null; extraRunsRef.current = [];
    nbodyBodiesRef.current = []; nbodyTrailsRef.current = Array.from({ length: 3 }, () => new PointRing(nbodyTrail));
    traceLayerRef.current.clear();
    redoRef.current = [];
    canResumeRef.current = false; setCanResume(false);
    setHistoryVersion(v => v + 1);
    setRotCopies(1);
    setHasTrace(false);
    if (drawingEngine === "spirograph") {
      setTimeout(() => drawIdle(fixedShape, fixedEcc, fixedSides,
        movingShape, movingEcc, movingSides, makeEffectiveGear(gearIdx, gearRatio), meshMode, effectivePenOffset, penColor, 1), 0);
    } else {
      // Clear canvas for 3-body
      const canvas = canvasRef.current;
      if (canvas) { const ctx = canvas.getContext("2d"); ctx?.clearRect(0, 0, canvas.width, canvas.height); }
    }
  }, [stopPlay, drawingEngine, gearIdx, gearRatio, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides,
      effectivePenOffset, penColor, rotCopies, drawIdle]);

  const undoDrawing = () => {
    const action = traceRunsRef.current.at(-1)?.action;
    if (action === undefined) return;
    const removed = traceRunsRef.current.filter(run => run.action === action);
    redoRef.current.push(removed);
    traceRunsRef.current = traceRunsRef.current.filter(run => run.action !== action);
    currentRunRef.current = null; extraRunsRef.current = [];
    traceLayerRef.current.invalidate();
    canResumeRef.current = false; setCanResume(false);
    setHasTrace(traceRunsRef.current.length > 0 || !!traceLayerRef.current.exportArchive());
    setHistoryVersion(v => v + 1);
  };

  const redoDrawing = () => {
    const restored = redoRef.current.pop();
    if (!restored) return;
    traceRunsRef.current.push(...restored);
    traceLayerRef.current.invalidate();
    setHasTrace(true); setHistoryVersion(v => v + 1);
  };

  const saveDrawing = () => {
    try {
      const saved: SavedDrawing = {
        version: 1,
        settings: { gearIdx, gearRatio, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides,
          rackAngle, rackCurveType, rackBend, penMode, penOffset, penCount, rotCopies, penWeight, penColor, rainbow, compositeMode,
          speed, nestedEnabled, nestedRatio, nestedSpeed, nestedPenOffset, drawingEngine, nbodyPreset: nbodyPreset as SavedDrawing["settings"]["nbodyPreset"],
          nbodyTrail, nbodySteps },
        customFixed: customFixedRRef.current ? Array.from(customFixedRRef.current) : null,
        customMoving: customMovingRRef.current ? Array.from(customMovingRRef.current) : null,
        runs: traceRunsRef.current,
        archive: traceLayerRef.current.exportArchive(),
        bodies: nbodyBodiesRef.current,
        trails: nbodyTrailsRef.current.map(trail => trail.toArray()),
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(savedDrawingSchema.parse(saved)));
      setHasSaved(true); setNotice("Drawing and settings saved on this browser.");
    } catch {
      setNotice("Could not save locally. Browser storage may be full or unavailable; export a PNG instead.");
    }
  };

  const restoreDrawing = async () => {
    if (loadingRef.current) return;
    if (hasTrace && !window.confirm("Replace the current artwork with your saved drawing?")) return;
    try {
      const saved = savedDrawingSchema.parse(JSON.parse(localStorage.getItem(SAVE_KEY) || "null"));
      loadingRef.current = true;
      setRestoring(true);
      await traceLayerRef.current.restoreArchive(saved.archive);
      const s = saved.settings;
      setGearIdx(s.gearIdx); setGearRatio(s.gearRatio); setMeshMode(s.meshMode);
      setFixedShape(s.fixedShape); setFixedEcc(s.fixedEcc); setFixedSides(s.fixedSides);
      setMovingShape(s.movingShape); setMovingEcc(s.movingEcc); setMovingSides(s.movingSides);
      setRackAngle(s.rackAngle); setRackCurveType(s.rackCurveType); setRackBend(s.rackBend);
      setPenMode(s.penMode); setPenOffset(s.penOffset); setPenCount(s.penCount); setPenWeight(s.penWeight);
      setRotCopies(s.rotCopies);
      setPenColor(s.penColor); setRainbow(s.rainbow); setCompositeMode(s.compositeMode); setSpeed(s.speed);
      setNestedEnabled(s.nestedEnabled); setNestedRatio(s.nestedRatio); setNestedSpeed(s.nestedSpeed); setNestedPenOffset(s.nestedPenOffset);
      setDrawingEngine(s.drawingEngine); setNbodyPreset(s.nbodyPreset); setNbodyTrail(s.nbodyTrail); setNbodySteps(s.nbodySteps);
      customFixedRRef.current = saved.customFixed ? new Float64Array(saved.customFixed) : null;
      customMovingRRef.current = saved.customMoving ? new Float64Array(saved.customMoving) : null;
      rackCurveTypeRef.current = s.rackCurveType; rackBendRef.current = s.rackBend;
      simRef.current.rackAngle = s.rackAngle * Math.PI / 180;
      rebuildTables(s.fixedShape, s.fixedEcc, s.fixedSides, s.movingShape, s.movingEcc, s.movingSides,
        makeEffectiveGear(s.gearIdx, s.gearRatio), s.meshMode);
      setHasCustomFixed(!!saved.customFixed); setHasCustomMoving(!!saved.customMoving);
      nbodyBodiesRef.current = saved.bodies;
      nbodyTrailsRef.current = saved.trails.map(points => {
        const trail = new PointRing(s.nbodyTrail);
        for (const point of points) trail.push(point);
        return trail;
      });
      traceRunsRef.current = saved.runs; redoRef.current = [];
      drawingActionRef.current = Math.max(0, ...saved.runs.map(run => run.action ?? 0));
      currentRunRef.current = null; extraRunsRef.current = [];
      canResumeRef.current = false; setCanResume(false);
      setHasTrace(saved.runs.length > 0 || !!saved.archive || saved.bodies.length > 0);
      setHistoryVersion(v => v + 1);
      setNotice("Saved drawing restored. Start a new stroke to continue.");
    } catch {
      setNotice("The saved drawing could not be read. Your current settings and artwork have not been replaced.");
    } finally { loadingRef.current = false; setRestoring(false); }
  };

  const exportPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const image = document.createElement("canvas");
    image.width = image.height = canvas.width;
    const ctx = image.getContext("2d")!;
    ctx.fillStyle = "#0e1015"; ctx.fillRect(0, 0, image.width, image.height);
    if (drawingEngine === "spirograph") {
      const sim = simRef.current, size = getCanvasSize(), dpr = Number(canvas.dataset.dpr) || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      traceLayerRef.current.draw(ctx, traceRunsRef.current, {
        size, dpr, scale: computeScale(meshMode, sim.gear, size, sim.rackBounds),
        offX: meshMode === "rack" ? sim.rackOffX : 0, offY: meshMode === "rack" ? sim.rackOffY : 0,
        copies: meshMode === "rack" ? 1 : rotCopies,
      });
    } else ctx.drawImage(canvas, 0, 0);
    image.toBlob(blob => {
      if (!blob) { setNotice("PNG export failed. Please try again."); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = "spirograph.png"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("PNG exported.");
    }, "image/png");
  };

  // ─── Custom shape handler ─────────────────────────────────────────────────
  const handleDrawDone = useCallback((table: Float64Array) => {
    if (drawShapeFor === "fixed") {
      customFixedRRef.current = table;
      setHasCustomFixed(true);
      setFixedShape("custom");
      const c = cur();
      rebuildTables("custom", c.fEcc, c.fSides, c.mShape, c.mEcc, c.mSides, c.gear, c.mode);
      if (!isPlaying) drawGhost("custom", c.fEcc, c.fSides, c.mShape, c.mEcc, c.mSides, c.gear, c.mode,
        effectivePenOffset, penColor, penWeight, penCount,
        nestedEnabled, c.gear.radius * nestedRatio / 100, nestedSpeed, nestedPenOffset, rotCopies);
    } else if (drawShapeFor === "moving") {
      customMovingRRef.current = table;
      setHasCustomMoving(true);
      setMovingShape("custom");
      const c = cur();
      rebuildTables(c.fShape, c.fEcc, c.fSides, "custom", c.mEcc, c.mSides, c.gear, c.mode);
      if (!isPlaying) drawGhost(c.fShape, c.fEcc, c.fSides, "custom", c.mEcc, c.mSides, c.gear, c.mode,
        effectivePenOffset, penColor, penWeight, penCount,
        nestedEnabled, c.gear.radius * nestedRatio / 100, nestedSpeed, nestedPenOffset, rotCopies);
    }
    setDrawShapeFor(null);
  }, [drawShapeFor, isPlaying, cur, rebuildTables, drawGhost, effectivePenOffset, penColor, penWeight, penCount, nestedEnabled, nestedRatio, nestedSpeed, nestedPenOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedGear = GEAR_PRESETS[gearIdx];
  const computedGear = makeEffectiveGear(gearIdx, gearRatio);

  const MESH_OPTIONS: { mode: MeshMode; label: string; title: string }[] = [
    { mode: "internal", label: "Ring",   title: "Hypocycloid — gear inside the ring" },
    { mode: "external", label: "Orbit",  title: "Epicycloid — gear orbits outside a hub" },
    { mode: "rack",     label: "Rack",   title: "Trochoid — gear rolls along a straight bar" },
  ];

  return (
    <SimulationLayout sidebar={<>
      <fieldset disabled={isPlaying || restoring} className="contents">

        {/* Header */}
        <div className="px-4 pt-3.5 pb-3 border-b border-border flex items-center gap-2 shrink-0">
          <div className="w-6 h-6 rounded-full bg-primary/15 border border-primary/20 flex items-center justify-center shrink-0">
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="9" className="stroke-primary/40" />
              <circle cx="12" cy="12" r="5" className="stroke-primary/70" />
              <circle cx="12" cy="12" r="1.5" className="fill-primary stroke-none" />
            </svg>
          </div>
          <h1 className="text-[11px] font-semibold tracking-tight leading-none">Spirograph NCG</h1>
        </div>

        <div className="flex flex-col gap-3 px-3 py-3 flex-1">

          {/* ── Engine toggle ──────────────────────────────────── */}
          <div className="flex gap-1">
            {(["spirograph", "threebody"] as const).map((eng) => (
              <button key={eng} disabled={isPlaying}
                aria-pressed={drawingEngine === eng}
                onClick={() => { if (eng !== drawingEngine) { stopPlay(); setDrawingEngine(eng); canResumeRef.current = false; setCanResume(false); } }}
                className={["flex-1 py-1.5 rounded text-[10px] font-semibold border transition-all",
                  drawingEngine === eng
                    ? "bg-primary/14 text-primary border-primary/25"
                    : "text-muted-foreground hover:text-foreground border-transparent hover:bg-secondary/50",
                  isPlaying ? "opacity-40 cursor-not-allowed" : "",
                ].join(" ")}>
                {eng === "spirograph" ? "Spirograph" : "3-Body"}
              </button>
            ))}
          </div>

          <div className="border-t border-border/40" />

          {/* ═══════════ 3-BODY CONTROLS ═══════════ */}
          {drawingEngine === "threebody" && (<>

            <section className="flex flex-col gap-1.5">
              <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Preset</p>
              <div className="flex flex-col gap-0.5">
                {Object.entries(NBODY_PRESETS).map(([key, p]) => (
                  <button key={key} disabled={isPlaying}
                    aria-pressed={nbodyPreset === key}
                    onClick={() => { setNbodyPreset(key); nbodyBodiesRef.current = []; nbodyTrailsRef.current = Array.from({ length: 3 }, () => new PointRing(nbodyTrail)); canResumeRef.current = false; setCanResume(false); }}
                    className={["w-full text-left px-2 py-1.5 rounded text-[10px] border transition-all",
                      nbodyPreset === key
                        ? "bg-primary/14 text-primary border-primary/25"
                        : "text-muted-foreground hover:text-foreground border-transparent hover:bg-secondary/50",
                      isPlaying ? "opacity-40 cursor-not-allowed" : "",
                    ].join(" ")}>
                    <span className="font-semibold">{p.name}</span>
                    <span className="opacity-50 ml-1 text-[9px]">— {p.desc}</span>
                  </button>
                ))}
              </div>
            </section>

            <div className="border-t border-border/40" />

            <div className="flex items-center gap-3">
              <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground shrink-0">Bodies</p>
              {NBODY_COLORS.map((col, i) => (
                <div key={i} className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full border border-white/20" style={{ background: col }} />
                  <span className="text-[10px] text-muted-foreground">{["α","β","γ"][i]}</span>
                </div>
              ))}
            </div>

            <div className="border-t border-border/40" />

            <div className="flex flex-col gap-1.5">
              <ControlSlider label="Trail" value={nbodyTrail} min={100} max={4000} step={100}
                onChange={setNbodyTrail} display={(v) => `${v} pts`} />
              <ControlSlider label="Speed" value={nbodySteps} min={1} max={20} step={1}
                onChange={setNbodySteps} display={(v) => `${v}×`} />
            </div>

            <button onClick={clearAll}
              className="w-full px-3 py-1.5 rounded text-[10px] font-medium border border-border text-muted-foreground hover:text-foreground transition-colors">
              Reset Simulation
            </button>

          </>)}

          {/* ═══════════ SPIROGRAPH CONTROLS ═══════════ */}
          {drawingEngine === "spirograph" && (<>

          {/* Mode + Presets row */}
          <div className="flex flex-col gap-2">
            <div className="flex gap-1">
              {MESH_OPTIONS.map(({ mode, label, title }) => (
                <button key={mode} aria-pressed={meshMode === mode} onClick={() => handleMeshMode(mode)} title={title} disabled={isPlaying}
                  className={["flex-1 py-1.5 rounded text-[10px] font-semibold border transition-all",
                    meshMode === mode
                      ? "bg-primary/14 text-primary border-primary/25"
                      : "text-muted-foreground hover:text-foreground border-transparent hover:bg-secondary/50",
                    isPlaying ? "opacity-40 cursor-not-allowed" : "",
                  ].join(" ")}>
                  {label}
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              <button onClick={handleRandomize} disabled={isPlaying}
                className={["flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-[10px] font-semibold border transition-all",
                  isPlaying ? "opacity-40 cursor-not-allowed border-border text-muted-foreground"
                    : "border-primary/30 text-primary hover:bg-primary/10 active:scale-95"].join(" ")}>
                <svg viewBox="0 0 24 24" className="w-3 h-3 fill-current shrink-0">
                  <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                </svg>
                Surprise
              </button>
              <button onClick={handleClassicLoops} disabled={isPlaying}
                className={["flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-[10px] font-semibold border transition-all",
                  isPlaying ? "opacity-40 cursor-not-allowed border-border text-muted-foreground"
                    : "border-amber-500/40 text-amber-400 hover:bg-amber-500/10 active:scale-95"].join(" ")}>
                <svg viewBox="0 0 24 24" className="w-3 h-3 fill-none stroke-current shrink-0" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" /><circle cx="12" cy="5" r="2" />
                  <circle cx="18" cy="15.5" r="2" /><circle cx="6" cy="15.5" r="2" />
                </svg>
                Classic
              </button>
            </div>
          </div>

          <div className="border-t border-border/40" />

          {/* ── Gear Tray ────────────────────────────────────── */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Inner Gear</p>
              <span className="text-[9px] text-muted-foreground/50">{selectedGear.teeth}T · {selectedGear.name}</span>
            </div>
            <div className="grid grid-cols-4 gap-1 p-1.5 rounded-lg border border-border bg-background/40">
              {GEAR_PRESETS.map((gear, idx) => (
                <button key={gear.id} aria-pressed={gearIdx === idx} aria-label={`${gear.name} gear, ${gear.teeth} teeth`} onClick={() => handleGearSelect(idx)}
                  title={`${gear.teeth}T — ${gear.name}`}
                  className={["flex items-center justify-center p-0.5 rounded transition-all duration-150",
                    idx === gearIdx ? "bg-white/6" : "hover:bg-white/4"].join(" ")}
                  style={idx === gearIdx ? { outline: `1.5px solid ${gear.color}55`, outlineOffset: "1px" } : undefined}>
                  <GearIcon gear={gear} selected={idx === gearIdx} iconSize={36} />
                </button>
              ))}
              <div className="flex items-center justify-center opacity-20">
                <svg width="36" height="36" viewBox="0 0 44 44">
                  <circle cx="22" cy="22" r="18" fill="none" stroke="white" strokeWidth="1" strokeDasharray="3 3" />
                </svg>
              </div>
            </div>
            <ControlSlider label="Ratio" value={gearRatio} min={20} max={80} step={1}
              onChange={handleGearRatioInput} onInput={handleGearRatioInput}
              display={(v) => `${v}% · R${computedGear.radius}`} />
            {fitScale < 0.999 && meshMode === "internal" && (
              <p role="status" className="text-xs text-amber-200/80">
                Auto-fit: gear reduced to {Math.round(fitScale * 100)}% of its requested size so it fits throughout rotation.
              </p>
            )}
            {nestedEnabled && <p className="text-xs text-muted-foreground">Nested gears are also auto-fitted to stay inside their parent shape.</p>}
            {meshMode === "rack" && (<>
              <ControlSlider label="Angle" value={rackAngle} min={0} max={360} step={1}
                onChange={handleRackAngle} onInput={handleRackAngle}
                display={(v) => `${v}°`} />
              {/* Curve type picker */}
              <div className="flex flex-col gap-1">
                <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Path Shape</span>
                <div className="grid grid-cols-4 gap-0.5">
                  {([
                    { id: "straight", label: "Line" },
                    { id: "arc",      label: "Arc"  },
                    { id: "wave",     label: "Wave" },
                    { id: "spiral",   label: "Spiral" },
                  ] as { id: RackCurveType; label: string }[]).map(({ id, label }) => (
                    <button key={id} aria-pressed={rackCurveType === id} title={id === "spiral" ? "Euler spiral / clothoid" : undefined} onClick={() => handleRackCurveType(id)} disabled={isPlaying}
                      className={["py-1 rounded text-[9px] font-semibold border transition-all",
                        rackCurveType === id
                          ? "bg-primary/14 text-primary border-primary/30"
                          : "text-muted-foreground hover:text-foreground border-transparent hover:bg-secondary/50",
                        isPlaying ? "opacity-40 cursor-not-allowed" : "",
                      ].join(" ")}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {rackCurveType !== "straight" && (
                <ControlSlider label="Bend" value={rackBend} min={0} max={100} step={1}
                  onChange={handleRackBend} onInput={handleRackBend}
                  display={(v) => `${v}%`} />
              )}
            </>)}
          </div>

          <div className="border-t border-border/40" />

          {/* ── Gear Shapes ──────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            {/* Outer gear shape */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0" />
                <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Outer Ring</p>
              </div>
              <GearShapeSection
                label="" shape={fixedShape} ecc={fixedEcc} sides={fixedSides} disabled={isPlaying}
                hasCustomShape={hasCustomFixed} showDraw={meshMode === "rack"}
                onShapeChange={handleFixedShape} onEccChange={handleFixedEcc} onEccInput={handleFixedEcc}
                onSidesChange={handleFixedSides} onSidesInput={handleFixedSides}
                onDrawCustom={() => setDrawShapeFor("fixed")}
              />
            </div>
            {/* Inner gear shape */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-teal-400/60 shrink-0" />
                <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Inner Gear</p>
              </div>
              <GearShapeSection
                label="" shape={movingShape} ecc={movingEcc} sides={movingSides} disabled={isPlaying}
                hasCustomShape={hasCustomMoving}
                onShapeChange={handleMovingShape} onEccChange={handleMovingEcc} onEccInput={handleMovingEcc}
                onSidesChange={handleMovingSides} onSidesInput={handleMovingSides}
              />
            </div>
          </div>

          <div className="border-t border-border/40" />

          {/* ── Pen ──────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Pen</p>

            {/* Position mode */}
            <div className="flex gap-1">
              {(["interior", "circumference"] as const).map((m) => (
                <button key={m} aria-pressed={penMode === m} onClick={() => setPenMode(m)} disabled={isPlaying}
                  className={["flex-1 h-6 rounded text-[10px] font-semibold border transition-all",
                    penMode === m ? "bg-primary/14 text-primary border-primary/25"
                      : "text-muted-foreground hover:text-foreground border-transparent hover:bg-secondary/50",
                    isPlaying ? "opacity-40 cursor-not-allowed" : "",
                  ].join(" ")}>
                  {m === "interior" ? "Interior" : "Edge"}
                </button>
              ))}
            </div>

            {penMode === "interior" && (
              <ControlSlider label="Offset" value={penOffset} min={0.01} max={0.99} step={0.01}
                onChange={(v) => setPenOffset(v)} onInput={handlePenOffset}
                display={(v) => `${Math.round(v * 100)}%`} />
            )}

            {/* Rings */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground shrink-0 w-10">Pens</span>
              <div className="flex gap-0.5 flex-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} aria-pressed={penCount === n} aria-label={`${n} ${n === 1 ? "pen" : "pens"}`} onClick={() => setPenCount(n)} disabled={isPlaying}
                    className={["flex-1 h-6 rounded text-[10px] font-bold border transition-all",
                      penCount === n ? "bg-primary/14 text-primary border-primary/25"
                        : "text-muted-foreground hover:text-foreground border-transparent hover:bg-secondary/50",
                      isPlaying ? "opacity-40 cursor-not-allowed" : "",
                    ].join(" ")}>
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <ControlSlider label="Copies" value={rotCopies} min={1} max={12} step={1}
              onChange={setRotCopies}
              display={(v) => v === 1 ? "off" : `×${v}`} />

            <ControlSlider label="Weight" value={penWeight} min={0.5} max={10} step={0.5}
              onChange={(v) => setPenWeight(v)} display={(v) => `${v}px`} />

            {/* Color */}
            <div className="flex items-center gap-2">
              <label className={["relative w-7 h-7 cursor-pointer shrink-0 transition-opacity",
                rainbow ? "opacity-30 pointer-events-none" : ""].join(" ")}>
                <input type="color" aria-label="Custom ink color" disabled={rainbow} value={penColor} onChange={(e) => setPenColor(e.target.value)}
                  className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
                <span className="absolute inset-0 rounded-full border-2 border-white/20" style={{ background: penColor }} />
              </label>
              <div className={["flex flex-wrap gap-1 flex-1 transition-opacity",
                rainbow ? "opacity-30 pointer-events-none" : ""].join(" ")}>
                {GEAR_PRESETS.map((gear) => (
                  <button key={gear.id} disabled={rainbow} aria-label={`${gear.name} ink color`} aria-pressed={penColor === gear.color} onClick={() => setPenColor(gear.color)} title={gear.name}
                    className="w-4 h-4 rounded-full border transition-all hover:scale-110"
                    style={{
                      background: gear.color,
                      borderColor: penColor === gear.color ? gear.color : "rgba(255,255,255,0.1)",
                      boxShadow: penColor === gear.color ? `0 0 0 2px rgba(0,0,0,0.5),0 0 0 3px ${gear.color}` : undefined,
                    }} />
                ))}
              </div>
              <button onClick={() => setRainbow((v) => !v)}
                className={["shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-bold border transition-all",
                  rainbow ? "border-transparent text-white" : "border-border text-muted-foreground hover:text-foreground"].join(" ")}
                style={rainbow ? { background: "linear-gradient(90deg,#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f472b6)" } : undefined}
                title="Rainbow mode">
                ~
              </button>
            </div>
          </div>

          <div className="border-t border-border/40" />

          {/* ── Nested Gear ──────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Nested Gear</p>
              <button onClick={() => setNestedEnabled((v) => !v)} disabled={isPlaying}
                className={["relative inline-flex h-4 w-8 shrink-0 items-center rounded-full transition-colors",
                  nestedEnabled ? "bg-amber-500" : "bg-secondary",
                  isPlaying ? "opacity-40 cursor-not-allowed" : ""].join(" ")}>
                <span className={["inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform",
                  nestedEnabled ? "translate-x-4" : "translate-x-0.5"].join(" ")} />
              </button>
            </div>
            {nestedEnabled && (
              <div className={["flex flex-col gap-1.5 pl-2 border-l-2 border-amber-500/30",
                isPlaying ? "opacity-40 pointer-events-none" : ""].join(" ")}>
                <ControlSlider label="Size" value={nestedRatio} min={15} max={70} step={1}
                  onChange={(v) => setNestedRatio(v)} onInput={(v) => setNestedRatio(v)}
                  display={(v) => `${Math.round(v)}%`} />
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground shrink-0 w-10">Speed</span>
                  <div className="flex gap-0.5 flex-1">
                    {[1,2,3,4,5,6,7,8].map((n) => (
                  <button key={n} aria-pressed={nestedSpeed === n} onClick={() => setNestedSpeed(n)} disabled={isPlaying}
                        className={["flex-1 h-5 rounded text-[9px] font-bold border transition-all",
                          nestedSpeed === n ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                            : "text-muted-foreground hover:text-foreground border-transparent hover:bg-secondary/50",
                        ].join(" ")}>
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <ControlSlider label="Reach" value={nestedPenOffset} min={0.1} max={1} step={0.05}
                  onChange={(v) => setNestedPenOffset(v)} onInput={(v) => setNestedPenOffset(v)}
                  display={(v) => `${Math.round(v * 100)}%`} />
              </div>
            )}
          </div>

          {/* ── Composite + Clear ────────────────────────────── */}
          <div className="flex items-center gap-2 mt-auto pt-1">
            <div className="flex items-center gap-1.5 flex-1">
              <button role="switch" aria-checked={compositeMode} aria-label="Composite drawing" onClick={() => setCompositeMode((v) => !v)}
                className={["relative inline-flex h-4 w-8 shrink-0 items-center rounded-full transition-colors",
                  compositeMode ? "bg-primary" : "bg-secondary"].join(" ")}>
                <span className={["inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform",
                  compositeMode ? "translate-x-4" : "translate-x-0.5"].join(" ")} />
              </button>
              <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Composite</span>
            </div>
            <button onClick={undoDrawing} disabled={isPlaying || traceRunsRef.current.length === 0}
              title="Remove last drawn pass"
              className="px-2.5 py-1 rounded text-[10px] font-medium border border-border text-muted-foreground hover:text-foreground hover:border-foreground/25 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
              Undo
            </button>
            <button onClick={clearAll} disabled={!hasTrace}
              className="px-2.5 py-1 rounded text-[10px] font-medium border border-border text-muted-foreground hover:text-foreground hover:border-foreground/25 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
              Clear
            </button>
          </div>

          </>)}

        </div>
      </fieldset>
      <DrawingActions playing={isPlaying || restoring} hasDrawing={hasTrace} hasSaved={hasSaved}
        canUndo={drawingEngine === "spirograph" && traceRunsRef.current.length > 0}
        canRedo={redoRef.current.length > 0}
        onUndo={undoDrawing} onRedo={redoDrawing} onSave={saveDrawing} onRestore={() => void restoreDrawing()} onExport={exportPng}
        onNew={() => {
          if (drawingEngine === "threebody") {
            nbodyBodiesRef.current = [];
            nbodyTrailsRef.current = Array.from({ length: 3 }, () => new PointRing(nbodyTrail));
            canResumeRef.current = true; setCanResume(true); setHasTrace(true); setIsPlaying(true);
          } else { canResumeRef.current = false; setCanResume(false); startPlay(); }
        }}
        notice={notice} />
      </>}>

      {/* ── Stage ── */}
      <div className="w-full h-full min-w-0 flex flex-col items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none" style={{
          backgroundImage: `
            radial-gradient(circle at 50% 50%, rgba(124,101,245,0.04) 0%, transparent 70%),
            linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.018) 1px, transparent 1px)
          `,
          backgroundSize: "100% 100%, 40px 40px, 40px 40px",
        }} />

        <div className="relative"
          style={{ width: "min(100%, calc(100dvh - 180px))", maxWidth: "calc(100% - 24px)", aspectRatio: "1 / 1" }}>
          <canvas ref={canvasRef} aria-label="Spirograph drawing and live simulation" role="img" width={600} height={600} className="absolute inset-0 w-full h-full" />
        </div>

        {/* Playback controller */}
        <div className="absolute bottom-7 left-1/2 -translate-x-1/2 z-10">
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-2xl border border-border bg-card/85 backdrop-blur-md shadow-2xl">
            <button disabled={restoring} aria-label={isPlaying ? "Pause drawing" : canResume ? "Resume drawing" : "Start drawing"}
              onClick={isPlaying ? stopPlay : (drawingEngine === "threebody" ? () => { canResumeRef.current = true; setCanResume(true); setHasTrace(true); setIsPlaying(true); } : startPlay)}
              className="w-10 h-10 rounded-xl flex items-center justify-center bg-primary text-primary-foreground shadow-lg hover:brightness-110 active:scale-95 transition-all duration-100">
              {isPlaying ? (
                <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current ml-0.5">
                  <path d="M8 5.14v14l11-7-11-7z" />
                </svg>
              )}
            </button>

            <div className="w-px h-6 bg-border mx-0.5" />

            {(["partial", "full", "accelerated"] as SpeedMode[]).map((mode) => {
              const labels: Record<SpeedMode, string> = { partial: "¼×", full: "1×", accelerated: "4×" };
              return (
                <button key={mode} aria-pressed={speed === mode} aria-label={`Speed ${labels[mode]}`} onClick={() => setSpeed(mode)}
                  className={["px-3 h-8 rounded-lg text-xs font-semibold transition-all",
                    speed === mode
                      ? "bg-primary/14 text-primary border border-primary/25"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary/50 border border-transparent"].join(" ")}>
                  {labels[mode]}
                </button>
              );
            })}

            {isPlaying && (
              <>
                <div className="w-px h-6 bg-border mx-0.5" />
                <div className="flex items-center gap-1.5 pr-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                  <span className="text-[10px] text-primary font-medium">
                    {drawingEngine === "threebody" ? "Simulating" : "Drawing"}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        {!isPlaying && (
          <div className="absolute top-5 left-1/2 -translate-x-1/2 pointer-events-none">
            <p className="text-[11px] text-muted-foreground/45 tracking-wide">
              {drawingEngine === "threebody"
                ? "Pick a preset · press ▶ to simulate"
                : "Pick a mode · configure gears · press ▶ to draw"}
            </p>
          </div>
        )}
      </div>

      {drawShapeFor !== null && (
        <DrawShapeModal
          target={drawShapeFor}
          isRack={meshMode === "rack" && drawShapeFor === "fixed"}
          onDone={handleDrawDone}
          onCancel={() => setDrawShapeFor(null)}
        />
      )}
    </SimulationLayout>
  );
}
