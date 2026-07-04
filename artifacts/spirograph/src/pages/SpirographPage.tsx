import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildArcLengthTable,
  computeMeshState,
  drawPolarCurve,
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

function buildMetalGradient(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, hue: number
): CanvasGradient {
  const grad = ctx.createRadialGradient(cx - r * 0.28, cy - r * 0.28, r * 0.06, cx, cy, r * 1.05);
  grad.addColorStop(0, `hsl(${hue}, 14%, 46%)`);
  grad.addColorStop(0.25, `hsl(${hue}, 10%, 34%)`);
  grad.addColorStop(0.55, `hsl(${hue}, 10%, 24%)`);
  grad.addColorStop(0.8, `hsl(${hue}, 12%, 17%)`);
  grad.addColorStop(1, `hsl(${hue}, 14%, 11%)`);
  return grad;
}

function buildMetalStroke(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, hue: number
): CanvasGradient {
  const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  grad.addColorStop(0, `hsl(${hue}, 22%, 58%)`);
  grad.addColorStop(0.5, `hsl(${hue}, 12%, 28%)`);
  grad.addColorStop(1, `hsl(${hue}, 22%, 52%)`);
  return grad;
}

function ControlSlider({
  label, value, min, max, step, onChange, onInput, display,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; onInput?: (v: number) => void;
  display?: (v: number) => string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
        <span className="text-xs font-mono text-foreground/60 tabular-nums">{display ? display(value) : value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onInput={(e) => onInput?.(Number((e.target as HTMLInputElement).value))}
      />
    </div>
  );
}

export default function SpirographPage() {
  const [shape, setShape] = useState<GearShape>("circle");
  const [ecc, setEcc] = useState(0.3);
  const [penOffset, setPenOffset] = useState(0.65);
  const [penWeight, setPenWeight] = useState(2);
  const [penColor, setPenColor] = useState("#a78bfa");
  const [compositeMode, setCompositeMode] = useState(false);
  const [speed, setSpeed] = useState<SpeedMode>("full");
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasTrace, setHasTrace] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const simRef = useRef({
    phi: 0,
    fixedTable: new Float64Array(TABLE_N + 1) as Float64Array<ArrayBuffer>,
    movingTable: new Float64Array(TABLE_N + 1) as Float64Array<ArrayBuffer>,
    shape: "circle" as GearShape,
    ecc: 0.3,
    tablesReady: false,
  });

  // Accumulated trace data
  const traceRunsRef = useRef<TraceRun[]>([]);
  const currentRunRef = useRef<TraceRun | null>(null);

  const rafRef = useRef<number | null>(null);

  const rebuildTables = useCallback((s: GearShape, e: number) => {
    simRef.current.fixedTable = buildArcLengthTable(s, FIXED_BASE_R, e, TABLE_N, POLYGON_SIDES);
    simRef.current.movingTable = buildArcLengthTable(s, MOVING_BASE_R, e, TABLE_N, POLYGON_SIDES);
    simRef.current.shape = s;
    simRef.current.ecc = e;
    simRef.current.tablesReady = true;
  }, []);

  const getCanvasSize = useCallback(() => {
    const c = canvasRef.current;
    return c ? Math.min(c.width, c.height) : 600;
  }, []);

  // ─── Core renderer: all trace runs + gears on the single canvas ──────────
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

    // ── Draw gears ────────────────────────────────────────────────────────
    const fixedR = FIXED_BASE_R * scale;
    const movingR = MOVING_BASE_R * scale;

    ctx.save();
    ctx.translate(cx, cy);

    // Fixed gear fill
    ctx.shadowColor = "rgba(120,100,255,0.22)";
    ctx.shadowBlur = 20;
    drawPolarCurve(ctx, sim.shape, fixedR, sim.ecc, 0, 0, 0, POLYGON_SIDES);
    ctx.fillStyle = buildMetalGradient(ctx, 0, 0, fixedR, 228);
    ctx.fill();
    ctx.strokeStyle = buildMetalStroke(ctx, 0, 0, fixedR, 228);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Dashed guide ring
    ctx.save();
    ctx.setLineDash([4, 8]);
    ctx.strokeStyle = "rgba(120,100,255,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, fixedR * 0.97, 0, TWO_PI);
    ctx.stroke();
    ctx.restore();

    // Cross-hair at center
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-fixedR * 0.06, 0); ctx.lineTo(fixedR * 0.06, 0);
    ctx.moveTo(0, -fixedR * 0.06); ctx.lineTo(0, fixedR * 0.06);
    ctx.stroke();

    // Moving gear
    const mcxS = mcx * scale;
    const mcyS = mcy * scale;
    const rotAngle = phi - psi;
    ctx.shadowColor = "rgba(80,220,190,0.18)";
    ctx.shadowBlur = 14;
    drawPolarCurve(ctx, sim.shape, movingR, sim.ecc, mcxS, mcyS, rotAngle, POLYGON_SIDES);
    ctx.fillStyle = buildMetalGradient(ctx, mcxS, mcyS, movingR, 198);
    ctx.fill();
    ctx.strokeStyle = buildMetalStroke(ctx, mcxS, mcyS, movingR, 198);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Contact point dot (gold)
    const contactR = gearRadius(sim.shape, fixedR, sim.ecc, phi, POLYGON_SIDES);
    ctx.shadowColor = "rgba(255,210,80,0.6)";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(contactR * Math.cos(phi), contactR * Math.sin(phi), 3.5, 0, TWO_PI);
    ctx.fillStyle = "rgba(255,218,80,0.95)";
    ctx.fill();
    ctx.shadowBlur = 0;

    // Moving gear center dot
    ctx.beginPath();
    ctx.arc(mcxS, mcyS, 2.5, 0, TWO_PI);
    ctx.fillStyle = "rgba(100,230,210,0.75)";
    ctx.fill();

    // Pen dot + arm
    const penAngle = phi - psi;
    const penRpx = curPenOffset * movingR;
    const penDotX = mcxS + penRpx * Math.cos(penAngle);
    const penDotY = mcyS + penRpx * Math.sin(penAngle);

    ctx.beginPath();
    ctx.moveTo(mcxS, mcyS);
    ctx.lineTo(penDotX, penDotY);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.shadowColor = curPenColor + "aa";
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(penDotX, penDotY, 3.5, 0, TWO_PI);
    ctx.fillStyle = curPenColor;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.restore();
  }, []);

  // ─── Draw idle state (no animation) ─────────────────────────────────────
  const drawIdle = useCallback((s: GearShape, e: number, pOff: number, color: string) => {
    const sim = simRef.current;
    if (!sim.tablesReady) return;
    const scale = getCanvasSize() / 380;
    const state = computeMeshState(
      0, s, FIXED_BASE_R, e, sim.fixedTable,
      s, MOVING_BASE_R, e, sim.movingTable,
      pOff, POLYGON_SIDES
    );
    renderFrame(0, state.psi, state.movingCenterX, state.movingCenterY, state.penX, state.penY, scale, color, pOff);
  }, [getCanvasSize, renderFrame]);

  // ─── Ghost trace preview ─────────────────────────────────────────────────
  const drawGhost = useCallback((s: GearShape, e: number, pOff: number, color: string, weight: number) => {
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

    // Draw idle gears first
    const state0 = computeMeshState(0, s, FIXED_BASE_R, e, ft, s, MOVING_BASE_R, e, mt, pOff, POLYGON_SIDES);
    renderFrame(0, state0.psi, state0.movingCenterX, state0.movingCenterY, state0.penX, state0.penY, scale, color, pOff);

    // Overlay ghost trace
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = color;
    ctx.lineWidth = weight * 0.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i <= numSteps; i++) {
      const phi = (i / numSteps) * totalPhi;
      const st = computeMeshState(phi, s, FIXED_BASE_R, e, ft, s, MOVING_BASE_R, e, mt, pOff, POLYGON_SIDES);
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
    rebuildTables(shape, ecc);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Rebuild + redraw when shape/ecc changes (idle only) ─────────────────
  useEffect(() => {
    if (!simRef.current.tablesReady) return;
    rebuildTables(shape, ecc);
    if (!isPlaying) drawIdle(shape, ecc, penOffset, penColor);
  }, [shape, ecc]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const capShape = shape;
    const capEcc = ecc;
    const capPenOffset = penOffset;
    const capColor = penColor;
    const capWeight = penWeight;

    const totalFixed = totalArcLength(sim.fixedTable);
    const totalMoving = totalArcLength(sim.movingTable);
    const ratio = totalFixed / totalMoving;
    const numPetals = Math.max(10, Math.ceil(ratio) * 3);
    const maxPhi = TWO_PI * numPetals;

    const loop = () => {
      const scale = getCanvasSize() / 380;

      const state = computeMeshState(
        sim.phi,
        capShape, FIXED_BASE_R, capEcc, sim.fixedTable,
        capShape, MOVING_BASE_R, capEcc, sim.movingTable,
        capPenOffset, POLYGON_SIDES
      );

      // Accumulate pen point into current run
      if (currentRunRef.current) {
        currentRunRef.current.points.push({ x: state.penX, y: state.penY });
      }

      renderFrame(
        sim.phi, state.psi,
        state.movingCenterX, state.movingCenterY,
        state.penX, state.penY,
        scale, capColor, capPenOffset
      );

      sim.phi += delta;

      if (sim.phi >= maxPhi) {
        // Pattern complete — stop
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
  }, [isPlaying, speed, shape, ecc, penOffset, penColor, penWeight, compositeMode, getCanvasSize, renderFrame]);

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
      if (!isPlaying) drawIdle(shape, ecc, penOffset, penColor);
    });
    const parent = canvasRef.current?.parentElement;
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
  }, [isPlaying, shape, ecc, penOffset, penColor, drawIdle]);

  // ─── Handlers ────────────────────────────────────────────────────────────
  const startPlay = useCallback(() => {
    rebuildTables(shape, ecc);
    const sim = simRef.current;
    sim.phi = 0;

    const newRun: TraceRun = { points: [], color: penColor, weight: penWeight };
    currentRunRef.current = newRun;

    if (compositeMode) {
      // Composite: keep existing runs, add new run on top
      traceRunsRef.current.push(newRun);
    } else {
      // Fresh start: discard all previous traces
      traceRunsRef.current = [newRun];
    }

    setHasTrace(true);
    setIsPlaying(true);
  }, [shape, ecc, penColor, penWeight, compositeMode, rebuildTables]);

  const stopPlay = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const clearAll = useCallback(() => {
    stopPlay();
    traceRunsRef.current = [];
    currentRunRef.current = null;
    setHasTrace(false);
    // Need to redraw idle without trace — schedule after state update
    setTimeout(() => drawIdle(shape, ecc, penOffset, penColor), 0);
  }, [stopPlay, shape, ecc, penOffset, penColor, drawIdle]);

  const handleShapeChange = useCallback((s: GearShape) => {
    setShape(s);
    if (!isPlaying) {
      const ft = buildArcLengthTable(s, FIXED_BASE_R, ecc, TABLE_N, POLYGON_SIDES);
      const mt = buildArcLengthTable(s, MOVING_BASE_R, ecc, TABLE_N, POLYGON_SIDES);
      simRef.current.fixedTable = ft;
      simRef.current.movingTable = mt;
      simRef.current.shape = s;
      simRef.current.tablesReady = true;
      drawGhost(s, ecc, penOffset, penColor, penWeight);
    }
  }, [isPlaying, ecc, penOffset, penColor, penWeight, drawGhost]);

  const handleParamInput = useCallback((s: GearShape, e: number, pOff: number) => {
    if (isPlaying) return;
    const ft = buildArcLengthTable(s, FIXED_BASE_R, e, TABLE_N, POLYGON_SIDES);
    const mt = buildArcLengthTable(s, MOVING_BASE_R, e, TABLE_N, POLYGON_SIDES);
    simRef.current.fixedTable = ft;
    simRef.current.movingTable = mt;
    simRef.current.shape = s;
    simRef.current.ecc = e;
    simRef.current.tablesReady = true;
    drawGhost(s, e, pOff, penColor, penWeight);
  }, [isPlaying, penColor, penWeight, drawGhost]);

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

        <div className="flex flex-col gap-5 px-4 py-5 flex-1">
          {/* Gear Shape */}
          <section className="flex flex-col gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Gear Shape</p>
            <div className="flex flex-col gap-1">
              {(["circle", "ellipse", "polygon"] as GearShape[]).map((s) => (
                <button
                  key={s}
                  onClick={() => handleShapeChange(s)}
                  className={[
                    "px-3 py-2 rounded-md text-sm font-medium text-left transition-all duration-150",
                    shape === s
                      ? "bg-primary/14 text-primary border border-primary/25"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary/60 border border-transparent",
                  ].join(" ")}
                >
                  {s === "circle" ? "Circle" : s === "ellipse" ? "Ellipse" : "Polygon / Star"}
                </button>
              ))}
            </div>
          </section>

          {shape !== "circle" && (
            <section>
              <ControlSlider
                label="Eccentricity" value={ecc} min={0.05} max={0.85} step={0.01}
                onChange={(v) => setEcc(v)}
                onInput={(v) => { setEcc(v); handleParamInput(shape, v, penOffset); }}
                display={(v) => v.toFixed(2)}
              />
              <p className="text-[10px] text-muted-foreground/70 mt-1.5 leading-relaxed">
                {shape === "ellipse" ? "Oval stretch — higher = more elongated." : "Star depth — higher = sharper points."}
              </p>
            </section>
          )}

          <section>
            <ControlSlider
              label="Pen Offset" value={penOffset} min={0.01} max={1} step={0.01}
              onChange={(v) => setPenOffset(v)}
              onInput={(v) => { setPenOffset(v); handleParamInput(shape, ecc, v); }}
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
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Ink Color</p>
            <div className="flex items-center gap-3">
              <label className="relative w-8 h-8 cursor-pointer">
                <input type="color" value={penColor} onChange={(e) => setPenColor(e.target.value)}
                  className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
                <span className="absolute inset-0 rounded-full border-2 border-white/20" style={{ background: penColor }} />
              </label>
              <span className="text-xs font-mono text-foreground/50">{penColor.toUpperCase()}</span>
            </div>
            <div className="flex flex-wrap gap-2 mt-0.5">
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
