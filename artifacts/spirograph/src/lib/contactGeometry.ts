export interface Vertex { x: number; y: number }
export const TOOTH_HEIGHT = 2 * Math.PI * 155 / 124 * 0.38;
export const RACK_HALF_WIDTH = TOOTH_HEIGHT * 0.75;

/** The identical polygon is used for drawing and contact, including tooth tips. */
export function outline(
  radiusAt: (angle: number) => number, teeth: number, height = TOOTH_HEIGHT,
  sign = 1,
): Vertex[] {
  const count = Math.max(360, teeth * 12);
  return Array.from({ length: count }, (_, i) => {
    const a = i / count * Math.PI * 2;
    const r = radiusAt(a) + height * 0.5 * (1 + sign * Math.cos(a * teeth));
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  });
}

export function transformOutline(points: Vertex[], angle: number, scale = 1): Vertex[] {
  const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
  return points.map(p => ({ x: c * p.x - s * p.y, y: s * p.x + c * p.y }));
}

interface Projected extends Vertex { world: Vertex }
function edgeBins(points: Projected[], low: number, span: number) {
  const bins: number[][] = Array.from({ length: 128 }, () => []);
  const index = (y: number) => Math.max(0, Math.min(127, Math.floor((y - low) / span * 128)));
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length];
    for (let k = index(Math.min(a.y, b.y)); k <= index(Math.max(a.y, b.y)); k++) bins[k].push(i);
  });
  return { bins, index };
}

/**
 * Exact first/last contact of polygon boundaries translated along a ray.
 * All possible contacts are moving-vertex/fixed-edge or fixed-vertex/moving-edge
 * events. Interior starts in a contained pose; exterior starts beyond all events.
 * Binning edges perpendicular to travel avoids an all-pairs intersection scan.
 */
export function boundaryContact(
  fixed: Vertex[], moving: Vertex[], origin: Vertex, direction: Vertex, internal: boolean,
): { centerX: number; centerY: number; contactX: number; contactY: number } {
  const project = (points: Vertex[], stationary: boolean): Projected[] => points.map(p => {
    const x = p.x - (stationary ? origin.x : 0), y = p.y - (stationary ? origin.y : 0);
    return { x: x * direction.x + y * direction.y, y: -x * direction.y + y * direction.x, world: p };
  });
  const f = project(fixed, true), m = project(moving, false);
  let low = Infinity, high = -Infinity;
  for (const p of [...f, ...m]) { low = Math.min(low, p.y); high = Math.max(high, p.y); }
  const span = Math.max(1e-9, high - low);
  const fb = edgeBins(f, low, span), mb = edgeBins(m, low, span);
  let travel = internal ? Infinity : -Infinity;
  let contactX = origin.x, contactY = origin.y;
  const record = (t: number, x: number, y: number) => {
    if (t < -1e-8 || (internal ? t >= travel : t <= travel)) return;
    travel = Math.max(0, t);
    contactX = x; contactY = y;
  };
  const scan = (vertices: Projected[], edges: Projected[], bins: ReturnType<typeof edgeBins>, movingVertex: boolean) => {
    for (const p of vertices) {
      for (const i of bins.bins[bins.index(p.y)]) {
        const a = edges[i], b = edges[(i + 1) % edges.length];
        const dy = b.y - a.y;
        if (Math.abs(dy) < 1e-12) continue;
        const u = (p.y - a.y) / dy;
        if (u < -1e-10 || u > 1 + 1e-10) continue;
        const x = a.x + u * (b.x - a.x);
        if (movingVertex) {
          record(x - p.x, a.world.x + u * (b.world.x - a.world.x), a.world.y + u * (b.world.y - a.world.y));
        } else {
          record(p.x - x, p.world.x, p.world.y);
        }
      }
    }
  };
  scan(m, f, fb, true); scan(f, m, mb, false);
  if (!Number.isFinite(travel)) throw new Error("No valid gear-boundary contact.");
  return {
    centerX: origin.x + travel * direction.x,
    centerY: origin.y + travel * direction.y, contactX, contactY,
  };
}

export function fittingScale(fixed: Vertex[], moving: Vertex[]): number {
  // A rotation-independent bound prevents a large gear fitting at one angle,
  // then crossing a narrow part of the governing shape as it rotates.
  const inner = Math.min(...fixed.map((p, i) => {
    const q = fixed[(i + 1) % fixed.length];
    const dx = q.x - p.x, dy = q.y - p.y;
    const t = Math.max(0, Math.min(1, -(p.x * dx + p.y * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p.x + t * dx, p.y + t * dy);
  }));
  const outer = Math.max(...moving.map(p => Math.hypot(p.x, p.y)));
  return Math.min(1, inner / outer * (1 - 1e-6));
}
