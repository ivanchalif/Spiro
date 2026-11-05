import { PointRing } from "./simulation";

const COLORS = ["#f87171", "#60a5fa", "#34d399"];
export function renderNBody(
  canvas: HTMLCanvasElement, bodies: { x: number; y: number; m: number }[], trails: PointRing[], presetScale: number,
) {
  canvas.dataset.engine = "threebody";
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Number(canvas.dataset.dpr) || 1;
  const size = canvas.width / dpr, scale = presetScale * size / 600;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.save(); ctx.translate(size / 2, size / 2);
  for (let i = 0; i < bodies.length; i++) {
    const trail = trails[i], color = COLORS[i % COLORS.length], body = bodies[i];
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = color;
    const segments = Math.max(0, trail.length - 1), bands = Math.min(16, segments);
    for (let band = 0; band < bands; band++) {
      const start = Math.floor(band * segments / bands), end = Math.floor((band + 1) * segments / bands);
      const alpha = (band + 1) / bands;
      ctx.globalAlpha = alpha * 0.85; ctx.lineWidth = 1.5 + alpha;
      ctx.beginPath();
      const first = trail.at(start);
      ctx.moveTo(first.x * scale, -first.y * scale);
      for (let t = start + 1; t <= end; t++) {
        const point = trail.at(t);
        ctx.lineTo(point.x * scale, -point.y * scale);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(body.x * scale, -body.y * scale, Math.max(3, Math.min(8, body.m * 4)), 0, 2 * Math.PI); ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 0.07; ctx.strokeStyle = "#fff"; ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    ctx.moveTo(bodies[i].x * scale, -bodies[i].y * scale);
    ctx.lineTo(bodies[j].x * scale, -bodies[j].y * scale);
  }
  ctx.stroke(); ctx.restore();
}
