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
const FIXED_BASE_R = 155;
const MOVING_BASE_R = 85;
const POLYGON_SIDES = 5;

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

// Tooth counts: ratio must equal FIXED_BASE_R / MOVING_BASE_R = 155/85 = 31/17
const N_FIXED_TEETH = 124; // 31 × 4
const N_MOVING_TEETH = 68; // 17 × 4
const TOOTH_SAMPLES = 18;

// Pen-hole positions (fraction of moving gear radius)
const PEN_HOLES = [0.18, 0.32, 0.46, 0.60, 0.74, 0.88];

// Rainbow hue advances this many degrees per animation frame
const RAINBOW_HUE_STEP = 2;
// Start a new mini-run every N frames when rainbow is on (gives each segment one color)
const RAINBOW_CHUNK_FRAMES = 4;

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
  circle: "Circle",
  ellipse: "Ellipse",
  polygon: "Polygon / Star",
};

function ShapeSelector({
  label, value, onChange,
}: {
  label: string;
  value: GearShape;
  onChange: (s: GearShape) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
      <div className="flex flex-col gap-1">
        {(["circle", "ellipse", "polygon"] as GearShape[]).map((s) => (
          <button
            key={s}
            onClick={() => onChange(s)}
            className={[
              "px-3 py-1.5 rounded-md text-xs font-medium text-left transition-all duration-150",
              value === s
                ? "bg-primary/14 text-primary border border-primary/25"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/60 border border-transparent",
            ].join(" ")}
          >
            {SHAPE_LABELS[s]}
          </button>
        ))}
      </div>
    </section>
  );
}

