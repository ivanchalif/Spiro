import { useRef, useEffect, useState, useCallback } from "react";

const TWO_PI   = 2 * Math.PI;
const N_BINS   = 256;
const CANVAS_S = 380;
const REF_R    = CANVAS_S * 0.40;
const CX       = CANVAS_S / 2;
const CY       = CANVAS_S / 2;

function processPoints(pts: { x: number; y: number }[]): Float64Array {
  const bins: number[][] = Array.from({ length: N_BINS }, () => []);
  for (const p of pts) {
    const dx = p.x - CX, dy = p.y - CY;
    if (dx === 0 && dy === 0) continue;
    const r     = Math.sqrt(dx * dx + dy * dy) / REF_R;
    const theta = ((Math.atan2(dy, dx) % TWO_PI) + TWO_PI) % TWO_PI;
    const bi    = Math.min(N_BINS - 1, Math.floor((theta / TWO_PI) * N_BINS));
    bins[bi].push(r);
  }

  const raw = new Float64Array(N_BINS).fill(-1);
  for (let i = 0; i < N_BINS; i++) {
    if (bins[i].length > 0)
      raw[i] = bins[i].reduce((a, b) => a + b, 0) / bins[i].length;
  }

  const filled = new Float64Array(N_BINS);
  for (let i = 0; i < N_BINS; i++) {
    if (raw[i] >= 0) { filled[i] = raw[i]; continue; }
    let prev = -1, next = -1;
    for (let d = 1; d < N_BINS; d++) {
      if (prev < 0 && raw[(i - d + N_BINS) % N_BINS] >= 0) prev = (i - d + N_BINS) % N_BINS;
      if (next < 0 && raw[(i + d) % N_BINS] >= 0)          next = (i + d) % N_BINS;
      if (prev >= 0 && next >= 0) break;
    }
    if (prev < 0 && next < 0) { filled[i] = 1.0; }
    else if (prev < 0)        { filled[i] = raw[next]; }
    else if (next < 0)        { filled[i] = raw[prev]; }
    else {
      const dp = ((i - prev) + N_BINS) % N_BINS;
      const dn = ((next - i) + N_BINS) % N_BINS;
      filled[i] = raw[prev] * (1 - dp / (dp + dn)) + raw[next] * (dp / (dp + dn));
    }
  }

  const SIGMA = 6, KS = Math.ceil(3 * SIGMA);
  const smooth = new Float64Array(N_BINS);
  for (let i = 0; i < N_BINS; i++) {
    let sum = 0, wt = 0;
    for (let d = -KS; d <= KS; d++) {
      const j = (i + d + N_BINS) % N_BINS;
      const w = Math.exp(-(d * d) / (2 * SIGMA * SIGMA));
      sum += filled[j] * w; wt += w;
    }
    smooth[i] = Math.max(0.12, Math.min(1.35, sum / wt));
  }
  return smooth;
}

interface Props {
  target: "fixed" | "moving";
  onDone:   (table: Float64Array) => void;
  onCancel: () => void;
}

