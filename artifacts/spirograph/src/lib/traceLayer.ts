export interface TraceRun {
  points: { x: number; y: number }[];
  color: string;
  weight: number;
  action?: number;
}
export interface TraceView { size: number; scale: number; offX: number; offY: number; dpr: number }

/** Rasterizes only newly appended segments; retained vectors support recent undo and resizing. */
export class TraceLayer {
  private canvas?: HTMLCanvasElement;
  private view?: TraceView;
  private counts = new Map<TraceRun, number>();
  private archive?: HTMLCanvasElement;
  private archiveView?: TraceView;

  invalidate() { this.counts.clear(); this.view = undefined; }
  clear() { this.archive = undefined; this.archiveView = undefined; this.invalidate(); }

  private paint(ctx: CanvasRenderingContext2D, run: TraceRun, from: number, v: TraceView) {
    if (run.points.length < 2) return;
    ctx.strokeStyle = run.color;
    ctx.lineWidth = run.weight;
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (let i = Math.max(0, from - 1); i < run.points.length; i++) {
      const p = run.points[i];
      const x = v.size / 2 + (p.x - v.offX) * v.scale;
      const y = v.size / 2 + (p.y - v.offY) * v.scale;
      if (i === Math.max(0, from - 1)) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /** Keep older artwork as a fixed-size image rather than silently deleting it. */
  archiveRuns(runs: TraceRun[], view: TraceView) {
    if (!runs.length) return;
    if (!this.archive) {
      this.archive = document.createElement("canvas");
      this.archive.width = this.archive.height = Math.round(view.size * view.dpr);
      this.archiveView = { ...view };
    }
    const v = this.archiveView!;
    const ctx = this.archive.getContext("2d")!;
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    for (const run of runs) this.paint(ctx, run, 0, v);
    this.invalidate();
  }

  draw(target: CanvasRenderingContext2D, runs: TraceRun[], view: TraceView) {
    this.canvas ??= document.createElement("canvas");
    const changed = !this.view || Object.keys(view).some(k =>
      view[k as keyof TraceView] !== this.view![k as keyof TraceView]);
    const removed = [...this.counts.keys()].some(run => !runs.includes(run));
    if (changed || removed) {
      this.canvas.width = this.canvas.height = Math.round(view.size * view.dpr);
      this.counts.clear(); this.view = { ...view };
      const ctx = this.canvas.getContext("2d")!;
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      if (this.archive && this.archiveView) {
        const a = this.archiveView;
        const ratio = view.scale / a.scale;
        const width = a.size * ratio;
        const x = view.size / 2 + (a.offX - view.offX) * view.scale - width / 2;
        const y = view.size / 2 + (a.offY - view.offY) * view.scale - width / 2;
        ctx.drawImage(this.archive, x, y, width, width);
      }
    }
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    for (const run of runs) {
      const count = this.counts.get(run) ?? 0;
      if (run.points.length > count) this.paint(ctx, run, count, view);
      this.counts.set(run, run.points.length);
    }
    target.drawImage(this.canvas, 0, 0, view.size, view.size);
  }

  exportArchive(): { image: string; view: TraceView } | undefined {
    return this.archive && this.archiveView
      ? { image: this.archive.toDataURL("image/png"), view: this.archiveView } : undefined;
  }

  async restoreArchive(saved?: { image: string; view: TraceView }) {
    if (!saved) { this.clear(); return; }
    const image = new Image();
    image.src = saved.image;
    await image.decode();
    if (image.width > 8000 || image.height > 8000) throw new Error("Saved image is too large");
    this.clear();
    this.archive = document.createElement("canvas");
    this.archive.width = image.width; this.archive.height = image.height;
    this.archive.getContext("2d")!.drawImage(image, 0, 0);
    this.archiveView = saved.view;
  }
}
