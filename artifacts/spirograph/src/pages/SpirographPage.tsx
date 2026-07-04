import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildArcLengthTable,
  computeMeshState,
  gearRadius,
  totalArcLength,
  type GearShape,
  type MeshMode,
} from "@/lib/gearMath";

const TWO_PI = 2 * Math.PI;
const TABLE_N = 800;
const FIXED_BASE_R = 155;
const FIXED_TEETH  = 124;
const TOOTH_SAMPLES = 18;
const PEN_HOLES = [0.18, 0.32, 0.46, 0.60, 0.74, 0.88];
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

type SpeedMode = "partial" | "full" | "accelerated";
const SPEED_DELTAS: Record<SpeedMode, number> = { partial: 0.005, full: 0.018, accelerated: 0.07 };

interface TraceRun { points: { x: number; y: number }[]; color: string; weight: number; }

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
  onShapeChange: (s: GearShape) => void;
  onEccChange:   (v: number)    => void;
  onEccInput:    (v: number)    => void;
  onSidesChange: (v: number)    => void;
  onSidesInput:  (v: number)    => void;
}
function GearShapeSection({ label, shape, ecc, sides, disabled,
  onShapeChange, onEccChange, onEccInput, onSidesChange, onSidesInput,
}: GearShapeSectionProps) {
  const POLYGON_NAMES: Record<number, string> = { 3:"▲ Tri", 4:"■ Sq", 5:"⬠ Pent", 6:"⬡ Hex", 7:"Hept", 8:"Oct" };
  return (
    <section className="flex flex-col gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
      <div className="flex gap-1">
        {(["circle", "ellipse", "polygon"] as GearShape[]).map((s) => (
          <button key={s} onClick={() => onShapeChange(s)} disabled={disabled}
            className={["px-2 py-1 rounded text-[10px] font-medium flex-1 border transition-all",
              shape === s ? "bg-primary/14 text-primary border-primary/25"
                : "text-muted-foreground hover:text-foreground border-transparent hover:bg-secondary/50",
              disabled ? "opacity-40 cursor-not-allowed" : ""].join(" ")}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
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
  const [meshMode,    setMeshMode]    = useState<MeshMode>("internal");
  const [fixedShape,  setFixedShape]  = useState<GearShape>("circle");
  const [fixedEcc,    setFixedEcc]    = useState(0.3);
  const [fixedSides,  setFixedSides]  = useState(5);
  const [movingShape, setMovingShape] = useState<GearShape>("circle");
  const [movingEcc,   setMovingEcc]   = useState(0.3);
  const [movingSides, setMovingSides] = useState(5);
  const [penOffset,   setPenOffset]   = useState(0.65);
  const [penWeight,   setPenWeight]   = useState(2);
  const [penColor,    setPenColor]    = useState("#60a5fa");
  const [rainbow,     setRainbow]     = useState(false);
  const [compositeMode, setCompositeMode] = useState(false);
  const [speed,       setSpeed]       = useState<SpeedMode>("full");
  const [isPlaying,   setIsPlaying]   = useState(false);
  const [hasTrace,    setHasTrace]    = useState(false);

  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const traceRunsRef  = useRef<TraceRun[]>([]);
  const currentRunRef = useRef<TraceRun | null>(null);
  const rafRef        = useRef<number | null>(null);
  const hueRef        = useRef(0);

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
    sim.fixedTable   = buildArcLengthTable(fShape, FIXED_BASE_R, fEcc, TABLE_N, fSides);
    sim.movingTable  = buildArcLengthTable(mShape, gear.radius,  mEcc, TABLE_N, mSides);
    sim.fixedShape   = fShape; sim.fixedEcc   = fEcc; sim.fixedSides  = fSides;
    sim.movingShape  = mShape; sim.movingEcc  = mEcc; sim.movingSides = mSides;
    sim.meshMode     = mode;
    sim.gear         = gear;
    // rack centering: origin at midpoint of 2-cycle travel
    sim.rackOffX     = gear.radius * RACK_MAX_PHI / 2;
    sim.rackOffY     = gear.radius;
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
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sim  = simRef.current;
    const gear = sim.gear;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;

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

    // Rotation angle for moving gear body in world frame
    const rotAngle = sim.meshMode === "external" ? phi + psi + Math.PI
                   : sim.meshMode === "rack"     ? -psi
                   : phi - psi; // internal

    // Moving gear center in screen space
    const mcxS = (mcx - offX) * scale;
    const mcyS = (mcy - offY) * scale;

    ctx.save();
    ctx.translate(cx, cy);

    // ── Fixed gear / rack rendering ──────────────────────────────────────────
    if (sim.meshMode === "rack") {
      // ── RACK BAR with toothed top edge ─────────────────────────────────────
      const barY = (0 - offY) * scale; // rack surface in screen space
      const rackHalfW = sim.rackOffX * scale * 1.08;
      const barH = Math.max(8, toothH * 1.5);
      const rackToothPitch = toothPitch; // same pitch as moving gear
      const nRackPts = Math.round(rackHalfW * 2 / rackToothPitch) * 12;

      // Fill body
      ctx.fillStyle = "rgba(200, 215, 245, 0.08)";
      ctx.beginPath();
      ctx.rect(-rackHalfW, barY, rackHalfW * 2, barH);
      ctx.fill();

      // Toothed top edge
      ctx.save();
      ctx.shadowColor = "rgba(160, 175, 255, 0.3)";
      ctx.shadowBlur = 5;
      ctx.beginPath();
      ctx.moveTo(-rackHalfW, barY);
      for (let i = 0; i <= nRackPts; i++) {
        const x = -rackHalfW + (i / nRackPts) * rackHalfW * 2;
        // position along rack in tooth units
        const toothPhase = (x + rackHalfW) / rackToothPitch;
        const profile = 0.5 * (1 - Math.cos(toothPhase * TWO_PI));
        ctx.lineTo(x, barY - toothH * profile);
      }
      ctx.lineTo(rackHalfW, barY);
      ctx.closePath();
      ctx.strokeStyle = "rgba(195, 210, 255, 0.70)";
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.fillStyle = "rgba(200, 215, 245, 0.07)";
      ctx.fill();
      ctx.restore();

      // Contact point (gold dot on rack surface below gear center)
      const contactX = mcxS;
      ctx.save();
      ctx.shadowColor = "rgba(255,210,80,0.7)";
      ctx.shadowBlur  = 9;
      ctx.beginPath();
      ctx.arc(contactX, barY, 3.5, 0, TWO_PI);
      ctx.fillStyle = "rgba(255,220,70,0.95)";
      ctx.fill();
      ctx.restore();

    } else if (sim.meshMode === "external") {
      // ── CENTRAL HUB (small solid circle with outward teeth) ────────────────
      const hubR = fixedR * 0.55;
      const hubTeeth = Math.round(FIXED_TEETH * 0.55); // scaled tooth count
      const hubSamples = hubTeeth * TOOTH_SAMPLES;

      // Hub body
      ctx.beginPath();
      ctx.arc(0, 0, hubR, 0, TWO_PI);
      ctx.fillStyle = "rgba(200, 215, 245, 0.10)";
      ctx.fill();

      // Outward teeth on hub
      ctx.save();
      ctx.shadowColor = "rgba(160, 175, 255, 0.3)";
      ctx.shadowBlur  = 6;
      ctx.beginPath();
      for (let i = 0; i <= hubSamples; i++) {
        const t    = (i / hubSamples) * TWO_PI;
        const base = gearRadius(sim.fixedShape, hubR, sim.fixedEcc, t, sim.fixedSides);
        const r    = base + toothH * 0.5 * (1 - Math.cos(t * hubTeeth + Math.PI));
        if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
        else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
      }
      ctx.closePath();
      ctx.strokeStyle = "rgba(195, 210, 255, 0.70)";
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.restore();

      // Hub rim
      ctx.beginPath();
      ctx.arc(0, 0, hubR + ringW * 0.3, 0, TWO_PI);
      ctx.strokeStyle = "rgba(180, 195, 240, 0.25)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Contact point
      const contactR = gearRadius(sim.fixedShape, hubR, sim.fixedEcc, phi, sim.fixedSides);
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
        const r = gearRadius(sim.fixedShape, fixedR + ringW, sim.fixedEcc, t, sim.fixedSides);
        if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
        else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
      }
      ctx.closePath();
      for (let i = 0; i <= fixedSamples; i++) {
        const t    = (i / fixedSamples) * TWO_PI;
        const base = gearRadius(sim.fixedShape, fixedR, sim.fixedEcc, t, sim.fixedSides);
        const r    = base - toothH * 0.5 * (1 - Math.cos(t * FIXED_TEETH));
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
        const r = gearRadius(sim.fixedShape, fixedR + ringW, sim.fixedEcc, t, sim.fixedSides);
        if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
        else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
      }
      ctx.closePath();
      ctx.strokeStyle = "rgba(180, 195, 240, 0.30)";
      ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();

      // Inner toothed edge
      ctx.save();
      ctx.shadowColor = "rgba(160, 175, 255, 0.25)";
      ctx.shadowBlur  = 6;
      ctx.beginPath();
      for (let i = 0; i <= fixedSamples; i++) {
        const t    = (i / fixedSamples) * TWO_PI;
        const base = gearRadius(sim.fixedShape, fixedR, sim.fixedEcc, t, sim.fixedSides);
        const r    = base - toothH * 0.5 * (1 - Math.cos(t * FIXED_TEETH));
        if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
        else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
      }
      ctx.closePath();
      ctx.strokeStyle = "rgba(195, 210, 255, 0.70)";
      ctx.lineWidth = 1.3; ctx.stroke();
      ctx.restore();

      // Contact point
      const contactR = gearRadius(sim.fixedShape, fixedR, sim.fixedEcc, phi, sim.fixedSides);
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

    // Toothed outline
    ctx.beginPath();
    for (let i = 0; i <= movingSamples; i++) {
      const la   = (i / movingSamples) * TWO_PI;
      const base = gearRadius(sim.movingShape, movingR, sim.movingEcc, la, sim.movingSides);
      const r    = base + toothH * 0.5 * (1 - Math.cos(la * movingTeeth + Math.PI));
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

    // Pen arm + dot
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
    const totalPhi = mode === "rack"
      ? RACK_MAX_PHI
      : TWO_PI * Math.max(8, Math.ceil(ratio) * 2);
    const numSteps = 500;

    const phi0 = mode === "rack" ? sim.rackOffX / gear.radius : 0;
    const state0 = computeMeshState(
      phi0, fShape, FIXED_BASE_R, fEcc, ft, fSides,
      mShape, gear.radius, mEcc, mt, mSides, pOff, mode,
    );
    renderFrame(phi0, state0.psi, state0.movingCenterX, state0.movingCenterY,
      state0.penX, state0.penY, scale, color, pOff);

    // Ghost trace overlay
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = color;
    ctx.lineWidth = weight * 0.8;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i <= numSteps; i++) {
      const ph = (i / numSteps) * totalPhi;
      const st = computeMeshState(
        ph, fShape, FIXED_BASE_R, fEcc, ft, fSides,
        mShape, gear.radius, mEcc, mt, mSides, pOff, mode,
      );
      const px = cx + (st.penX - offX) * scale;
      const py = cy + (st.penY - offY) * scale;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
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
    const gear = GEAR_PRESETS[gearIdx];
    rebuildTables(fixedShape, fixedEcc, fixedSides,
      movingShape, movingEcc, movingSides, gear, meshMode);
    if (!isPlaying) drawIdle(fixedShape, fixedEcc, fixedSides,
      movingShape, movingEcc, movingSides, gear, meshMode, penOffset, penColor);
  }, [gearIdx, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Animation loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      return;
    }
    const sim = simRef.current;
    const delta = SPEED_DELTAS[speed];
    const capGear    = GEAR_PRESETS[gearIdx];
    const capMode    = meshMode;
    const capFShape  = fixedShape;  const capFEcc  = fixedEcc;  const capFSides = fixedSides;
    const capMShape  = movingShape; const capMEcc  = movingEcc; const capMSides = movingSides;
    const capPen     = penOffset;   const capColor = penColor;  const capWeight = penWeight;
    const capRainbow = rainbow;     const capComposite = compositeMode;

    const ratio  = totalArcLength(sim.fixedTable) / totalArcLength(sim.movingTable);
    const maxPhi = capMode === "rack"
      ? RACK_MAX_PHI
      : TWO_PI * Math.max(10, Math.ceil(ratio) * 3);

    let frameCount = 0;
    const loop = () => {
      const canvasSize = getCanvasSize();
      const scale = computeScale(capMode, capGear, canvasSize);
      const state = computeMeshState(
        sim.phi,
        capFShape, FIXED_BASE_R, capFEcc, sim.fixedTable, capFSides,
        capMShape, capGear.radius, capMEcc, sim.movingTable, capMSides,
        capPen, capMode,
      );

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

      currentRunRef.current?.points.push({ x: state.penX, y: state.penY });

      renderFrame(sim.phi, state.psi,
        state.movingCenterX, state.movingCenterY,
        state.penX, state.penY, scale, frameColor, capPen);

      sim.phi += delta;
      frameCount++;

      if (sim.phi >= maxPhi) {
        if (capComposite) {
          sim.phi = 0;
          const newRun: TraceRun = { points: [], color: frameColor, weight: capWeight };
          traceRunsRef.current.push(newRun);
          currentRunRef.current = newRun;
        } else {
          setIsPlaying(false);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  }, [isPlaying, speed, gearIdx, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides,
      penOffset, penColor, penWeight, rainbow, compositeMode, getCanvasSize, renderFrame]);

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
        movingShape, movingEcc, movingSides, GEAR_PRESETS[gearIdx], meshMode, penOffset, penColor);
    });
    const parent = canvasRef.current?.parentElement;
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
  }, [isPlaying, gearIdx, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides,
      penOffset, penColor, drawIdle]);

  // ─── Shared param helper ─────────────────────────────────────────────────────
  const applyGearParams = useCallback((
    fShape: GearShape, fEcc: number, fSides: number,
    mShape: GearShape, mEcc: number, mSides: number,
    gear: GearPreset, mode: MeshMode, pOff: number,
  ) => {
    if (isPlaying) return;
    rebuildTables(fShape, fEcc, fSides, mShape, mEcc, mSides, gear, mode);
    drawGhost(fShape, fEcc, fSides, mShape, mEcc, mSides, gear, mode, pOff, penColor, penWeight);
  }, [isPlaying, penColor, penWeight, rebuildTables, drawGhost]);

  const g   = () => GEAR_PRESETS[gearIdx];
  const cur = () => ({ fShape: fixedShape, fEcc: fixedEcc, fSides: fixedSides,
                       mShape: movingShape, mEcc: movingEcc, mSides: movingSides,
                       gear: g(), mode: meshMode });

  // ─── Handlers ────────────────────────────────────────────────────────────────
  const handleGearSelect = useCallback((idx: number) => {
    setGearIdx(idx);
    const { fShape, fEcc, fSides, mShape, mEcc, mSides, mode } = cur();
    if (!isPlaying) applyGearParams(fShape, fEcc, fSides, mShape, mEcc, mSides, GEAR_PRESETS[idx], mode, penOffset);
  }, [isPlaying, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides, meshMode, penOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleMeshMode = useCallback((mode: MeshMode) => {
    setMeshMode(mode);
    const { fShape, fEcc, fSides, mShape, mEcc, mSides, gear } = cur();
    if (!isPlaying) applyGearParams(fShape, fEcc, fSides, mShape, mEcc, mSides, gear, mode, penOffset);
  }, [isPlaying, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides, gearIdx, penOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFixedShape  = useCallback((s: GearShape) => { setFixedShape(s);  const c = cur(); applyGearParams(s, c.fEcc, c.fSides, c.mShape, c.mEcc, c.mSides, c.gear, c.mode, penOffset); }, [fixedEcc, fixedSides, movingShape, movingEcc, movingSides, gearIdx, meshMode, penOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleFixedEcc    = useCallback((v: number)    => { setFixedEcc(v);    const c = cur(); applyGearParams(c.fShape, v, c.fSides, c.mShape, c.mEcc, c.mSides, c.gear, c.mode, penOffset); }, [fixedShape, fixedSides, movingShape, movingEcc, movingSides, gearIdx, meshMode, penOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleFixedSides  = useCallback((v: number)    => { setFixedSides(v);  const c = cur(); applyGearParams(c.fShape, c.fEcc, v, c.mShape, c.mEcc, c.mSides, c.gear, c.mode, penOffset); }, [fixedShape, fixedEcc, movingShape, movingEcc, movingSides, gearIdx, meshMode, penOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleMovingShape = useCallback((s: GearShape) => { setMovingShape(s); const c = cur(); applyGearParams(c.fShape, c.fEcc, c.fSides, s, c.mEcc, c.mSides, c.gear, c.mode, penOffset); }, [fixedShape, fixedEcc, fixedSides, movingEcc, movingSides, gearIdx, meshMode, penOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleMovingEcc   = useCallback((v: number)    => { setMovingEcc(v);   const c = cur(); applyGearParams(c.fShape, c.fEcc, c.fSides, c.mShape, v, c.mSides, c.gear, c.mode, penOffset); }, [fixedShape, fixedEcc, fixedSides, movingShape, movingSides, gearIdx, meshMode, penOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleMovingSides = useCallback((v: number)    => { setMovingSides(v); const c = cur(); applyGearParams(c.fShape, c.fEcc, c.fSides, c.mShape, c.mEcc, v, c.gear, c.mode, penOffset); }, [fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, gearIdx, meshMode, penOffset, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps
  const handlePenOffset   = useCallback((v: number)    => { setPenOffset(v);   const c = cur(); applyGearParams(c.fShape, c.fEcc, c.fSides, c.mShape, c.mEcc, c.mSides, c.gear, c.mode, v); }, [fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides, gearIdx, meshMode, applyGearParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const startPlay = useCallback(() => {
    const gear = GEAR_PRESETS[gearIdx];
    rebuildTables(fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides, gear, meshMode);
    simRef.current.phi = 0;
    hueRef.current = 0;
    const startColor = rainbow ? "hsl(0,85%,62%)" : penColor;
    const newRun: TraceRun = { points: [], color: startColor, weight: penWeight };
    currentRunRef.current = newRun;
    if (compositeMode) traceRunsRef.current.push(newRun);
    else               traceRunsRef.current = [newRun];
    setHasTrace(true);
    setIsPlaying(true);
  }, [gearIdx, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides,
      penColor, penWeight, rainbow, compositeMode, rebuildTables]);

  const stopPlay = useCallback(() => setIsPlaying(false), []);

  const clearAll = useCallback(() => {
    stopPlay();
    traceRunsRef.current = []; currentRunRef.current = null;
    setHasTrace(false);
    const gear = GEAR_PRESETS[gearIdx];
    setTimeout(() => drawIdle(fixedShape, fixedEcc, fixedSides,
      movingShape, movingEcc, movingSides, gear, meshMode, penOffset, penColor), 0);
  }, [stopPlay, gearIdx, meshMode, fixedShape, fixedEcc, fixedSides, movingShape, movingEcc, movingSides,
      penOffset, penColor, drawIdle]);

  const selectedGear = GEAR_PRESETS[gearIdx];

  const MESH_OPTIONS: { mode: MeshMode; label: string; title: string }[] = [
    { mode: "internal", label: "Ring",   title: "Hypocycloid — gear inside the ring" },
    { mode: "external", label: "Orbit",  title: "Epicycloid — gear orbits outside a hub" },
    { mode: "rack",     label: "Rack",   title: "Trochoid — gear rolls along a straight bar" },
  ];

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">

      {/* ── Sidebar ── */}
      <aside className="w-64 shrink-0 flex flex-col border-r border-border bg-card overflow-y-auto">
        <div className="px-5 pt-5 pb-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-full bg-primary/15 border border-primary/20 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="9" className="stroke-primary/40" />
                <circle cx="12" cy="12" r="5" className="stroke-primary/70" />
                <circle cx="12" cy="12" r="1.5" className="fill-primary stroke-none" />
              </svg>
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-tight">Spirograph NCG</h1>
              <p className="text-[10px] text-muted-foreground">Non-Circular Gear Engine</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 px-4 py-4 flex-1">

          {/* ── Mesh Mode ─────────────────────────────────────────── */}
          <section>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">Mode</p>
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
            <p className="text-[10px] text-muted-foreground/50 mt-1">
              {meshMode === "internal" ? "Gear inside ring — hypocycloid"
               : meshMode === "external" ? "Gear orbits hub — epicycloid"
               : "Gear on straight bar — trochoid"}
            </p>
          </section>

          <div className="border-t border-border/50" />

          {/* ── Gear Tray ────────────────────────────────────────── */}
          <section>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">Inner Gear</p>
            <div className="grid grid-cols-4 gap-1.5 p-2 rounded-lg border border-border bg-background/40">
              {GEAR_PRESETS.map((gear, idx) => (
                <button key={gear.id} onClick={() => handleGearSelect(idx)}
                  title={`${gear.teeth}T — ${gear.name}`}
                  className={["flex items-center justify-center p-0.5 rounded-md transition-all duration-150",
                    idx === gearIdx ? "bg-white/6" : "hover:bg-white/4"].join(" ")}
                  style={idx === gearIdx ? { outline: `1.5px solid ${gear.color}55`, outlineOffset: "1px" } : undefined}>
                  <GearIcon gear={gear} selected={idx === gearIdx} iconSize={44} />
                </button>
              ))}
              <div className="flex items-center justify-center opacity-20">
                <svg width="44" height="44" viewBox="0 0 44 44">
                  <circle cx="22" cy="22" r="18" fill="none" stroke="white" strokeWidth="1" strokeDasharray="3 3" />
                </svg>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground/60 mt-1.5">
              {selectedGear.teeth}T · {selectedGear.name} · R{selectedGear.radius}
            </p>
          </section>

          <div className="border-t border-border/50" />

          {/* ── Outer Gear shape ─────────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-primary/60 shrink-0" />
              <p className="text-[11px] font-bold uppercase tracking-widest text-foreground/70">Outer Gear</p>
            </div>
            <GearShapeSection
              label="Shape" shape={fixedShape} ecc={fixedEcc} sides={fixedSides} disabled={isPlaying}
              onShapeChange={handleFixedShape} onEccChange={handleFixedEcc} onEccInput={handleFixedEcc}
              onSidesChange={handleFixedSides} onSidesInput={handleFixedSides}
            />
          </div>

          <div className="h-px bg-border/50" />

          {/* ── Inner Gear shape ─────────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-teal-400/60 shrink-0" />
              <p className="text-[11px] font-bold uppercase tracking-widest text-foreground/70">Inner Gear</p>
            </div>
            <GearShapeSection
              label="Shape" shape={movingShape} ecc={movingEcc} sides={movingSides} disabled={isPlaying}
              onShapeChange={handleMovingShape} onEccChange={handleMovingEcc} onEccInput={handleMovingEcc}
              onSidesChange={handleMovingSides} onSidesInput={handleMovingSides}
            />
          </div>

          <div className="h-px bg-border/50" />

          {/* ── Pen controls ─────────────────────────────────────── */}
          <section>
            <ControlSlider label="Pen Offset" value={penOffset} min={0.01} max={1} step={0.01}
              onChange={(v) => setPenOffset(v)} onInput={handlePenOffset}
              display={(v) => `${Math.round(v * 100)}%`} />
            <p className="text-[10px] text-muted-foreground/60 mt-1">0% = gear center · 100% = edge</p>
          </section>

          <section>
            <ControlSlider label="Pen Weight" value={penWeight} min={0.5} max={10} step={0.5}
              onChange={(v) => setPenWeight(v)} display={(v) => `${v}px`} />
          </section>

          {/* ── Ink Color + Rainbow ───────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Ink Color</p>
              <button onClick={() => setRainbow((v) => !v)}
                className={["flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-all",
                  rainbow ? "border-transparent text-white" : "border-border text-muted-foreground hover:text-foreground"].join(" ")}
                style={rainbow ? { background: "linear-gradient(90deg,#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f472b6)" } : undefined}>
                ✦ Rainbow
              </button>
            </div>
            <div className={["flex items-center gap-3 transition-opacity", rainbow ? "opacity-40 pointer-events-none" : ""].join(" ")}>
              <label className="relative w-8 h-8 cursor-pointer">
                <input type="color" value={penColor} onChange={(e) => setPenColor(e.target.value)}
                  className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
                <span className="absolute inset-0 rounded-full border-2 border-white/20" style={{ background: penColor }} />
              </label>
              <span className="text-xs font-mono text-foreground/50">{penColor.toUpperCase()}</span>
            </div>
            <div className={["flex flex-wrap gap-1.5 transition-opacity", rainbow ? "opacity-40 pointer-events-none" : ""].join(" ")}>
              {GEAR_PRESETS.map((gear) => (
                <button key={gear.id} onClick={() => setPenColor(gear.color)} title={gear.name}
                  className="w-5 h-5 rounded-full border transition-all hover:scale-110"
                  style={{
                    background: gear.color,
                    borderColor: penColor === gear.color ? gear.color : "rgba(255,255,255,0.1)",
                    boxShadow: penColor === gear.color ? `0 0 0 2px rgba(0,0,0,0.5),0 0 0 4px ${gear.color}` : undefined,
                  }} />
              ))}
            </div>
          </section>

          {/* ── Composite mode ────────────────────────────────────── */}
          <section>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Composite Mode</p>
                <p className="text-[10px] text-muted-foreground/60 mt-0.5">Layer multiple traces.</p>
              </div>
              <button onClick={() => setCompositeMode((v) => !v)}
                className={["relative inline-flex h-5 w-9 shrink-0 mt-0.5 items-center rounded-full transition-colors",
                  compositeMode ? "bg-primary" : "bg-secondary"].join(" ")}>
                <span className={["inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform",
                  compositeMode ? "translate-x-4" : "translate-x-0.5"].join(" ")} />
              </button>
            </div>
          </section>

          <section>
            <button onClick={clearAll} disabled={!hasTrace}
              className="w-full px-3 py-2 rounded-md text-xs font-medium border border-border text-muted-foreground hover:text-foreground hover:border-foreground/25 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
              Clear Canvas
            </button>
          </section>

        </div>

        <div className="px-4 py-3 border-t border-border">
          <p className="text-[10px] text-muted-foreground/40">Arc-length integration · No-slip meshing</p>
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
          style={{ width: "min(calc(100vw - 256px - 32px), calc(100vh - 120px))", aspectRatio: "1 / 1" }}>
          <canvas ref={canvasRef} width={600} height={600} className="absolute inset-0 w-full h-full" />
        </div>

        {/* Playback controller */}
        <div className="absolute bottom-7 left-1/2 -translate-x-1/2 z-10">
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-2xl border border-border bg-card/85 backdrop-blur-md shadow-2xl">
            <button onClick={isPlaying ? stopPlay : startPlay}
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
                  <span className="text-[10px] text-primary font-medium">Drawing</span>
                </div>
              </>
            )}
          </div>
        </div>

        {!isPlaying && !hasTrace && (
          <div className="absolute top-5 left-1/2 -translate-x-1/2 pointer-events-none">
            <p className="text-[11px] text-muted-foreground/45 tracking-wide">
              Pick a mode · configure gears · press ▶ to draw
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