export function DrawShapeModal({ target, onDone, onCancel }: Props) {
  const canvasRef       = useRef<HTMLCanvasElement>(null);
  const strokesRef      = useRef<{ x: number; y: number }[][]>([]);
  const currentRef      = useRef<{ x: number; y: number }[]>([]);
  const [drawing, setDrawing]   = useState(false);
  const [hasPoints, setHasPoints] = useState(false);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, CANVAS_S, CANVAS_S);
    ctx.fillStyle = "hsl(220,13%,7%)";
    ctx.fillRect(0, 0, CANVAS_S, CANVAS_S);

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.arc(CX, CY, REF_R, 0, TWO_PI); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(CX - 6, CY); ctx.lineTo(CX + 6, CY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(CX, CY - 6); ctx.lineTo(CX, CY + 6); ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(100, 180, 255, 0.85)";
    ctx.lineWidth   = 2.2;
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    for (const stroke of strokesRef.current) {
      if (stroke.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y);
      ctx.stroke();
    }
    if (currentRef.current.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(currentRef.current[0].x, currentRef.current[0].y);
      for (let i = 1; i < currentRef.current.length; i++)
        ctx.lineTo(currentRef.current[i].x, currentRef.current[i].y);
      ctx.stroke();
    }
    ctx.restore();

    if (hasPoints) {
      const allPts = strokesRef.current.flat();
      const table  = processPoints(allPts);
      ctx.save();
      ctx.strokeStyle = "rgba(120,255,180,0.30)";
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      for (let i = 0; i <= N_BINS; i++) {
        const bi    = i % N_BINS;
        const theta = (bi / N_BINS) * TWO_PI;
        const r     = table[bi] * REF_R;
        const x     = CX + r * Math.cos(theta);
        const y     = CY + r * Math.sin(theta);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }, [hasPoints]);

  useEffect(() => { redraw(); }, [redraw]);

  const getPos = (e: React.MouseEvent | React.TouchEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = CANVAS_S / rect.width;
    const scaleY = CANVAS_S / rect.height;
    if ("touches" in e) {
      if (e.touches.length === 0) return null;
      return { x: (e.touches[0].clientX - rect.left) * scaleX, y: (e.touches[0].clientY - rect.top) * scaleY };
    }
    return { x: ((e as React.MouseEvent).clientX - rect.left) * scaleX, y: ((e as React.MouseEvent).clientY - rect.top) * scaleY };
  };

  const onDown = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    const pos = getPos(e);
    if (!pos) return;
    setDrawing(true);
    currentRef.current = [pos];
    redraw();
  };

  const onMove = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (!drawing) return;
    const pos = getPos(e);
    if (!pos) return;
    currentRef.current.push(pos);
    redraw();
  };

  const onUp = () => {
    if (!drawing) return;
    setDrawing(false);
    if (currentRef.current.length > 3) {
      strokesRef.current.push([...currentRef.current]);
      setHasPoints(true);
    }
    currentRef.current = [];
    redraw();
  };

  const handleClear = () => {
    strokesRef.current = [];
    currentRef.current = [];
    setHasPoints(false);
    redraw();
  };

  const handleApply = () => {
    const allPts = strokesRef.current.flat();
    if (allPts.length < 6) return;
    onDone(processPoints(allPts));
  };

  const isFixed = target === "fixed";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm"
      onMouseUp={onUp}
    >
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl flex flex-col gap-4 p-5"
        style={{ maxWidth: "min(440px, 96vw)" }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold leading-tight">
              Draw a custom {isFixed ? "outer ring" : "inner gear"} shape
            </h2>
            <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
              Draw freely inside the dashed circle. The green preview shows the polar profile the app will use.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
          >
            ✕
          </button>
        </div>

        <canvas
          ref={canvasRef}
          width={CANVAS_S}
          height={CANVAS_S}
          className="w-full rounded-xl cursor-crosshair touch-none select-none"
          style={{ aspectRatio: "1 / 1" }}
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={onUp}
          onTouchStart={onDown}
          onTouchMove={onMove}
          onTouchEnd={onUp}
        />

        <div className="flex gap-2">
          <button
            onClick={handleClear}
            className="flex-1 py-2 rounded-lg text-[11px] font-medium border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-all"
          >
            Clear
          </button>
          <button
            onClick={handleApply}
            disabled={!hasPoints}
            className={[
              "flex-1 py-2 rounded-lg text-[11px] font-semibold border transition-all",
              hasPoints
                ? "border-primary/40 text-primary hover:bg-primary/10 active:scale-95"
                : "opacity-30 cursor-not-allowed border-border text-muted-foreground",
            ].join(" ")}
          >
            Apply Shape
          </button>
        </div>
      </div>
    </div>
  );
}
