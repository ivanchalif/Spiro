import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildArcLengthTable,
  computeMeshState,
  gearRadius,
  totalArcLength,
  type GearShape,
} from "@/lib/gearMath";

const TWO_PI = 2 * Math.PI;
const TABLE_N = 800;
const FIXED_BASE_R = 155; // fixed ring meshing radius (virtual units)
const FIXED_TEETH  = 124; // 31 × 4  (must be integer multiple of ring radii GCD)
const POLYGON_SIDES = 5;

// ─── Gear preset set (inner gears) ───────────────────────────────────────────
// Radius law: R_m = FIXED_BASE_R × (teeth_m / FIXED_TEETH) = 155 × teeth_m / 124
// Using teeth_m = 4 × k for integer radius: R_m = 5k. All radii are multiples of 5.
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
const DEFAULT_GEAR_IDX = 4; // Standard (68T / R85)
const MAX_GEAR_R = GEAR_PRESETS[GEAR_PRESETS.length - 1].radius;

// Tooth samples per tooth for canvas path
const TOOTH_SAMPLES = 18;
// Pen hole fractions of moving gear radius
const PEN_HOLES = [0.18, 0.32, 0.46, 0.60, 0.74, 0.88];
// Rainbow
const RAINBOW_HUE_STEP   = 2;
const RAINBOW_CHUNK_FRAMES = 4;

type SpeedMode = "partial" | "full" | "accelerated";
const SPEED_DELTAS: Record<SpeedMode, number> = {
  partial: 0.005,
  full: 0.018,
  accelerated: 0.07,
};

interface TraceRun {
  points: { x: number; y: number }[];
  color: string;
  weight: number;
}

// ─── Gear icon SVG ────────────────────────────────────────────────────────────
function GearIcon({ gear, selected, iconSize = 56 }: { gear: GearPreset; selected: boolean; iconSize?: number }) {
  const cx = iconSize / 2;
  const cy = iconSize / 2;
  // Scale the gear circle relative to MAX_GEAR_R so sizes are proportional
  const maxR = iconSize * 0.42;
  const gearR = maxR * (gear.radius / MAX_GEAR_R);
  const toothH = gearR * 0.18;
  const nTeeth = 10; // simplified visual teeth count
  const N = nTeeth * 12;
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * TWO_PI;
    const profile = 0.5 * (1 - Math.cos(t * nTeeth));
    const r = gearR + toothH * profile;
    const x = cx + r * Math.cos(t - Math.PI / 2);
    const y = cy + r * Math.sin(t - Math.PI / 2);
    pts.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  pts.push("Z");

  // Holes inside the gear (3 representative holes)
  const holes = [0.35, 0.60, 0.82].map((f) => ({
    x: cx + gearR * f * Math.cos(-Math.PI / 2),
    y: cy + gearR * f * Math.sin(-Math.PI / 2),
    r: Math.max(1.5, gearR * 0.08),
  }));

  return (
    <svg width={iconSize} height={iconSize} viewBox={`0 0 ${iconSize} ${iconSize}`}>
      {/* Faint reference ring (represents the fixed outer ring boundary) */}
      <circle cx={cx} cy={cy} r={maxR * 1.04} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
      {/* Gear body */}
      <path
        d={pts.join(" ")}
        fill={selected ? gear.color + "22" : "rgba(255,255,255,0.04)"}
        stroke={gear.color}
        strokeWidth={selected ? 1.8 : 1.2}
        opacity={selected ? 1 : 0.55}
      />
      {/* Pen holes */}
      {holes.map((h, i) => (
        <circle key={i} cx={h.x} cy={h.y} r={h.r}
          fill="none" stroke={gear.color} strokeWidth="0.8" opacity={selected ? 0.8 : 0.4} />
      ))}
      {/* Center hub */}
      <circle cx={cx} cy={cy} r={gearR * 0.1} fill={gear.color} opacity={selected ? 0.7 : 0.3} />
      {/* Tooth count label */}
      <text
        x={cx} y={cy + gearR * 0.32}
        textAnchor="middle"
        fontSize={Math.max(7, gearR * 0.5)}
        fontWeight="700"
        fill={gear.color}
        opacity={selected ? 1 : 0.5}
        fontFamily="monospace"
      >
        {gear.teeth}
      </text>
    </svg>
  );
}