export default function SpirographPage() {
  const [fixedShape, setFixedShape] = useState<GearShape>("circle");
  const [movingShape, setMovingShape] = useState<GearShape>("circle");
  const [ecc, setEcc] = useState(0.3);
  const [penOffset, setPenOffset] = useState(0.65);
  const [penWeight, setPenWeight] = useState(2);
  const [penColor, setPenColor] = useState("#a78bfa");
  const [rainbow, setRainbow] = useState(false);
  const [compositeMode, setCompositeMode] = useState(false);
  const [speed, setSpeed] = useState<SpeedMode>("full");
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasTrace, setHasTrace] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const simRef = useRef({
    phi: 0,
    fixedTable: new Float64Array(TABLE_N + 1) as Float64Array<ArrayBuffer>,
    movingTable: new Float64Array(TABLE_N + 1) as Float64Array<ArrayBuffer>,
    fixedShape: "circle" as GearShape,
    movingShape: "circle" as GearShape,
    ecc: 0.3,
    tablesReady: false,
  });

  const traceRunsRef = useRef<TraceRun[]>([]);
  const currentRunRef = useRef<TraceRun | null>(null);
  const rafRef = useRef<number | null>(null);
  const hueRef = useRef(0); // current hue angle for rainbow mode

  // ─── Arc-length table builder ─────────────────────────────────────────────
  const rebuildTables = useCallback((fs: GearShape, ms: GearShape, e: number) => {
    simRef.current.fixedTable  = buildArcLengthTable(fs, FIXED_BASE_R,  e, TABLE_N, POLYGON_SIDES);
    simRef.current.movingTable = buildArcLengthTable(ms, MOVING_BASE_R, e, TABLE_N, POLYGON_SIDES);
    simRef.current.fixedShape  = fs;
    simRef.current.movingShape = ms;
    simRef.current.ecc = e;
    simRef.current.tablesReady = true;
  }, []);

  const getCanvasSize = useCallback(() => {
    const c = canvasRef.current;
    return c ? Math.min(c.width, c.height) : 600;
  }, []);

  // ─── Core renderer: all trace runs + gears on the single canvas ───────────
  const renderFrame = useCallback((
    phi: number,
    psi: number,
    mcx: number,
    mcy: number,
    penX: number,
    penY: number,
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

    ctx.clearRect(0, 0, W, H);

    // ── Draw all accumulated trace runs ──────────────────────────────────
    const runs = traceRunsRef.current;
    for (const run of runs) {
      if (run.points.length < 2) continue;
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = run.color;
      ctx.lineWidth = run.weight;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (let i = 0; i < run.points.length; i++) {
        const { x, y } = run.points[i];
        const px = cx + x * scale;
        const py = cy + y * scale;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ── Gear geometry ─────────────────────────────────────────────────────
    const fixedR  = FIXED_BASE_R  * scale;
    const movingR = MOVING_BASE_R * scale;
    const toothH  = Math.max(5, fixedR * 0.048);
    const ringW   = Math.max(6, fixedR * 0.12);
    const rotAngle = phi - psi;
    const mcxS = mcx * scale;
    const mcyS = mcy * scale;

    const fixedSamples  = N_FIXED_TEETH  * TOOTH_SAMPLES;
    const movingSamples = N_MOVING_TEETH * TOOTH_SAMPLES;

    ctx.save();
    ctx.translate(cx, cy);

    // ── FIXED GEAR RING (evenodd: outer smooth + inner toothed) ──────────
    ctx.beginPath();

    // Outer boundary (smooth, scaled-up gear profile)
    for (let i = 0; i <= fixedSamples; i++) {
      const t = (i / fixedSamples) * TWO_PI;
      const r = gearRadius(sim.fixedShape, fixedR + ringW, sim.ecc, t, POLYGON_SIDES);
      if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
      else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
    }
    ctx.closePath();

    // Inner toothed boundary (teeth point inward)
    for (let i = 0; i <= fixedSamples; i++) {
      const t = (i / fixedSamples) * TWO_PI;
      const base = gearRadius(sim.fixedShape, fixedR, sim.ecc, t, POLYGON_SIDES);
      const profile = 0.5 * (1 - Math.cos(t * N_FIXED_TEETH));
      const r = base - toothH * profile;
      if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
      else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
    }
    ctx.closePath();

    ctx.fillStyle = "rgba(200, 215, 245, 0.10)";
    ctx.fill("evenodd");

    // Outer rim stroke
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

    // Inner toothed edge stroke (glowing)
    ctx.save();
    ctx.shadowColor = "rgba(160, 175, 255, 0.25)";
    ctx.shadowBlur = 6;
    ctx.beginPath();
    for (let i = 0; i <= fixedSamples; i++) {
      const t = (i / fixedSamples) * TWO_PI;
      const base = gearRadius(sim.fixedShape, fixedR, sim.ecc, t, POLYGON_SIDES);
      const profile = 0.5 * (1 - Math.cos(t * N_FIXED_TEETH));
      const r = base - toothH * profile;
      if (i === 0) ctx.moveTo(r * Math.cos(t), r * Math.sin(t));
      else         ctx.lineTo(r * Math.cos(t), r * Math.sin(t));
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(195, 210, 255, 0.70)";
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.restore();

    // ── MOVING GEAR (base disk + toothed outline) ─────────────────────────
    ctx.beginPath();
    ctx.arc(mcxS, mcyS, movingR, 0, TWO_PI);
    ctx.fillStyle = "rgba(155, 180, 230, 0.14)";
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i <= movingSamples; i++) {
      const localAngle = (i / movingSamples) * TWO_PI;
      const base = gearRadius(sim.movingShape, movingR, sim.ecc, localAngle, POLYGON_SIDES);
      const profile = 0.5 * (1 - Math.cos(localAngle * N_MOVING_TEETH + Math.PI));
      const r = base + toothH * profile;
      const worldAngle = localAngle + rotAngle;
      const x = mcxS + r * Math.cos(worldAngle);
      const y = mcyS + r * Math.sin(worldAngle);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();

    ctx.save();
    ctx.shadowColor = "rgba(160, 205, 255, 0.55)";
    ctx.shadowBlur = 10;
    ctx.strokeStyle = "rgba(210, 228, 255, 0.92)";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();

    // Spokes inside moving gear
    const nSpokes = 4;
    ctx.save();
    ctx.strokeStyle = "rgba(170, 195, 240, 0.18)";
    ctx.lineWidth = 0.8;
    for (let s = 0; s < nSpokes; s++) {
      const spokeAngle = rotAngle + (s / nSpokes) * TWO_PI;
      ctx.beginPath();
      ctx.moveTo(mcxS, mcyS);
      ctx.lineTo(mcxS + movingR * 0.88 * Math.cos(spokeAngle),
                 mcyS + movingR * 0.88 * Math.sin(spokeAngle));
      ctx.stroke();
    }
    ctx.restore();

    // Pen holes on moving gear
    const holeR = Math.max(2.5, movingR * 0.055);
    for (const frac of PEN_HOLES) {
      const hr = frac * movingR;
      const hx = mcxS + hr * Math.cos(rotAngle);
      const hy = mcyS + hr * Math.sin(rotAngle);
      const isActive = Math.abs(frac - curPenOffset) < 0.08;
      ctx.beginPath();
      ctx.arc(hx, hy, holeR, 0, TWO_PI);
      ctx.fillStyle   = isActive ? "rgba(255,255,255,0.22)" : "rgba(140,160,210,0.14)";
      ctx.fill();
      ctx.strokeStyle = "rgba(185, 205, 255, 0.55)";
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // Moving gear center hub
    ctx.beginPath();
    ctx.arc(mcxS, mcyS, Math.max(3, movingR * 0.06), 0, TWO_PI);
    ctx.fillStyle = "rgba(160, 200, 255, 0.25)";
    ctx.fill();
    ctx.strokeStyle = "rgba(185, 210, 255, 0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Fixed gear center crosshair
    ctx.strokeStyle = "rgba(160, 180, 230, 0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-fixedR * 0.055, 0); ctx.lineTo(fixedR * 0.055, 0);
    ctx.moveTo(0, -fixedR * 0.055); ctx.lineTo(0, fixedR * 0.055);
    ctx.stroke();

    // Contact point dot (gold)
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

  // ─── Draw idle state (no animation) ─────────────────────────────────────
  const drawIdle = useCallback((fs: GearShape, ms: GearShape, e: number, pOff: number, color: string) => {
    const sim = simRef.current;
    if (!sim.tablesReady) return;
    const scale = getCanvasSize() / 380;
    const state = computeMeshState(
      0, fs, FIXED_BASE_R, e, sim.fixedTable,
      ms, MOVING_BASE_R, e, sim.movingTable,
      pOff, POLYGON_SIDES
    );
    renderFrame(0, state.psi, state.movingCenterX, state.movingCenterY, state.penX, state.penY, scale, color, pOff);
  }, [getCanvasSize, renderFrame]);

  // ─── Ghost trace preview ─────────────────────────────────────────────────
  const drawGhost = useCallback((fs: GearShape, ms: GearShape, e: number, pOff: number, color: string, weight: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sim = simRef.current;
    if (!sim.tablesReady) return;

    const W = canvas.width;
    const H = canvas.height;
    const scale = Math.min(W, H) / 380;
    const cx = W / 2;
    const cy = H / 2;

    const ft = sim.fixedTable;
    const mt = sim.movingTable;
    const totalFixed = totalArcLength(ft);
    const totalMoving = totalArcLength(mt);
    const ratio = totalFixed / totalMoving;
    const numRounds = Math.max(8, Math.ceil(ratio) * 2);
    const totalPhi = TWO_PI * numRounds;
    const numSteps = 500;

    const state0 = computeMeshState(0, fs, FIXED_BASE_R, e, ft, ms, MOVING_BASE_R, e, mt, pOff, POLYGON_SIDES);
    renderFrame(0, state0.psi, state0.movingCenterX, state0.movingCenterY, state0.penX, state0.penY, scale, color, pOff);

    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = color;
    ctx.lineWidth = weight * 0.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i <= numSteps; i++) {
      const phi = (i / numSteps) * totalPhi;
      const st = computeMeshState(phi, fs, FIXED_BASE_R, e, ft, ms, MOVING_BASE_R, e, mt, pOff, POLYGON_SIDES);
      const px = cx + st.penX * scale;
      const py = cy + st.penY * scale;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  }, [renderFrame]);

  // ─── Initial setup ───────────────────────────────────────────────────────
  useEffect(() => {
    rebuildTables(fixedShape, movingShape, ecc);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Rebuild + redraw when shapes/ecc change (idle only) ─────────────────
  useEffect(() => {
    if (!simRef.current.tablesReady) return;
    rebuildTables(fixedShape, movingShape, ecc);
    if (!isPlaying) drawIdle(fixedShape, movingShape, ecc, penOffset, penColor);
  }, [fixedShape, movingShape, ecc]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Animation loop ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const sim = simRef.current;
    const delta = SPEED_DELTAS[speed];
    const capFixedShape  = fixedShape;
    const capMovingShape = movingShape;
    const capEcc = ecc;
    const capPenOffset = penOffset;
    const capColor = penColor;
    const capWeight = penWeight;
    const capRainbow = rainbow;

    const totalFixed  = totalArcLength(sim.fixedTable);
    const totalMoving = totalArcLength(sim.movingTable);
    const ratio = totalFixed / totalMoving;
    const numPetals = Math.max(10, Math.ceil(ratio) * 3);
    const maxPhi = TWO_PI * numPetals;

    let frameCount = 0;

    const loop = () => {
      const scale = getCanvasSize() / 380;

      const state = computeMeshState(
        sim.phi,
        capFixedShape, FIXED_BASE_R, capEcc, sim.fixedTable,
        capMovingShape, MOVING_BASE_R, capEcc, sim.movingTable,
        capPenOffset, POLYGON_SIDES
      );

      // ── Rainbow: advance hue, chunk runs ──────────────────────────────
      let frameColor = capColor;
      if (capRainbow) {
        hueRef.current = (hueRef.current + RAINBOW_HUE_STEP) % 360;
        frameColor = `hsl(${Math.round(hueRef.current)}, 85%, 62%)`;

        // Every RAINBOW_CHUNK_FRAMES, seal current run and start new one
        if (frameCount % RAINBOW_CHUNK_FRAMES === 0 && currentRunRef.current) {
          const prev = currentRunRef.current;
          if (prev.points.length > 0) {
            // New run starts from the last point for seamless join
            const lastPt = prev.points[prev.points.length - 1];
            const newRun: TraceRun = { points: [lastPt], color: frameColor, weight: capWeight };
            traceRunsRef.current.push(newRun);
            currentRunRef.current = newRun;
          }
        }
      }

      // Accumulate pen point
      if (currentRunRef.current) {
        currentRunRef.current.points.push({ x: state.penX, y: state.penY });
      }

      renderFrame(
        sim.phi, state.psi,
        state.movingCenterX, state.movingCenterY,
        state.penX, state.penY,
        scale, frameColor, capPenOffset
      );

      sim.phi += delta;
      frameCount++;

      if (sim.phi >= maxPhi) {
        setIsPlaying(false);
        return;
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isPlaying, speed, fixedShape, movingShape, ecc, penOffset, penColor, penWeight, rainbow, getCanvasSize, renderFrame]);

  // ─── Canvas resize ───────────────────────────────────────────────────────
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
      if (!isPlaying) drawIdle(fixedShape, movingShape, ecc, penOffset, penColor);
    });
    const parent = canvasRef.current?.parentElement;
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
  }, [isPlaying, fixedShape, movingShape, ecc, penOffset, penColor, drawIdle]);

  // ─── Handlers ────────────────────────────────────────────────────────────
  const startPlay = useCallback(() => {
    rebuildTables(fixedShape, movingShape, ecc);
    const sim = simRef.current;
    sim.phi = 0;
    hueRef.current = 0; // reset rainbow hue for each new draw

    const startColor = rainbow ? `hsl(0, 85%, 62%)` : penColor;
    const newRun: TraceRun = { points: [], color: startColor, weight: penWeight };
    currentRunRef.current = newRun;

    if (compositeMode) {
      traceRunsRef.current.push(newRun);
    } else {
      traceRunsRef.current = [newRun];
    }

    setHasTrace(true);
    setIsPlaying(true);
  }, [fixedShape, movingShape, ecc, penColor, penWeight, rainbow, compositeMode, rebuildTables]);

  const stopPlay = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const clearAll = useCallback(() => {
    stopPlay();
    traceRunsRef.current = [];
    currentRunRef.current = null;
    setHasTrace(false);
    setTimeout(() => drawIdle(fixedShape, movingShape, ecc, penOffset, penColor), 0);
  }, [stopPlay, fixedShape, movingShape, ecc, penOffset, penColor, drawIdle]);

  const handleFixedShapeChange = useCallback((s: GearShape) => {
    setFixedShape(s);
    if (!isPlaying) {
      const ft = buildArcLengthTable(s, FIXED_BASE_R, ecc, TABLE_N, POLYGON_SIDES);
      simRef.current.fixedTable = ft;
      simRef.current.fixedShape = s;
      simRef.current.tablesReady = true;
      drawGhost(s, movingShape, ecc, penOffset, penColor, penWeight);
    }
  }, [isPlaying, movingShape, ecc, penOffset, penColor, penWeight, drawGhost]);

  const handleMovingShapeChange = useCallback((s: GearShape) => {
    setMovingShape(s);
    if (!isPlaying) {
      const mt = buildArcLengthTable(s, MOVING_BASE_R, ecc, TABLE_N, POLYGON_SIDES);
      simRef.current.movingTable = mt;
      simRef.current.movingShape = s;
      simRef.current.tablesReady = true;
      drawGhost(fixedShape, s, ecc, penOffset, penColor, penWeight);
    }
  }, [isPlaying, fixedShape, ecc, penOffset, penColor, penWeight, drawGhost]);

  const handleParamInput = useCallback((fs: GearShape, ms: GearShape, e: number, pOff: number) => {
    if (isPlaying) return;
    const ft = buildArcLengthTable(fs, FIXED_BASE_R, e, TABLE_N, POLYGON_SIDES);
    const mt = buildArcLengthTable(ms, MOVING_BASE_R, e, TABLE_N, POLYGON_SIDES);
    simRef.current.fixedTable  = ft;
    simRef.current.movingTable = mt;
    simRef.current.fixedShape  = fs;
    simRef.current.movingShape = ms;
    simRef.current.ecc = e;
    simRef.current.tablesReady = true;
    drawGhost(fs, ms, e, pOff, penColor, penWeight);
  }, [isPlaying, penColor, penWeight, drawGhost]);

  const showEcc = fixedShape !== "circle" || movingShape !== "circle";

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

          {/* ── Outer ring shape ──────────────────────────────────────── */}
          <ShapeSelector
            label="Outer Ring"
            value={fixedShape}
            onChange={handleFixedShapeChange}
          />

          {/* ── Inner gear shape ─────────────────────────────────────── */}
          <ShapeSelector
            label="Inner Gear"
            value={movingShape}
            onChange={handleMovingShapeChange}
          />

          {/* Eccentricity — shown when either gear is non-circle */}
          {showEcc && (
            <section>
              <ControlSlider
                label="Shape Depth" value={ecc} min={0.05} max={0.85} step={0.01}
                onChange={(v) => setEcc(v)}
                onInput={(v) => {
                  setEcc(v);
                  handleParamInput(fixedShape, movingShape, v, penOffset);
                }}
                display={(v) => v.toFixed(2)}
              />
              <p className="text-[10px] text-muted-foreground/70 mt-1.5 leading-relaxed">
                {(fixedShape === "polygon" || movingShape === "polygon")
                  ? "Star point depth · Oval stretch"
                  : "Oval stretch — higher = more elongated"}
              </p>
            </section>
          )}

          <div className="border-t border-border/50" />

          {/* Pen controls */}
          <section>
            <ControlSlider
              label="Pen Offset" value={penOffset} min={0.01} max={1} step={0.01}
              onChange={(v) => setPenOffset(v)}
              onInput={(v) => {
                setPenOffset(v);
                handleParamInput(fixedShape, movingShape, ecc, v);
              }}
              display={(v) => `${Math.round(v * 100)}%`}
            />
            <p className="text-[10px] text-muted-foreground/70 mt-1 leading-relaxed">0% = gear center · 100% = edge</p>
          </section>

          <section>
            <ControlSlider
              label="Pen Weight" value={penWeight} min={0.5} max={10} step={0.5}
              onChange={(v) => setPenWeight(v)}
              display={(v) => `${v}px`}
            />
          </section>

          {/* Ink Color */}
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Ink Color</p>
              {/* Rainbow toggle */}
              <button
                onClick={() => setRainbow((v) => !v)}
                title={rainbow ? "Rainbow on" : "Rainbow off"}
                className={[
                  "flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-all duration-200",
                  rainbow
                    ? "border-transparent text-white"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/25",
                ].join(" ")}
                style={rainbow ? {
                  background: "linear-gradient(90deg,#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f472b6)",
                } : undefined}
              >
                ✦ Rainbow
              </button>
            </div>

            {/* Color picker + hex — dimmed when rainbow is on */}
            <div className={["flex items-center gap-3 transition-opacity", rainbow ? "opacity-40 pointer-events-none" : ""].join(" ")}>
              <label className="relative w-8 h-8 cursor-pointer">
                <input type="color" value={penColor} onChange={(e) => setPenColor(e.target.value)}
                  className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
                <span className="absolute inset-0 rounded-full border-2 border-white/20" style={{ background: penColor }} />
              </label>
              <span className="text-xs font-mono text-foreground/50">{penColor.toUpperCase()}</span>
            </div>
            <div className={["flex flex-wrap gap-2 transition-opacity", rainbow ? "opacity-40 pointer-events-none" : ""].join(" ")}>
              {["#a78bfa", "#34d399", "#f87171", "#fbbf24", "#60a5fa", "#f472b6", "#fb923c", "#e2e8f0"].map((c) => (
                <button
                  key={c} onClick={() => setPenColor(c)} title={c}
                  className="w-5 h-5 rounded-full border transition-all hover:scale-110"
                  style={{
                    background: c,
                    borderColor: penColor === c ? c : "rgba(255,255,255,0.1)",
                    boxShadow: penColor === c ? `0 0 0 2px rgba(0,0,0,0.5), 0 0 0 4px ${c}` : undefined,
                  }}
                />
              ))}
            </div>
          </section>

          {/* Composite Mode */}
          <section>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Composite Mode</p>
                <p className="text-[10px] text-muted-foreground/70 mt-0.5 leading-relaxed">Layer multiple traces.</p>
              </div>
              <button
                onClick={() => setCompositeMode((v) => !v)}
                className={["relative inline-flex h-5 w-9 shrink-0 mt-0.5 items-center rounded-full transition-colors duration-200",
                  compositeMode ? "bg-primary" : "bg-secondary"].join(" ")}
              >
                <span className={["inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-200",
                  compositeMode ? "translate-x-4" : "translate-x-0.5"].join(" ")} />
              </button>
            </div>
          </section>

          <section>
            <button
              onClick={clearAll}
              disabled={!hasTrace}
              className="w-full px-3 py-2 rounded-md text-xs font-medium border border-border text-muted-foreground hover:text-foreground hover:border-foreground/25 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Clear Canvas
            </button>
          </section>
        </div>

        <div className="px-4 py-3 border-t border-border">
          <p className="text-[10px] text-muted-foreground/40 leading-relaxed">Arc-length integration · No-slip meshing</p>
        </div>
      </aside>

      {/* ── Stage ── */}
      <main className="flex-1 flex flex-col items-center justify-center relative overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `
              radial-gradient(circle at 50% 50%, rgba(124,101,245,0.04) 0%, transparent 70%),
              linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.018) 1px, transparent 1px)
            `,
            backgroundSize: "100% 100%, 40px 40px, 40px 40px",
          }}
        />

        <div
          className="relative"
          style={{ width: "min(calc(100vw - 256px - 32px), calc(100vh - 120px))", aspectRatio: "1 / 1" }}
        >
          <canvas ref={canvasRef} width={600} height={600} className="absolute inset-0 w-full h-full" />
        </div>

        {/* Playback controller */}
        <div className="absolute bottom-7 left-1/2 -translate-x-1/2 z-10">
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-2xl border border-border bg-card/85 backdrop-blur-md shadow-2xl">
            <button
              onClick={isPlaying ? stopPlay : startPlay}
              className="w-10 h-10 rounded-xl flex items-center justify-center bg-primary text-primary-foreground shadow-lg hover:brightness-110 active:scale-95 transition-all duration-100"
            >
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
                <button
                  key={mode}
                  onClick={() => setSpeed(mode)}
                  className={["px-3 h-8 rounded-lg text-xs font-semibold transition-all duration-100",
                    speed === mode
                      ? "bg-primary/14 text-primary border border-primary/25"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary/50 border border-transparent"].join(" ")}
                >
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
            <p className="text-[11px] text-muted-foreground/45 tracking-wide">Configure the lab · press ▶ to draw</p>
          </div>
        )}
      </main>
    </div>
  );
}
