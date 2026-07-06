import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildArcLengthTable,
  computeMeshState,
  gearRadius,
  totalArcLength,
  type GearShape,
  type MeshMode,
} from "@/lib/gearMath";
import { DrawShapeModal } from "@/components/DrawShapeModal";

const TWO_PI = 2 * Math.PI;
const TABLE_N = 800;
const FIXED_BASE_R = 155;
const FIXED_TEETH  = 124;
const TOOTH_SAMPLES = 18;
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

type GearPreset = (typeof GEAR_PRESETS)[number];
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
  return { ...base, radius: r, teeth: t } as GearPreset;
}

type SpeedMode = "partial" | "full" | "accelerated";
const SPEED_DELTAS: Record<SpeedMode, number> = { partial: 0.005, full: 0.018, accelerated: 0.07 };

interface TraceRun { points: { x: number; y: number }[]; color: string; weight: number; }

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

// ─── Nested gear math ─────────────────────────────────────────────────────────
// Computes the position of a small gear rolling inside the primary moving gear.
// phi, psi1: primary gear driver and arc-length angle from computeMeshState.
// c1x, c1y: primary gear center in WORLD space.
// r1: primary gear base radius (world units).
// r2: nested gear radius (world units).
// N: how many times the nested gear orbits per primary phi cycle (integer).
// d: pen offset as fraction of r2 (0–1).
interface NestedState {
  penX: number; penY: number;
  centerX: number; centerY: number;
  theta2: number;
}
function computeNestedGear(
  phi: number, psi1: number,
  c1x: number, c1y: number,
  r1: number, r2: number,
  N: number, d: number,
): NestedState {
  // Gear 1 world orientation: rolling inside ring => theta1 = phi - psi1
  const theta1 = phi - psi1;
  // Nested gear orbits inside gear 1 at angle N*phi in gear 1's local frame
  const phi2_world = theta1 + N * phi;
  const centerX = c1x + (r1 - r2) * Math.cos(phi2_world);
  const centerY = c1y + (r1 - r2) * Math.sin(phi2_world);
  // Rolling without slip: nested gear rotation = theta1 - N*phi*(r1/r2 - 1)
  // Derivation: in gear 1's local frame, rolling on its inner rim gives
  // omega_nested = -(r1/r2 - 1)*omega_orbit. In world frame add theta1.
  const theta2 = theta1 - N * phi * (r1 / r2 - 1);
  return {
    centerX, centerY, theta2,
    penX: centerX + d * r2 * Math.cos(theta2),
    penY: centerY + d * r2 * Math.sin(theta2),
  };
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
function computeScale(mode: MeshMode, gear: GearPreset, canvasSize: number): number {
  if (mode === "rack") {
    return (canvasSize * 0.86) / (gear.radius * RACK_MAX_PHI);
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
function ControlSlider({ label, value, min, max, step, onChange, onInput, display }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange?: (v: number) => void; onInput?: (v: number) => void; display?: (v: number) => string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between items-baseline">
        <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</label>
        {display && <span className="text-[10px] text-foreground/50 font-mono">{display(value)}</span>}
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        className="w-full h-1 accent-primary cursor-pointer"
        onChange={(e) => onChange?.(Number((e.target as HTMLInputElement).value))}
        onInput={(e) => onInput?.(Number((e.target as HTMLInputElement).value))} />
    </div>
  );
}

// ─── Shape + ecc + sides section ─────────────────────────────────────────────
interface GearShapeSectionProps {
  label: string; shape: GearShape; ecc: number; sides: number; disabled?: boolean;
  hasCustomShape?: boolean;
  onShapeChange:  (s: GearShape) => void;
  onEccChange:    (v: number)    => void;
  onEccInput:     (v: number)    => void;
  onSidesChange:  (v: number)    => void;
  onSidesInput:   (v: number)    => void;
  onDrawCustom?:  () => void;
}
function GearShapeSection({ label, shape, ecc, sides, disabled, hasCustomShape,
  onShapeChange, onEccChange, onEccInput, onSidesChange, onSidesInput, onDrawCustom,
}: GearShapeSectionProps) {
  const POLYGON_NAMES: Record<number, string> = { 3:"▲ Tri", 4:"■ Sq", 5:"⬠ Pent", 6:"⬡ Hex", 7:"Hept", 8:"Oct" };
  return (
    <section className="flex flex-col gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
      <div className="flex gap-1">
        {(["circle", "ellipse", "polygon", "custom"] as GearShape[]).map((s) => (
          <button key={s} onClick={() => onShapeChange(s)} disabled={disabled}
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
              <button key={n} onClick={() => onSidesChange(n)} disabled={disabled}
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
  const [penWeight,   setPenWeight]   = useState(2);
  const [penColor,    setPenColor]    = useState("#60a5fa");
  const [rainbow,     setRainbow]     = useState(false);
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
  const hueRef        = useRef(0);
  // 3-body refs
  const nbodyBodiesRef = useRef<NBodyState[]>([]);
  const nbodyTrailsRef = useRef<{ x: number; y: number }[][]>([[], [], []]);
  // Custom shape refs — stable mutable refs so callbacks always see latest
  const customFixedRRef  = useRef<Float64Array | null>(null);
  const customMovingRRef = useRef<Float64Array | null>(null);
  // Custom shape UI state
  const [drawShapeFor,  setDrawShapeFor]  = useState<"fixed" | "moving" | null>(null);
  const [hasCustomFixed,  setHasCustomFixed]  = useState(false);
  const [hasCustomMoving, setHasCustomMoving] = useState(false);

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
    rackOffX:    0,  // world-space X centering offset for rack mode
    rackOffY:    0,  // world-space Y centering offset for rack mode
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
    // rack centering: X at midpoint of one-way travel; Y = 0 so rack bar is centred,
    // gear traces above (top pass) and below (bottom pass).
    sim.rackOffX     = gear.radius * RACK_MAX_PHI / 2;
    sim.rackOffY     = 0;
    sim.tablesReady  = true;
  }, []);

  const getCanvasSize = useCallback(() => {
    const c = canvasRef.current;
    return c ? Math.min(c.width, c.height) : 600;
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
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sim  = simRef.current;
    const gear = sim.gear;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;

    // Custom shape tables (mutable refs — always current, no dep needed)
    const customFixedRT  = customFixedRRef.current;
    const customMovingRT = customMovingRRef.current;

    // World-to-screen coordinate offset (rack mode shifts origin)
    const offX = sim.meshMode === "rack" ? sim.rackOffX : 0;
    const offY = sim.meshMode === "rack" ? sim.rackOffY : 0;

    ctx.clearRect(0, 0, W, H);

    // ── Trace runs ───────────────────────────────────────────────────────────
    for (const run of traceRunsRef.current) {
      if (run.points.length < 2) continue;
      ctx.save();
      ctx.strokeStyle = run.color;
      ctx.lineWidth   = run.weight;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (let i = 0; i < run.points.length; i++) {
        const px = cx + (run.points[i].x - offX) * scale;
        const py = cy + (run.points[i].y - offY) * scale;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ── Gear geometry setup ──────────────────────────────────────────────────
    const fixedR  = FIXED_BASE_R * scale;
    const movingR = gear.radius * scale;
    const ringW   = Math.max(5, fixedR * 0.12);
    const toothPitch = (TWO_PI * fixedR) / FIXED_TEETH;
    const toothH  = toothPitch * 0.38;
    const movingTeeth   = gear.teeth;
    const fixedSamples  = FIXED_TEETH   * TOOTH_SAMPLES;
    const movingSamples = movingTeeth   * TOOTH_SAMPLES;

    // Rotation angle for moving gear body in world frame.
    // Rack: gear rolls right → CW in screen coords → +psi.
    const rotAngle = sim.meshMode === "external" ? phi + psi + Math.PI
                   : sim.meshMode === "rack"     ? psi
                   : phi - psi; // internal

    // Moving gear center in screen space
    const mcxS = (mcx - offX) * scale;
    const mcyS = (mcy - offY) * scale;

    ctx.save();
    ctx.translate(cx, cy);

    // ── Fixed gear / rack rendering ──────────────────────────────────────────
    if (sim.meshMode === "rack") {
      // ── RACK BAR — symmetric bar with toothed top AND bottom edges ──────────
      const barCY = (0 - offY) * scale; // rack centre-line in screen space (= 0 with offY=0)
      const rackHalfW = sim.rackOffX * scale * 1.08;
      const barHalf = Math.max(4, toothH * 0.75); // half-height of bar body
      const rackToothPitch = toothPitch;
      const nRackPts = Math.round(rackHalfW * 2 / rackToothPitch) * 12;

      // Fill body (centred on barCY)
      ctx.fillStyle = "rgba(200, 215, 245, 0.08)";
      ctx.beginPath();
      ctx.rect(-rackHalfW, barCY - barHalf, rackHalfW * 2, barHalf * 2);
      ctx.fill();

      const drawTeeth = (yBase: number, dir: 1 | -1) => {
        ctx.save();
        ctx.shadowColor = "rgba(160, 175, 255, 0.3)";
        ctx.shadowBlur = 5;
        ctx.beginPath();
        ctx.moveTo(-rackHalfW, yBase);
        for (let i = 0; i <= nRackPts; i++) {
          const x = -rackHalfW + (i / nRackPts) * rackHalfW * 2;
          const toothPhase = (x + sim.rackOffX * scale) / rackToothPitch;
          const profile = 0.5 * (1 - Math.cos(toothPhase * TWO_PI));
          ctx.lineTo(x, yBase + dir * toothH * profile);
        }
        ctx.lineTo(rackHalfW, yBase);
        ctx.closePath();
        ctx.strokeStyle = "rgba(195, 210, 255, 0.70)";
        ctx.lineWidth = 1.3;
        ctx.stroke();
        ctx.fillStyle = "rgba(200, 215, 245, 0.07)";
        ctx.fill();
        ctx.restore();
      };
      drawTeeth(barCY - barHalf, -1); // top edge: teeth protrude upward
      drawTeeth(barCY + barHalf,  1); // bottom edge: teeth protrude downward

      // Contact dot — on whichever edge the gear is currently touching
      const isBottomPass = mcyS > 0;
      const contactY = isBottomPass ? barCY + barHalf : barCY - barHalf;
      ctx.save();
      ctx.shadowColor = "rgba(255,210,80,0.7)";
      ctx.shadowBlur  = 9;
      ctx.beginPath();
      ctx.arc(mcxS, contactY, 3.5, 0, TWO_PI);
      ctx.fillStyle = "rgba(255,220,70,0.95)";
      ctx.fill();
      ctx.restore();

    } else if (sim.meshMode === "external") {
      // ── CENTRAL HUB (full pitch-circle radius, outward teeth) ──────────────
      // Hub uses the same fixedR / FIXED_TEETH as the physics so teeth align.
      // Hub tooth profile: cos(t·N)   (NO +π).
      // Gear tooth profile: cos(la·N + π).
      // At contact: hub_profile + gear_profile = 1 — perfect interlock.
      const hubSamples = FIXED_TEETH * TOOTH_SAMPLES;

      // Hub body fill
      ctx.beginPath();
      for (let i = 0; i <= hubSamples; i++) {
        const t    = (i / hubSamples) * TWO_PI;
        const base = gearRadius(sim.fixedShape, fixedR, sim.fixedEcc, t, sim.fixedSides);
        if (i === 0) ctx.moveTo(base * Math.cos(t), base * Math.sin(t));
        else         ctx.lineTo(base * Math.cos(t), base * Math.sin(t));
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(200, 215, 245, 0.10)";
      ctx.fill();

      // Outward teeth on hub — NO +π so peaks interlock with gear valleys
      ctx.save();
      ctx.shadowColor = "rgba(160, 175, 255, 0.3)";
      ctx.shadowBlur  = 6;
      ctx.beginPath();
      for (let i = 0; i <= hubSamples; i++) {
        const t    = (i / hubSamples) * TWO_PI;
        const base = gearRadius(sim.fixedShape, fixedR, sim.fixedEcc, t, sim.fixedSides);
        const r    = base + toothH * 0.5 * (1 - Math.cos(t * FIXED_TEETH));
        if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
        else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
      }
      ctx.closePath();
      ctx.strokeStyle = "rgba(195, 210, 255, 0.70)";
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.restore();

      // Contact point
      const contactR = gearRadius(sim.fixedShape, fixedR, sim.fixedEcc, phi, sim.fixedSides, customFixedRT);
      ctx.save();
      ctx.shadowColor = "rgba(255,210,80,0.7)";
      ctx.shadowBlur  = 9;
      ctx.beginPath();
      ctx.arc(contactR * Math.cos(phi), contactR * Math.sin(phi), 3.5, 0, TWO_PI);
      ctx.fillStyle = "rgba(255,220,70,0.95)";
      ctx.fill();
      ctx.restore();

    } else {
      // ── INTERNAL RING (evenodd: outer smooth + inner toothed) ──────────────
      ctx.beginPath();
      for (let i = 0; i <= fixedSamples; i++) {
        const t = (i / fixedSamples) * TWO_PI;
        const r = gearRadius(sim.fixedShape, fixedR + ringW, sim.fixedEcc, t, sim.fixedSides, customFixedRT);
        if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
        else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
      }
      ctx.closePath();
      for (let i = 0; i <= fixedSamples; i++) {
        const t    = (i / fixedSamples) * TWO_PI;
        const base = gearRadius(sim.fixedShape, fixedR, sim.fixedEcc, t, sim.fixedSides, customFixedRT);
        const r    = sim.fixedShape === "custom"
          ? base  // custom: no teeth — just the profile
          : base + toothH * 0.5 * (1 + Math.cos(t * FIXED_TEETH));
        if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
        else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(200, 215, 245, 0.10)";
      ctx.fill("evenodd");

      // Outer rim
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i <= fixedSamples; i++) {
        const t = (i / fixedSamples) * TWO_PI;
        const r = gearRadius(sim.fixedShape, fixedR + ringW, sim.fixedEcc, t, sim.fixedSides, customFixedRT);
        if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
        else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
      }
      ctx.closePath();
      ctx.strokeStyle = "rgba(180, 195, 240, 0.30)";
      ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();

      // Inner edge stroke
      ctx.save();
      ctx.shadowColor = "rgba(160, 175, 255, 0.25)";
      ctx.shadowBlur  = 6;
      ctx.beginPath();
      for (let i = 0; i <= fixedSamples; i++) {
        const t    = (i / fixedSamples) * TWO_PI;
        const base = gearRadius(sim.fixedShape, fixedR, sim.fixedEcc, t, sim.fixedSides, customFixedRT);
        const r    = sim.fixedShape === "custom"
          ? base
          : base + toothH * 0.5 * (1 + Math.cos(t * FIXED_TEETH));
        if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
        else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
      }
      ctx.closePath();
      ctx.strokeStyle = "rgba(195, 210, 255, 0.70)";
      ctx.lineWidth = 1.3; ctx.stroke();
      ctx.restore();

      // Contact point
      const contactR = gearRadius(sim.fixedShape, fixedR, sim.fixedEcc, phi, sim.fixedSides, customFixedRT);
      ctx.save();
      ctx.shadowColor = "rgba(255,210,80,0.7)";
      ctx.shadowBlur  = 9;
      ctx.beginPath();
      ctx.arc(contactR * Math.cos(phi), contactR * Math.sin(phi), 3.5, 0, TWO_PI);
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
    // Base disk
    ctx.beginPath();
    ctx.arc(mcxS, mcyS, movingR, 0, TWO_PI);
    ctx.fillStyle = gear.color + "18";
    ctx.fill();

    // Toothed outline (or custom profile)
    ctx.beginPath();
    for (let i = 0; i <= movingSamples; i++) {
      const la   = (i / movingSamples) * TWO_PI;
      const base = gearRadius(sim.movingShape, movingR, sim.movingEcc, la, sim.movingSides, customMovingRT);
      const r    = sim.movingShape === "custom"
        ? base
        : base + toothH * 0.5 * (1 - Math.cos(la * movingTeeth + Math.PI));
      const wa   = la + rotAngle;
      if (i === 0) ctx.moveTo(mcxS + r * Math.cos(wa), mcyS + r * Math.sin(wa));
      else         ctx.lineTo(mcxS + r * Math.cos(wa), mcyS + r * Math.sin(wa));
    }
    ctx.closePath();
    ctx.save();
    ctx.shadowColor = gear.color + "88"; ctx.shadowBlur = 8;
    ctx.strokeStyle = gear.color + "ee"; ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

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
    const penRpx  = curPenOffset * movingR;
    const penDotX = mcxS + penRpx * Math.cos(rotAngle);
    const penDotY = mcyS + penRpx * Math.sin(rotAngle);
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
      const nTeeth = Math.max(6, Math.round(gear.teeth * nested.r2 / sim.gear.radius));
      const nSamples = nTeeth * TOOTH_SAMPLES;
      const nPitch = (TWO_PI * nrS) / nTeeth;
      const nToothH = nPitch * 0.38;

      // Nested gear fill
      ctx.beginPath();
      ctx.arc(ncxS, ncyS, nrS, 0, TWO_PI);
      ctx.fillStyle = "rgba(255, 200, 80, 0.06)";
      ctx.fill();

      // Nested gear toothed outline
      ctx.save();
      ctx.shadowColor = "rgba(255, 190, 60, 0.4)";
      ctx.shadowBlur = 6;
      ctx.beginPath();
      for (let i = 0; i <= nSamples; i++) {
        const la = (i / nSamples) * TWO_PI;
        const r  = nrS + nToothH * 0.5 * (1 - Math.cos(la * nTeeth + Math.PI));
        const wa = la + nested.theta2;
        if (i === 0) ctx.moveTo(ncxS + r * Math.cos(wa), ncyS + r * Math.sin(wa));
        else         ctx.lineTo(ncxS + r * Math.cos(wa), ncyS + r * Math.sin(wa));
      }
      ctx.closePath();
      ctx.strokeStyle = "rgba(255, 200, 80, 0.80)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
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
  }, []);

  // ─── Draw idle ──────────────────────────────────────────────────────────────
  const drawIdle = useCallback((
    fShape: GearShape, fEcc: number, fSides: number,
    mShape: GearShape, mEcc: number, mSides: number,
    gear: GearPreset, mode: MeshMode, pOff: number, color: string,
  ) => {
    const sim = simRef.current;
    if (!sim.tablesReady) return;
    const canvasSize = getCanvasSize();
    const scale = computeScale(mode, gear, canvasSize);
    // For rack mode, show gear at center of its path (phi = halfway)
    const phi0 = mode === "rack" ? sim.rackOffX / gear.radius : 0;
    const state = computeMeshState(
      phi0,
      fShape, FIXED_BASE_R, fEcc, sim.fixedTable, fSides,
      mShape, gear.radius,  mEcc, sim.movingTable, mSides,
      pOff, mode,
    );
    renderFrame(phi0, state.psi, state.movingCenterX, state.movingCenterY,
      state.penX, state.penY, scale, color, pOff);
  }, [getCanvasSize, renderFrame]);

  // ─── Ghost trace ─────────────────────────────────────────────────────────────
  const drawGhost = useCallback((
    fShape: GearShape, fEcc: number, fSides: number,
    mShape: GearShape, mEcc: number, mSides: number,
    gear: GearPreset, mode: MeshMode, pOff: number, color: string, weight: number,
    rings = 1,
    nestedOn = false, nestedR2 = 0, nestedN = 1, nestedD = 0.7,
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sim = simRef.current;
    if (!sim.tablesReady) return;

    const W = canvas.width, H = canvas.height;
    const canvasSize = Math.min(W, H);
    const scale = computeScale(mode, gear, canvasSize);
    const cx = W / 2, cy = H / 2;
    const offX = mode === "rack" ? sim.rackOffX : 0;
    const offY = mode === "rack" ? sim.rackOffY : 0;

    const ft = sim.fixedTable, mt = sim.movingTable;
    const ratio = totalArcLength(ft) / totalArcLength(mt);
    const baseLoops = closureLoops(ratio);
    const totalPhi = mode === "rack"
      ? 2 * RACK_MAX_PHI
      : TWO_PI * (nestedOn ? baseLoops * nestedN : baseLoops);
    const numSteps = nestedOn ? Math.min(2000, 800 * nestedN) : Math.min(2000, baseLoops * 60);

    // idlePhi: where to show the gear at rest (centre of top pass for rack)
    const idlePhi = mode === "rack" ? sim.rackOffX / gear.radius : 0;
    const state0 = computeMeshState(
      idlePhi, fShape, FIXED_BASE_R, fEcc, ft, fSides,
      mShape, gear.radius, mEcc, mt, mSides, pOff, mode,
      customFixedRRef.current, customMovingRRef.current,
    );
    // Show idle gear frame; nested gear not shown here (too expensive at idle)
    renderFrame(idlePhi, state0.psi, state0.movingCenterX, state0.movingCenterY,
      state0.penX, state0.penY, scale, color, pOff);

    // Ghost trace overlays
    const rackMaxCXIdle = gear.radius * RACK_MAX_PHI; // world X span of one pass
    const ghostColors = [color, ...MULTI_RING_COLORS];
    const numRings = nestedOn ? 1 : rings; // when nested, only draw the nested pen trace
    for (let ri = 0; ri < numRings; ri++) {
      const ringOff = ri === 0 ? pOff : pOff * (rings - ri) / rings;
      const ghostColor = nestedOn ? "rgba(255,200,70,0.9)" : ghostColors[ri % ghostColors.length];
      ctx.save();
      ctx.globalAlpha = 0.15;
      ctx.strokeStyle = ghostColor;
      ctx.lineWidth = weight * 0.8;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i <= numSteps; i++) {
        const ph = (i / numSteps) * totalPhi; // always start from 0
        const rackBot = mode === "rack" && ph > RACK_MAX_PHI;
        const lph = rackBot ? ph - RACK_MAX_PHI : ph;
        const st = computeMeshState(
          lph, fShape, FIXED_BASE_R, fEcc, ft, fSides,
          mShape, gear.radius, mEcc, mt, mSides, ringOff, mode,
          customFixedRRef.current, customMovingRRef.current,
        );
        let px: number, py: number;
        if (nestedOn) {
          const mcxW = rackBot ? rackMaxCXIdle - st.movingCenterX : st.movingCenterX;
          const mcyW = rackBot ? -st.movingCenterY : st.movingCenterY;
          const ns = computeNestedGear(lph, st.psi, mcxW, mcyW,
            gear.radius, nestedR2, nestedN, nestedD);
          const nPenX = rackBot ? rackMaxCXIdle - ns.penX : ns.penX;
          const nPenY = rackBot ? -ns.penY : ns.penY;
          px = cx + (nPenX - offX) * scale;
          py = cy + (nPenY - offY) * scale;
        } else {
          const penXw = rackBot ? rackMaxCXIdle - st.penX : st.penX;
          const penYw = rackBot ? -st.penY : st.penY;
          px = cx + (penXw - offX) * scale;
          py = cy + (penYw - offY) * scale;
        }
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }
  }, [renderFrame]);

  // ─── Initial setup ───────────────────────────────────────────────────────────
  useEffect(() => {
    rebuildTables(fixedShape, fixedEcc, fixedSides,
      movingShape, movingEcc, movingSides,
      GEAR_PRESETS[DEFAULT_GEAR_IDX], "internal");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Rebuild when params change (idle) ───────────────────────────────────────
  useEffect(() => {
    if (!simRef.current.tablesReady) return;
    const gear = makeEffectiveGear(gearIdx, gearRatio);
    rebuildTables(fixedShape, fixedEcc, fixedSides,
      movingShape, movingEcc, movingSides, gear, meshMode);
    if (!isPlaying) drawGhost(fixedShape, fixedEcc, fixedSides,
      movingShape, movingEcc, movingSides, gear, meshMode, effectivePenOffset, penColor, penWeight, penCount,
      nestedEnabled, gear.radius * nestedRatio / 100, nestedSpeed, nestedPenOffset);
  }, [gearIdx, gearRatio, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Animation loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      return;
    }
    const sim = simRef.current;
    const delta = SPEED_DELTAS[speed];
    const capGear    = makeEffectiveGear(gearIdx, gearRatio);
    const capMode    = meshMode;
    const capFShape  = fixedShape;  const capFEcc  = fixedEcc;  const capFSides = fixedSides;
    const capMShape  = movingShape; const capMEcc  = movingEcc; const capMSides = movingSides;
    const capPen     = effectivePenOffset; const capColor = penColor; const capWeight = penWeight;
    const capRainbow = rainbow;     const capComposite = compositeMode;
    const capRings   = penCount;
    const capNested  = nestedEnabled;
    const capNR2     = capGear.radius * nestedRatio / 100;  // nested gear radius in world units
    const capNN      = nestedSpeed;
    const capND      = nestedPenOffset;
    const capCustomFixedR  = customFixedRRef.current;
    const capCustomMovingR = customMovingRRef.current;

    const ratio  = totalArcLength(sim.fixedTable) / totalArcLength(sim.movingTable);
    const baseLoops = closureLoops(ratio);
    const maxPhi = capMode === "rack"
      ? 2 * RACK_MAX_PHI
      : TWO_PI * (capNested ? baseLoops * capNN : baseLoops);

    let frameCount = 0;
    const loop = () => {
      const canvasSize = getCanvasSize();
      const scale = computeScale(capMode, capGear, canvasSize);

      // Rack mode: detect bottom pass (phi > RACK_MAX_PHI) and mirror positions
      const rackBottom = capMode === "rack" && sim.phi > RACK_MAX_PHI;
      const meshPhi    = rackBottom ? sim.phi - RACK_MAX_PHI : sim.phi;
      const rackMaxCX  = capGear.radius * RACK_MAX_PHI; // world-X span of one pass

      const state = computeMeshState(
        meshPhi,
        capFShape, FIXED_BASE_R, capFEcc, sim.fixedTable, capFSides,
        capMShape, capGear.radius, capMEcc, sim.movingTable, capMSides,
        capPen, capMode,
        capCustomFixedR, capCustomMovingR,
      );

      // Effective positions: mirror X and flip Y for bottom pass
      const effMcx  = rackBottom ? rackMaxCX - state.movingCenterX : state.movingCenterX;
      const effMcy  = rackBottom ? -state.movingCenterY            : state.movingCenterY;
      const effPenX = rackBottom ? rackMaxCX - state.penX          : state.penX;
      const effPenY = rackBottom ? -state.penY                     : state.penY;
      // For rack bottom pass the gear is inverted → add π to rotation
      const effPsi  = rackBottom ? state.psi + Math.PI             : state.psi;

      let frameColor = capColor;
      if (capRainbow) {
        hueRef.current = (hueRef.current + RAINBOW_HUE_STEP) % 360;
        frameColor = `hsl(${Math.round(hueRef.current)}, 85%, 62%)`;
        if (frameCount % RAINBOW_CHUNK_FRAMES === 0 && currentRunRef.current) {
          const prev = currentRunRef.current;
          if (prev.points.length > 0) {
            const lastPt = prev.points[prev.points.length - 1];
            const newRun: TraceRun = { points: [lastPt], color: frameColor, weight: capWeight };
            traceRunsRef.current.push(newRun);
            currentRunRef.current = newRun;
          }
        }
      }

      // Nested gear computation (gear 2 rolling inside gear 1)
      let nestedState: (NestedState & { r2: number }) | undefined;
      if (capNested) {
        const rawNested = computeNestedGear(
          meshPhi, state.psi,
          effMcx, effMcy,
          capGear.radius, capNR2, capNN, capND,
        );
        // Mirror nested pen for rack bottom pass
        const nPenX = rackBottom ? rackMaxCX - rawNested.penX : rawNested.penX;
        const nPenY = rackBottom ? -rawNested.penY             : rawNested.penY;
        nestedState = { ...rawNested, penX: nPenX, penY: nPenY, r2: capNR2 };
        currentRunRef.current?.points.push({ x: nPenX, y: nPenY });
      } else {
        currentRunRef.current?.points.push({ x: effPenX, y: effPenY });
      }

      // Extra rings (rings 2–5) — each at a closer offset, inward from the primary
      const extraPens: { x: number; y: number; color: string }[] = [];
      if (!capNested) {
        for (let ri = 0; ri < capRings - 1; ri++) {
          const off = capPen * (capRings - 1 - ri) / capRings;
          const st = computeMeshState(
            meshPhi,
            capFShape, FIXED_BASE_R, capFEcc, sim.fixedTable, capFSides,
            capMShape, capGear.radius, capMEcc, sim.movingTable, capMSides,
            off, capMode,
            capCustomFixedR, capCustomMovingR,
          );
          const ringColor = MULTI_RING_COLORS[ri % MULTI_RING_COLORS.length];
          const rPenX = rackBottom ? rackMaxCX - st.penX : st.penX;
          const rPenY = rackBottom ? -st.penY             : st.penY;
          extraRunsRef.current[ri]?.points.push({ x: rPenX, y: rPenY });
          extraPens.push({ x: rPenX, y: rPenY, color: ringColor });
        }
      }

      renderFrame(sim.phi, effPsi,
        effMcx, effMcy,
        effPenX, effPenY, scale, frameColor, capPen, extraPens, nestedState);

      sim.phi += delta;
      frameCount++;

      if (sim.phi >= maxPhi) {
        if (capComposite) {
          sim.phi = 0;
          const newRun: TraceRun = { points: [], color: frameColor, weight: capWeight };
          traceRunsRef.current.push(newRun);
          currentRunRef.current = newRun;
          // Also cycle extra runs in composite mode
          for (let ri = 0; ri < capRings - 1; ri++) {
            const ringColor = MULTI_RING_COLORS[ri % MULTI_RING_COLORS.length];
            const extraRun: TraceRun = { points: [], color: ringColor, weight: capWeight };
            extraRunsRef.current[ri] = extraRun;
            traceRunsRef.current.push(extraRun);
          }
        } else {
          setIsPlaying(false);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  }, [isPlaying, speed, gearIdx, gearRatio, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides,
      effectivePenOffset, penOffset, penCount, penColor, penWeight, rainbow, compositeMode,
      nestedEnabled, nestedRatio, nestedSpeed, nestedPenOffset,
      getCanvasSize, renderFrame]);

  // ─── Canvas resize ───────────────────────────────────────────────────────────
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const canvas = canvasRef.current;
      const parent = canvas?.parentElement;
      if (!canvas || !parent) return;
      const rect = parent.getBoundingClientRect();
      const size = Math.max(100, Math.floor(Math.min(rect.width, rect.height)));
      if (canvas.width === size && canvas.height === size) return;
      canvas.width = size; canvas.height = size;
      if (!isPlaying) drawIdle(fixedShape, fixedEcc, fixedSides,
        movingShape, movingEcc, movingSides, makeEffectiveGear(gearIdx, gearRatio), meshMode, effectivePenOffset, penColor);
    });
    const parent = canvasRef.current?.parentElement;
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
  }, [isPlaying, gearIdx, gearRatio, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides,
      penOffset, penColor, drawIdle]);

  // ─── Shared param helper ─────────────────────────────────────────────────────
  const applyGearParams = useCallback((
    fShape: GearShape, fEcc: number, fSides: number,
    mShape: GearShape, mEcc: number, mSides: number,
    gear: GearPreset, mode: MeshMode, pOff: number,
  ) => {
    if (isPlaying) return;
    rebuildTables(fShape, fEcc, fSides, mShape, mEcc, mSides, gear, mode);
    drawGhost(fShape, fEcc, fSides, mShape, mEcc, mSides, gear, mode, pOff, penColor, penWeight, penCount,
      nestedEnabled, gear.radius * nestedRatio / 100, nestedSpeed, nestedPenOffset);
  }, [isPlaying, penColor, penWeight, penCount, nestedEnabled, nestedRatio, nestedSpeed, nestedPenOffset, rebuildTables, drawGhost]);

  const g   = () => makeEffectiveGear(gearIdx, gearRatio);
  const cur = () => ({ fShape: fixedShape, fEcc: fixedEcc, fSides: fixedSides,
                       mShape: movingShape, mEcc: movingEcc, mSides: movingSides,
                       gear: g(), mode: meshMode });

  // ─── Handlers ────────────────────────────────────────────────────────────────
  const handleGearSelect = useCallback((idx: number) => {
    setGearIdx(idx);
    const presetRatio = Math.min(80, Math.max(20, Math.round((GEAR_PRESETS[idx].radius / FIXED_BASE_R) * 100)));
    setGearRatio(presetRatio);
    const { fShape, fEcc, fSides, mShape, mEcc, mSides, mode } = cur();
    if (!isPlaying) applyGearParams(fShape, fEcc, fSides, mShape, mEcc, mSides, makeEffectiveGear(idx, presetRatio), mode, effectivePenOffset);
  }, [isPlaying, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides, meshMode, effectivePenOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleMeshMode = useCallback((mode: MeshMode) => {
    setMeshMode(mode);
    const { fShape, fEcc, fSides, mShape, mEcc, mSides, gear } = cur();
    if (!isPlaying) applyGearParams(fShape, fEcc, fSides, mShape, mEcc, mSides, gear, mode, effectivePenOffset);
  }, [isPlaying, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides, gearIdx, gearRatio, effectivePenOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFixedShape  = useCallback((s: GearShape) => { setFixedShape(s);  const c = cur(); applyGearParams(s, c.fEcc, c.fSides, c.mShape, c.mEcc, c.mSides, c.gear, c.mode, effectivePenOffset); }, [fixedEcc, fixedSides, movingShape, movingEcc, movingSides, gearIdx, gearRatio, meshMode, effectivePenOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleFixedEcc    = useCallback((v: number)    => { setFixedEcc(v);    const c = cur(); applyGearParams(c.fShape, v, c.fSides, c.mShape, c.mEcc, c.mSides, c.gear, c.mode, effectivePenOffset); }, [fixedShape, fixedSides, movingShape, movingEcc, movingSides, gearIdx, gearRatio, meshMode, effectivePenOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleFixedSides  = useCallback((v: number)    => { setFixedSides(v);  const c = cur(); applyGearParams(c.fShape, c.fEcc, v, c.mShape, c.mEcc, c.mSides, c.gear, c.mode, effectivePenOffset); }, [fixedShape, fixedEcc, movingShape, movingEcc, movingSides, gearIdx, gearRatio, meshMode, effectivePenOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleMovingShape = useCallback((s: GearShape) => { setMovingShape(s); const c = cur(); applyGearParams(c.fShape, c.fEcc, c.fSides, s, c.mEcc, c.mSides, c.gear, c.mode, effectivePenOffset); }, [fixedShape, fixedEcc, fixedSides, movingEcc, movingSides, gearIdx, gearRatio, meshMode, effectivePenOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleMovingEcc   = useCallback((v: number)    => { setMovingEcc(v);   const c = cur(); applyGearParams(c.fShape, c.fEcc, c.fSides, c.mShape, v, c.mSides, c.gear, c.mode, effectivePenOffset); }, [fixedShape, fixedEcc, fixedSides, movingShape, movingSides, gearIdx, gearRatio, meshMode, effectivePenOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleMovingSides = useCallback((v: number)    => { setMovingSides(v); const c = cur(); applyGearParams(c.fShape, c.fEcc, c.fSides, c.mShape, c.mEcc, v, c.gear, c.mode, effectivePenOffset); }, [fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, gearIdx, gearRatio, meshMode, effectivePenOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps
  const handlePenOffset   = useCallback((v: number)    => { setPenOffset(v);   const c = cur(); applyGearParams(c.fShape, c.fEcc, c.fSides, c.mShape, c.mEcc, c.mSides, c.gear, c.mode, v); }, [fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides, gearIdx, gearRatio, meshMode, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps

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

    const gear = makeEffectiveGear(loopGearIdx, loopGearRatio);
    rebuildTables(fShape, fEcc, fSides, mShape, mEcc, mSides, gear, "external");
    drawGhost(fShape, fEcc, fSides, mShape, mEcc, mSides, gear, "external", penOff, penColor, penWeight, penCount,
      nestedEnabled, gear.radius * nestedRatio / 100, nestedSpeed, nestedPenOffset);

    simRef.current.phi = 0;
    hueRef.current = 0;
    const startColor = rainbow ? "hsl(0,85%,62%)" : penColor;
    const newRun: TraceRun = { points: [], color: startColor, weight: penWeight };
    currentRunRef.current = newRun;
    traceRunsRef.current.push(newRun);
    extraRunsRef.current = [];
    for (let ri = 0; ri < penCount - 1; ri++) {
      const ringColor = MULTI_RING_COLORS[ri % MULTI_RING_COLORS.length];
      const extraRun: TraceRun = { points: [], color: ringColor, weight: penWeight };
      extraRunsRef.current.push(extraRun);
      traceRunsRef.current.push(extraRun);
    }
    setHasTrace(true);
    setIsPlaying(true);
  }, [penColor, penWeight, penCount, rainbow, nestedEnabled, nestedRatio, nestedSpeed, nestedPenOffset, rebuildTables, drawGhost]); // eslint-disable-line react-hooks/exhaustive-deps

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

    const gear = makeEffectiveGear(gearIdx, gearRatio);
    rebuildTables(rFShape, rFEcc, rFSides, rMShape, rMEcc, rMSides, gear, meshMode);
    drawGhost(rFShape, rFEcc, rFSides, rMShape, rMEcc, rMSides, gear, meshMode, rPenOff, penColor, penWeight, penCount,
      nestedEnabled, gear.radius * nestedRatio / 100, nestedSpeed, nestedPenOffset);

    // Auto-play
    simRef.current.phi = 0;
    hueRef.current = 0;
    const startColor = rainbow ? "hsl(0,85%,62%)" : penColor;
    const newRun: TraceRun = { points: [], color: startColor, weight: penWeight };
    currentRunRef.current = newRun;
    traceRunsRef.current.push(newRun);
    // Extra ring runs
    extraRunsRef.current = [];
    for (let ri = 0; ri < penCount - 1; ri++) {
      const ringColor = MULTI_RING_COLORS[ri % MULTI_RING_COLORS.length];
      const extraRun: TraceRun = { points: [], color: ringColor, weight: penWeight };
      extraRunsRef.current.push(extraRun);
      traceRunsRef.current.push(extraRun);
    }
    setHasTrace(true);
    setIsPlaying(true);
  }, [gearIdx, gearRatio, meshMode, penColor, penWeight, penCount, rainbow, compositeMode, rebuildTables, drawGhost]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Gear ratio slider ────────────────────────────────────────────────────────
  const handleGearRatioInput = useCallback((v: number) => {
    setGearRatio(v);
    const c = cur();
    if (!isPlaying) applyGearParams(c.fShape, c.fEcc, c.fSides, c.mShape, c.mEcc, c.mSides, makeEffectiveGear(gearIdx, v), c.mode, effectivePenOffset);
  }, [isPlaying, gearIdx, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides, meshMode, effectivePenOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const startPlay = useCallback(() => {
    const gear = makeEffectiveGear(gearIdx, gearRatio);
    rebuildTables(fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides, gear, meshMode);
    simRef.current.phi = 0;
    hueRef.current = 0;
    const startColor = rainbow ? "hsl(0,85%,62%)" : penColor;
    const newRun: TraceRun = { points: [], color: startColor, weight: penWeight };
    currentRunRef.current = newRun;
    traceRunsRef.current.push(newRun);
    // Extra ring runs (rings 2–5)
    extraRunsRef.current = [];
    for (let ri = 0; ri < penCount - 1; ri++) {
      const ringColor = MULTI_RING_COLORS[ri % MULTI_RING_COLORS.length];
      const extraRun: TraceRun = { points: [], color: ringColor, weight: penWeight };
      extraRunsRef.current.push(extraRun);
      traceRunsRef.current.push(extraRun);
    }
    setHasTrace(true);
    setIsPlaying(true);
  }, [gearIdx, gearRatio, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides,
      penColor, penWeight, penCount, rainbow, compositeMode, rebuildTables]);

  // ─── 3-Body animation loop ───────────────────────────────────────────────────
  useEffect(() => {
    if (drawingEngine !== "threebody" || !isPlaying) {
      if (drawingEngine === "threebody" && !isPlaying && rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current); rafRef.current = null;
      }
      return;
    }

    const preset = NBODY_PRESETS[nbodyPreset];
    const capTrail = nbodyTrail;
    const capSteps = nbodySteps;
    const capDt    = preset.dt;
    const capScale = preset.scale;

    // Initialise bodies if empty
    if (nbodyBodiesRef.current.length === 0) {
      nbodyBodiesRef.current = preset.bodies.map(b => ({ ...b }));
      nbodyTrailsRef.current = [[], [], []];
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const loop = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const W = canvas.width, H = canvas.height;
      const cx = W / 2, cy = H / 2;

      // RK4 sub-steps
      for (let s = 0; s < capSteps; s++) {
        nbodyBodiesRef.current = nbodyRK4(nbodyBodiesRef.current, capDt);
      }

      // Record trail points
      for (let i = 0; i < 3; i++) {
        const b = nbodyBodiesRef.current[i];
        nbodyTrailsRef.current[i].push({ x: b.x, y: b.y });
        if (nbodyTrailsRef.current[i].length > capTrail) {
          nbodyTrailsRef.current[i].shift();
        }
      }

      // Render
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(cx, cy);

      for (let i = 0; i < 3; i++) {
        const trail = nbodyTrailsRef.current[i];
        if (trail.length < 2) continue;
        const color = NBODY_COLORS[i];

        // Draw trail with fading alpha
        ctx.save();
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        const segments = trail.length - 1;
        for (let t = 0; t < segments; t++) {
          const alpha = (t / segments);
          ctx.beginPath();
          ctx.globalAlpha = alpha * 0.85;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5 + alpha * 1.0;
          ctx.moveTo(trail[t].x * capScale, -trail[t].y * capScale);
          ctx.lineTo(trail[t + 1].x * capScale, -trail[t + 1].y * capScale);
          ctx.stroke();
        }
        ctx.restore();

        // Body dot
        const b = nbodyBodiesRef.current[i];
        const dotR = Math.max(3, Math.min(8, b.m * 4));
        ctx.save();
        ctx.shadowColor = color + "cc"; ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(b.x * capScale, -b.y * capScale, dotR, 0, TWO_PI);
        ctx.fillStyle = color; ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      }

      // Draw gravity lines between bodies (faint)
      ctx.save();
      ctx.globalAlpha = 0.07;
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 0.8;
      for (let i = 0; i < 3; i++) {
        for (let j = i + 1; j < 3; j++) {
          const bi = nbodyBodiesRef.current[i];
          const bj = nbodyBodiesRef.current[j];
          ctx.beginPath();
          ctx.moveTo(bi.x * capScale, -bi.y * capScale);
          ctx.lineTo(bj.x * capScale, -bj.y * capScale);
          ctx.stroke();
        }
      }
      ctx.restore();

      ctx.restore(); // translate(cx, cy)

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  }, [drawingEngine, isPlaying, nbodyPreset, nbodyTrail, nbodySteps]);

  const stopPlay = useCallback(() => setIsPlaying(false), []);

  const clearAll = useCallback(() => {
    stopPlay();
    traceRunsRef.current = []; currentRunRef.current = null; extraRunsRef.current = [];
    nbodyBodiesRef.current = []; nbodyTrailsRef.current = [[], [], []];
    setHasTrace(false);
    if (drawingEngine === "spirograph") {
      setTimeout(() => drawIdle(fixedShape, fixedEcc, fixedSides,
        movingShape, movingEcc, movingSides, makeEffectiveGear(gearIdx, gearRatio), meshMode, effectivePenOffset, penColor), 0);
    } else {
      // Clear canvas for 3-body
      const canvas = canvasRef.current;
      if (canvas) { const ctx = canvas.getContext("2d"); ctx?.clearRect(0, 0, canvas.width, canvas.height); }
    }
  }, [stopPlay, drawingEngine, gearIdx, gearRatio, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides,
      effectivePenOffset, penColor, drawIdle]);

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
        nestedEnabled, c.gear.radius * nestedRatio / 100, nestedSpeed, nestedPenOffset);
    } else if (drawShapeFor === "moving") {
      customMovingRRef.current = table;
      setHasCustomMoving(true);
      setMovingShape("custom");
      const c = cur();
      rebuildTables(c.fShape, c.fEcc, c.fSides, "custom", c.mEcc, c.mSides, c.gear, c.mode);
      if (!isPlaying) drawGhost(c.fShape, c.fEcc, c.fSides, "custom", c.mEcc, c.mSides, c.gear, c.mode,
        effectivePenOffset, penColor, penWeight, penCount,
        nestedEnabled, c.gear.radius * nestedRatio / 100, nestedSpeed, nestedPenOffset);
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
    <div className="flex h-screen w-screen overflow-hidden bg-background">

      {/* ── Sidebar ── */}
      <aside className="w-60 shrink-0 flex flex-col border-r border-border bg-card overflow-y-auto">

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
                onClick={() => { if (eng !== drawingEngine) { stopPlay(); setDrawingEngine(eng); nbodyBodiesRef.current = []; nbodyTrailsRef.current = [[], [], []]; } }}
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
                    onClick={() => { setNbodyPreset(key); nbodyBodiesRef.current = []; nbodyTrailsRef.current = [[], [], []]; }}
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
                <button key={mode} onClick={() => handleMeshMode(mode)} title={title} disabled={isPlaying}
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
                <button key={gear.id} onClick={() => handleGearSelect(idx)}
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
                hasCustomShape={hasCustomFixed}
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
                onDrawCustom={() => setDrawShapeFor("moving")}
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
                <button key={m} onClick={() => { setPenMode(m); const c = cur(); applyGearParams(c.fShape, c.fEcc, c.fSides, c.mShape, c.mEcc, c.mSides, c.gear, c.mode, m === "circumference" ? 1.0 : penOffset); }} disabled={isPlaying}
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
              <span className="text-[10px] text-muted-foreground shrink-0 w-10">Rings</span>
              <div className="flex gap-0.5 flex-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} onClick={() => setPenCount(n)} disabled={isPlaying}
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

            <ControlSlider label="Weight" value={penWeight} min={0.5} max={10} step={0.5}
              onChange={(v) => setPenWeight(v)} display={(v) => `${v}px`} />

            {/* Color */}
            <div className="flex items-center gap-2">
              <label className={["relative w-7 h-7 cursor-pointer shrink-0 transition-opacity",
                rainbow ? "opacity-30 pointer-events-none" : ""].join(" ")}>
                <input type="color" value={penColor} onChange={(e) => setPenColor(e.target.value)}
                  className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
                <span className="absolute inset-0 rounded-full border-2 border-white/20" style={{ background: penColor }} />
              </label>
              <div className={["flex flex-wrap gap-1 flex-1 transition-opacity",
                rainbow ? "opacity-30 pointer-events-none" : ""].join(" ")}>
                {GEAR_PRESETS.map((gear) => (
                  <button key={gear.id} onClick={() => setPenColor(gear.color)} title={gear.name}
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
                      <button key={n} onClick={() => setNestedSpeed(n)} disabled={isPlaying}
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
              <button onClick={() => setCompositeMode((v) => !v)}
                className={["relative inline-flex h-4 w-8 shrink-0 items-center rounded-full transition-colors",
                  compositeMode ? "bg-primary" : "bg-secondary"].join(" ")}>
                <span className={["inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform",
                  compositeMode ? "translate-x-4" : "translate-x-0.5"].join(" ")} />
              </button>
              <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Composite</span>
            </div>
            <button onClick={clearAll} disabled={!hasTrace}
              className="px-2.5 py-1 rounded text-[10px] font-medium border border-border text-muted-foreground hover:text-foreground hover:border-foreground/25 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
              Clear
            </button>
          </div>

          </>)}

        </div>
      </aside>

      {/* ── Stage ── */}
      <main className="flex-1 flex flex-col items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none" style={{
          backgroundImage: `
            radial-gradient(circle at 50% 50%, rgba(124,101,245,0.04) 0%, transparent 70%),
            linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.018) 1px, transparent 1px)
          `,
          backgroundSize: "100% 100%, 40px 40px, 40px 40px",
        }} />

        <div className="relative"
          style={{ width: "min(calc(100vw - 240px - 32px), calc(100vh - 120px))", aspectRatio: "1 / 1" }}>
          <canvas ref={canvasRef} width={600} height={600} className="absolute inset-0 w-full h-full" />
        </div>

        {/* Playback controller */}
        <div className="absolute bottom-7 left-1/2 -translate-x-1/2 z-10">
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-2xl border border-border bg-card/85 backdrop-blur-md shadow-2xl">
            <button onClick={isPlaying ? stopPlay : (drawingEngine === "threebody" ? () => { nbodyBodiesRef.current = NBODY_PRESETS[nbodyPreset].bodies.map(b => ({ ...b })); nbodyTrailsRef.current = [[], [], []]; setIsPlaying(true); } : startPlay)}
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
                <button key={mode} onClick={() => setSpeed(mode)}
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
      </main>

      {drawShapeFor !== null && (
        <DrawShapeModal
          target={drawShapeFor}
          onDone={handleDrawDone}
          onCancel={() => setDrawShapeFor(null)}
        />
      )}
    </div>
  );
}