// ─── Slider control ───────────────────────────────────────────────────────────
function ControlSlider({
  label, value, min, max, step, onChange, onInput, display,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange?: (v: number) => void; onInput?: (v: number) => void;
  display?: (v: number) => string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between items-baseline">
        <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</label>
        {display && <span className="text-[10px] text-foreground/50 font-mono">{display(value)}</span>}
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        className="w-full h-1 accent-primary cursor-pointer"
        onChange={(e) => onChange?.(Number((e.target as HTMLInputElement).value))}
        onInput={(e) => onInput?.(Number((e.target as HTMLInputElement).value))}
      />
    </div>
  );
}

const SHAPE_LABELS: Record<GearShape, string> = {
  circle:  "Circle",
  ellipse: "Ellipse",
  polygon: "Polygon / Star",
};

// ─── Main component ────────────────────────────────────────────────────────────
export default function SpirographPage() {
  const [gearIdx,    setGearIdx]    = useState(DEFAULT_GEAR_IDX);
  const [fixedShape, setFixedShape] = useState<GearShape>("circle");
  const [movingShape,setMovingShape]= useState<GearShape>("circle");
  const [ecc,        setEcc]        = useState(0.3);
  const [penOffset,  setPenOffset]  = useState(0.65);
  const [penWeight,  setPenWeight]  = useState(2);
  const [penColor,   setPenColor]   = useState("#60a5fa"); // matches Standard gear color
  const [rainbow,    setRainbow]    = useState(false);
  const [compositeMode, setCompositeMode] = useState(false);
  const [speed,      setSpeed]      = useState<SpeedMode>("full");
  const [isPlaying,  setIsPlaying]  = useState(false);
  const [hasTrace,   setHasTrace]   = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const simRef = useRef({
    phi: 0,
    fixedTable:  new Float64Array(TABLE_N + 1) as Float64Array<ArrayBuffer>,
    movingTable: new Float64Array(TABLE_N + 1) as Float64Array<ArrayBuffer>,
    fixedShape:  "circle"  as GearShape,
    movingShape: "circle"  as GearShape,
    ecc: 0.3,
    gear: GEAR_PRESETS[DEFAULT_GEAR_IDX] as GearPreset,
    tablesReady: false,
  });

  const traceRunsRef   = useRef<TraceRun[]>([]);
  const currentRunRef  = useRef<TraceRun | null>(null);
  const rafRef         = useRef<number | null>(null);
  const hueRef         = useRef(0);

  // ─── Arc-length table builder ───────────────────────────────────────────
  const rebuildTables = useCallback((fs: GearShape, ms: GearShape, e: number, gear: GearPreset) => {
    simRef.current.fixedTable  = buildArcLengthTable(fs, FIXED_BASE_R,   e, TABLE_N, POLYGON_SIDES);
    simRef.current.movingTable = buildArcLengthTable(ms, gear.radius,     e, TABLE_N, POLYGON_SIDES);
    simRef.current.fixedShape  = fs;
    simRef.current.movingShape = ms;
    simRef.current.ecc  = e;
    simRef.current.gear = gear;
    simRef.current.tablesReady = true;
  }, []);

  const getCanvasSize = useCallback(() => {
    const c = canvasRef.current;
    return c ? Math.min(c.width, c.height) : 600;
  }, []);

  // ─── Core renderer ─────────────────────────────────────────────────────
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

    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const sim = simRef.current;
    const gear = sim.gear;

    ctx.clearRect(0, 0, W, H);

    // ── Trace runs ────────────────────────────────────────────────────
    for (const run of traceRunsRef.current) {
      if (run.points.length < 2) continue;
      ctx.save();
      ctx.strokeStyle = run.color;
      ctx.lineWidth = run.weight;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (let i = 0; i < run.points.length; i++) {
        const px = cx + run.points[i].x * scale;
        const py = cy + run.points[i].y * scale;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ── Gear geometry ─────────────────────────────────────────────────
    const fixedR  = FIXED_BASE_R * scale;
    const movingR = gear.radius   * scale;
    const ringW   = Math.max(6, fixedR * 0.12);

    // Tooth pitch: same arc per tooth for both gears (no-slip)
    const toothPitch = (TWO_PI * fixedR) / FIXED_TEETH;
    const toothH     = toothPitch * 0.38;

    const movingTeeth   = gear.teeth;
    const fixedSamples  = FIXED_TEETH   * TOOTH_SAMPLES;
    const movingSamples = movingTeeth   * TOOTH_SAMPLES;

    const rotAngle = phi - psi;
    const mcxS = mcx * scale;
    const mcyS = mcy * scale;

    ctx.save();
    ctx.translate(cx, cy);

    // ── FIXED GEAR RING ───────────────────────────────────────────────
    // evenodd: outer smooth + inner toothed → ring shape
    ctx.beginPath();
    for (let i = 0; i <= fixedSamples; i++) {
      const t = (i / fixedSamples) * TWO_PI;
      const r = gearRadius(sim.fixedShape, fixedR + ringW, sim.ecc, t, POLYGON_SIDES);
      if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
      else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
    }
    ctx.closePath();
    for (let i = 0; i <= fixedSamples; i++) {
      const t = (i / fixedSamples) * TWO_PI;
      const base = gearRadius(sim.fixedShape, fixedR, sim.ecc, t, POLYGON_SIDES);
      const r = base - toothH * 0.5 * (1 - Math.cos(t * FIXED_TEETH));
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
      const r = gearRadius(sim.fixedShape, fixedR + ringW, sim.ecc, t, POLYGON_SIDES);
      if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
      else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(170, 185, 230, 0.30)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    // Inner toothed edge
    ctx.save();
    ctx.shadowColor = "rgba(160, 175, 255, 0.25)";
    ctx.shadowBlur = 6;
    ctx.beginPath();
    for (let i = 0; i <= fixedSamples; i++) {
      const t = (i / fixedSamples) * TWO_PI;
      const base = gearRadius(sim.fixedShape, fixedR, sim.ecc, t, POLYGON_SIDES);
      const r = base - toothH * 0.5 * (1 - Math.cos(t * FIXED_TEETH));
      if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
      else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(195, 210, 255, 0.70)";
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.restore();

    // ── MOVING GEAR ───────────────────────────────────────────────────
    // Base disk
    ctx.beginPath();
    ctx.arc(mcxS, mcyS, movingR, 0, TWO_PI);
    ctx.fillStyle = gear.color + "18";
    ctx.fill();

    // Toothed outline
    ctx.beginPath();
    for (let i = 0; i <= movingSamples; i++) {
      const la = (i / movingSamples) * TWO_PI;
      const base = gearRadius(sim.movingShape, movingR, sim.ecc, la, POLYGON_SIDES);
      // π phase-offset → peaks interleave with ring valleys
      const r = base + toothH * 0.5 * (1 - Math.cos(la * movingTeeth + Math.PI));
      const wa = la + rotAngle;
      if (i === 0) ctx.moveTo(mcxS + r * Math.cos(wa), mcyS + r * Math.sin(wa));
      else         ctx.lineTo(mcxS + r * Math.cos(wa), mcyS + r * Math.sin(wa));
    }
    ctx.closePath();
    ctx.save();
    ctx.shadowColor = gear.color + "88";
    ctx.shadowBlur = 8;
    ctx.strokeStyle = gear.color + "ee";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // Spokes
    const nSpokes = Math.max(3, Math.round(movingTeeth / 22));
    ctx.save();
    ctx.strokeStyle = gear.color + "28";
    ctx.lineWidth = 0.9;
    for (let s = 0; s < nSpokes; s++) {
      const sa = rotAngle + (s / nSpokes) * TWO_PI;
      ctx.beginPath();
      ctx.moveTo(mcxS, mcyS);
      ctx.lineTo(mcxS + movingR * 0.86 * Math.cos(sa),
                 mcyS + movingR * 0.86 * Math.sin(sa));
      ctx.stroke();
    }
    ctx.restore();

    // Pen holes
    const holeR = Math.max(2, movingR * 0.052);
    for (const frac of PEN_HOLES) {
      const hr = frac * movingR;
      const hx = mcxS + hr * Math.cos(rotAngle);
      const hy = mcyS + hr * Math.sin(rotAngle);
      const isActive = Math.abs(frac - curPenOffset) < 0.08;
      ctx.beginPath();
      ctx.arc(hx, hy, holeR, 0, TWO_PI);
      ctx.fillStyle   = isActive ? gear.color + "44" : gear.color + "18";
      ctx.fill();
      ctx.strokeStyle = gear.color + "99";
      ctx.lineWidth = 0.9;
      ctx.stroke();
    }

    // Gear number label
    const labelAngle = rotAngle + Math.PI * 0.55;
    const labelR = movingR * 0.48;
    ctx.save();
    ctx.font = `bold ${Math.max(8, movingR * 0.18)}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = gear.color + "66";
    ctx.fillText(String(gear.teeth), mcxS + labelR * Math.cos(labelAngle), mcyS + labelR * Math.sin(labelAngle));
    ctx.restore();

    // Moving gear center hub
    ctx.beginPath();
    ctx.arc(mcxS, mcyS, Math.max(3, movingR * 0.07), 0, TWO_PI);
    ctx.fillStyle = gear.color + "44";
    ctx.fill();
    ctx.strokeStyle = gear.color + "bb";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Fixed gear center crosshair
    ctx.strokeStyle = "rgba(160, 180, 230, 0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-fixedR * 0.055, 0); ctx.lineTo(fixedR * 0.055, 0);
    ctx.moveTo(0, -fixedR * 0.055); ctx.lineTo(0, fixedR * 0.055);
    ctx.stroke();

    // Contact point (gold)
    const contactR = gearRadius(sim.fixedShape, fixedR, sim.ecc, phi, POLYGON_SIDES);
    ctx.save();
    ctx.shadowColor = "rgba(255,210,80,0.7)";
    ctx.shadowBlur = 9;
    ctx.beginPath();
    ctx.arc(contactR * Math.cos(phi), contactR * Math.sin(phi), 3.5, 0, TWO_PI);
    ctx.fillStyle = "rgba(255,220,70,0.95)";
    ctx.fill();
    ctx.restore();

    // Pen arm + ink dot
    const penRpx  = curPenOffset * movingR;
    const penDotX = mcxS + penRpx * Math.cos(rotAngle);
    const penDotY = mcyS + penRpx * Math.sin(rotAngle);
    ctx.beginPath();
    ctx.moveTo(mcxS, mcyS);
    ctx.lineTo(penDotX, penDotY);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.save();
    ctx.shadowColor = curPenColor + "cc";
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(penDotX, penDotY, 4.5, 0, TWO_PI);
    ctx.fillStyle = curPenColor;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }, []);

  // ─── Draw idle ──────────────────────────────────────────────────────────
  const drawIdle = useCallback((
    fs: GearShape, ms: GearShape, e: number, gear: GearPreset, pOff: number, color: string
  ) => {
    const sim = simRef.current;
    if (!sim.tablesReady) return;
    const scale = getCanvasSize() / 380;
    const state = computeMeshState(
      0, fs, FIXED_BASE_R, e, sim.fixedTable,
      ms, gear.radius, e, sim.movingTable,
      pOff, POLYGON_SIDES
    );
    renderFrame(0, state.psi, state.movingCenterX, state.movingCenterY, state.penX, state.penY, scale, color, pOff);
  }, [getCanvasSize, renderFrame]);

  // ─── Ghost trace ────────────────────────────────────────────────────────
  const drawGhost = useCallback((
    fs: GearShape, ms: GearShape, e: number, gear: GearPreset, pOff: number, color: string, weight: number
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sim = simRef.current;
    if (!sim.tablesReady) return;

    const W = canvas.width, H = canvas.height;
    const scale = Math.min(W, H) / 380;
    const cx = W / 2, cy = H / 2;
    const ft = sim.fixedTable, mt = sim.movingTable;

    const ratio = totalArcLength(ft) / totalArcLength(mt);
    const totalPhi = TWO_PI * Math.max(8, Math.ceil(ratio) * 2);
    const numSteps = 500;

    const state0 = computeMeshState(0, fs, FIXED_BASE_R, e, ft, ms, gear.radius, e, mt, pOff, POLYGON_SIDES);
    renderFrame(0, state0.psi, state0.movingCenterX, state0.movingCenterY, state0.penX, state0.penY, scale, color, pOff);

    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = color;
    ctx.lineWidth = weight * 0.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i <= numSteps; i++) {
      const ph = (i / numSteps) * totalPhi;
      const st = computeMeshState(ph, fs, FIXED_BASE_R, e, ft, ms, gear.radius, e, mt, pOff, POLYGON_SIDES);
      if (i === 0) ctx.moveTo(cx + st.penX * scale, cy + st.penY * scale);
      else         ctx.lineTo(cx + st.penX * scale, cy + st.penY * scale);
    }
    ctx.stroke();
    ctx.restore();
  }, [renderFrame]);

  // ─── Initial setup ──────────────────────────────────────────────────────
  useEffect(() => {
    rebuildTables(fixedShape, movingShape, ecc, GEAR_PRESETS[DEFAULT_GEAR_IDX]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Rebuild when key params change (idle only) ─────────────────────────
  useEffect(() => {
    if (!simRef.current.tablesReady) return;
    const gear = GEAR_PRESETS[gearIdx];
    rebuildTables(fixedShape, movingShape, ecc, gear);
    if (!isPlaying) drawIdle(fixedShape, movingShape, ecc, gear, penOffset, penColor);
  }, [gearIdx, fixedShape, movingShape, ecc]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Animation loop ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      return;
    }

    const sim = simRef.current;
    const delta = SPEED_DELTAS[speed];
    const capFS = fixedShape, capMS = movingShape, capEcc = ecc;
    const capGear = GEAR_PRESETS[gearIdx];
    const capPenOffset = penOffset, capColor = penColor, capWeight = penWeight;
    const capRainbow = rainbow;

    const ratio = totalArcLength(sim.fixedTable) / totalArcLength(sim.movingTable);
    const maxPhi = TWO_PI * Math.max(10, Math.ceil(ratio) * 3);

    let frameCount = 0;

    const loop = () => {
      const scale = getCanvasSize() / 380;
      const state = computeMeshState(
        sim.phi,
        capFS, FIXED_BASE_R, capEcc, sim.fixedTable,
        capMS, capGear.radius, capEcc, sim.movingTable,
        capPenOffset, POLYGON_SIDES
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

      if (currentRunRef.current) {
        currentRunRef.current.points.push({ x: state.penX, y: state.penY });
      }

      renderFrame(sim.phi, state.psi,
        state.movingCenterX, state.movingCenterY,
        state.penX, state.penY,
        scale, frameColor, capPenOffset);

      sim.phi += delta;
      frameCount++;
      if (sim.phi >= maxPhi) { setIsPlaying(false); return; }
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  }, [isPlaying, speed, gearIdx, fixedShape, movingShape, ecc, penOffset, penColor, penWeight, rainbow, getCanvasSize, renderFrame]);

  // ─── Canvas resize ──────────────────────────────────────────────────────
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const canvas = canvasRef.current;
      const parent = canvas?.parentElement;
      if (!canvas || !parent) return;
      const rect = parent.getBoundingClientRect();
      const size = Math.max(100, Math.floor(Math.min(rect.width, rect.height)));
      if (canvas.width === size && canvas.height === size) return;
      canvas.width = size;
      canvas.height = size;
      if (!isPlaying) drawIdle(fixedShape, movingShape, ecc, GEAR_PRESETS[gearIdx], penOffset, penColor);
    });
    const parent = canvasRef.current?.parentElement;
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
  }, [isPlaying, gearIdx, fixedShape, movingShape, ecc, penOffset, penColor, drawIdle]);

  // ─── Handlers ────────────────────────────────────────────────────────────
  const startPlay = useCallback(() => {
    const gear = GEAR_PRESETS[gearIdx];
    rebuildTables(fixedShape, movingShape, ecc, gear);
    simRef.current.phi = 0;
    hueRef.current = 0;

    const startColor = rainbow ? "hsl(0, 85%, 62%)" : penColor;
    const newRun: TraceRun = { points: [], color: startColor, weight: penWeight };
    currentRunRef.current = newRun;
    if (compositeMode) { traceRunsRef.current.push(newRun); }
    else               { traceRunsRef.current = [newRun]; }

    setHasTrace(true);
    setIsPlaying(true);
  }, [gearIdx, fixedShape, movingShape, ecc, penColor, penWeight, rainbow, compositeMode, rebuildTables]);

  const stopPlay = useCallback(() => setIsPlaying(false), []);

  const clearAll = useCallback(() => {
    stopPlay();
    traceRunsRef.current = [];
    currentRunRef.current = null;
    setHasTrace(false);
    setTimeout(() => drawIdle(fixedShape, movingShape, ecc, GEAR_PRESETS[gearIdx], penOffset, penColor), 0);
  }, [stopPlay, gearIdx, fixedShape, movingShape, ecc, penOffset, penColor, drawIdle]);

  const handleGearSelect = useCallback((idx: number) => {
    setGearIdx(idx);
    if (!isPlaying) {
      const gear = GEAR_PRESETS[idx];
      const mt = buildArcLengthTable(movingShape, gear.radius, ecc, TABLE_N, POLYGON_SIDES);
      simRef.current.movingTable = mt;
      simRef.current.gear = gear;
      simRef.current.tablesReady = true;
      drawGhost(fixedShape, movingShape, ecc, gear, penOffset, penColor, penWeight);
    }
  }, [isPlaying, fixedShape, movingShape, ecc, penOffset, penColor, penWeight, drawGhost]);

  const handleFixedShapeChange = useCallback((s: GearShape) => {
    setFixedShape(s);
    if (!isPlaying) {
      const ft = buildArcLengthTable(s, FIXED_BASE_R, ecc, TABLE_N, POLYGON_SIDES);
      simRef.current.fixedTable = ft;
      simRef.current.fixedShape = s;
      simRef.current.tablesReady = true;
      drawGhost(s, movingShape, ecc, GEAR_PRESETS[gearIdx], penOffset, penColor, penWeight);
    }
  }, [isPlaying, gearIdx, movingShape, ecc, penOffset, penColor, penWeight, drawGhost]);

  const handleMovingShapeChange = useCallback((s: GearShape) => {
    setMovingShape(s);
    if (!isPlaying) {
      const gear = GEAR_PRESETS[gearIdx];
      const mt = buildArcLengthTable(s, gear.radius, ecc, TABLE_N, POLYGON_SIDES);
      simRef.current.movingTable = mt;
      simRef.current.movingShape = s;
      simRef.current.tablesReady = true;
      drawGhost(fixedShape, s, ecc, gear, penOffset, penColor, penWeight);
    }
  }, [isPlaying, gearIdx, fixedShape, ecc, penOffset, penColor, penWeight, drawGhost]);

  const handleParamInput = useCallback((e: number, pOff: number) => {
    if (isPlaying) return;
    const gear = GEAR_PRESETS[gearIdx];
    const ft = buildArcLengthTable(fixedShape, FIXED_BASE_R,  e, TABLE_N, POLYGON_SIDES);
    const mt = buildArcLengthTable(movingShape, gear.radius, e, TABLE_N, POLYGON_SIDES);
    simRef.current.fixedTable  = ft;
    simRef.current.movingTable = mt;
    simRef.current.ecc = e;
    simRef.current.tablesReady = true;
    drawGhost(fixedShape, movingShape, e, gear, pOff, penColor, penWeight);
  }, [isPlaying, gearIdx, fixedShape, movingShape, penColor, penWeight, drawGhost]);

  const selectedGear = GEAR_PRESETS[gearIdx];
  const showEcc = fixedShape !== "circle" || movingShape !== "circle";

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">

      {/* ── Sidebar ── */}
      <aside className="w-64 shrink-0 flex flex-col border-r border-border bg-card overflow-y-auto">

        {/* Header */}
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

          {/* ── Gear Tray ─────────────────────────────────────────────── */}
          <section>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
              Inner Gear
            </p>
            {/* Gear tray: 2-column grid of gear icons, like the physical set */}
            <div className="grid grid-cols-4 gap-1.5 p-2 rounded-lg border border-border bg-background/40">
              {GEAR_PRESETS.map((g, idx) => (
                <button
                  key={g.id}
                  onClick={() => handleGearSelect(idx)}
                  title={`${g.teeth}T — ${g.name}`}
                  className={[
                    "flex flex-col items-center gap-0.5 p-0.5 rounded-md transition-all duration-150",
                    idx === gearIdx ? "bg-white/6" : "hover:bg-white/4",
                  ].join(" ")}
                  style={idx === gearIdx ? { outline: `1.5px solid ${g.color}55`, outlineOffset: "1px" } : undefined}
                >
                  <GearIcon gear={g} selected={idx === gearIdx} iconSize={44} />
                </button>
              ))}
              {/* Empty slot to fill out the grid visually */}
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

          {/* ── NCG Shapes ──────────────────────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Ring Shape</p>
            <div className="flex gap-1">
              {(["circle", "ellipse", "polygon"] as GearShape[]).map((s) => (
                <button key={s} onClick={() => handleFixedShapeChange(s)}
                  className={["px-2 py-1 rounded text-[10px] font-medium flex-1 border transition-all",
                    fixedShape === s
                      ? "bg-primary/14 text-primary border-primary/25"
                      : "text-muted-foreground hover:text-foreground border-transparent hover:bg-secondary/50"
                  ].join(" ")}>
                  {SHAPE_LABELS[s].split(" ")[0]}
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Gear Shape</p>
            <div className="flex gap-1">
              {(["circle", "ellipse", "polygon"] as GearShape[]).map((s) => (
                <button key={s} onClick={() => handleMovingShapeChange(s)}
                  className={["px-2 py-1 rounded text-[10px] font-medium flex-1 border transition-all",
                    movingShape === s
                      ? "bg-primary/14 text-primary border-primary/25"
                      : "text-muted-foreground hover:text-foreground border-transparent hover:bg-secondary/50"
                  ].join(" ")}>
                  {SHAPE_LABELS[s].split(" ")[0]}
                </button>
              ))}
            </div>
          </section>

          {showEcc && (
            <section>
              <ControlSlider
                label="Shape Depth" value={ecc} min={0.05} max={0.85} step={0.01}
                onChange={(v) => setEcc(v)}
                onInput={(v) => { setEcc(v); handleParamInput(v, penOffset); }}
                display={(v) => v.toFixed(2)}
              />
            </section>
          )}

          <div className="border-t border-border/50" />

          {/* ── Pen controls ──────────────────────────────────────────── */}
          <section>
            <ControlSlider
              label="Pen Offset" value={penOffset} min={0.01} max={1} step={0.01}
              onChange={(v) => setPenOffset(v)}
              onInput={(v) => {
                setPenOffset(v);
                handleParamInput(ecc, v);
              }}
              display={(v) => `${Math.round(v * 100)}%`}
            />
            <p className="text-[10px] text-muted-foreground/60 mt-1">0% = gear center · 100% = edge</p>
          </section>

          <section>
            <ControlSlider
              label="Pen Weight" value={penWeight} min={0.5} max={10} step={0.5}
              onChange={(v) => setPenWeight(v)}
              display={(v) => `${v}px`}
            />
          </section>

          {/* ── Ink Color + Rainbow ───────────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Ink Color</p>
              <button
                onClick={() => setRainbow((v) => !v)}
                title={rainbow ? "Rainbow on" : "Rainbow off"}
                className={[
                  "flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-all duration-200",
                  rainbow
                    ? "border-transparent text-white"
                    : "border-border text-muted-foreground hover:text-foreground",
                ].join(" ")}
                style={rainbow ? { background: "linear-gradient(90deg,#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f472b6)" } : undefined}
              >
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
              {/* Quick-pick: one swatch per gear color so you can match the gear */}
              {GEAR_PRESETS.map((g) => (
                <button key={g.id} onClick={() => setPenColor(g.color)} title={g.name}
                  className="w-5 h-5 rounded-full border transition-all hover:scale-110"
                  style={{
                    background: g.color,
                    borderColor: penColor === g.color ? g.color : "rgba(255,255,255,0.1)",
                    boxShadow: penColor === g.color ? `0 0 0 2px rgba(0,0,0,0.5),0 0 0 4px ${g.color}` : undefined,
                  }}
                />
              ))}
            </div>
          </section>

          {/* ── Composite mode ────────────────────────────────────────── */}
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
              Pick a gear · configure the lab · press ▶ to draw
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
