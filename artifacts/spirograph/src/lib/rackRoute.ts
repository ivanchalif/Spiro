/** One closed route: front face, far-end semicircle, back face, near-end semicircle. */
import { RACK_HALF_WIDTH, TOOTH_HEIGHT, type Vertex } from "./contactGeometry";

export const RACK_SPAN = 4 * Math.PI;
export const RACK_PERIOD = 2 * (RACK_SPAN + Math.PI);

export interface RackContact {
  x: number;
  y: number;
  alpha: number;
}

export interface RackRouteState {
  centerX: number;
  centerY: number;
  contactX: number;
  contactY: number;
  heading: number;
  phase: number;
  side: "front" | "far-end" | "back" | "near-end";
}

export function rackContact(
  s: number, radius: number, path?: Float64Array | null, profile?: Float64Array | null,
): RackContact {
  const length = radius * RACK_SPAN;
  const fraction = Math.max(0, Math.min(1, s / length));
  if (path && path.length >= 6) {
    const n = path.length / 3 - 1;
    const index = fraction * n;
    const lo = Math.min(Math.floor(index), n - 1);
    const t = index - lo;
    return {
      x: path[lo * 3] * (1 - t) + path[(lo + 1) * 3] * t,
      y: path[lo * 3 + 1] * (1 - t) + path[(lo + 1) * 3 + 1] * t,
      alpha: path[lo * 3 + 2] * (1 - t) + path[(lo + 1) * 3 + 2] * t,
    };
  }
  if (profile && profile.length > 1) {
    const n = profile.length - 1;
    const index = fraction * n;
    const lo = Math.min(Math.floor(index), n - 1);
    const t = index - lo;
    return {
      x: s,
      y: (profile[lo] * (1 - t) + profile[lo + 1] * t) * radius * 0.5,
      alpha: Math.atan2((profile[lo + 1] - profile[lo]) * radius * 0.5, length / n),
    };
  }
  return { x: s, y: 0, alpha: 0 };
}

export function evaluateRackRoute(
  phi: number, radius: number, path?: Float64Array | null, profile?: Float64Array | null,
): RackRouteState {
  const phase = ((phi % RACK_PERIOD) + RACK_PERIOD) % RACK_PERIOD;
  let s: number;
  let normal: number;
  let side: RackRouteState["side"];
  if (phase <= RACK_SPAN) {
    s = radius * phase;
    normal = -Math.PI / 2;
    side = "front";
  } else if (phase <= RACK_SPAN + Math.PI) {
    s = radius * RACK_SPAN;
    normal = -Math.PI / 2 + phase - RACK_SPAN;
    side = "far-end";
  } else if (phase <= 2 * RACK_SPAN + Math.PI) {
    s = radius * (2 * RACK_SPAN + Math.PI - phase);
    normal = Math.PI / 2;
    side = "back";
  } else {
    s = 0;
    normal = Math.PI / 2 + phase - (2 * RACK_SPAN + Math.PI);
    side = "near-end";
  }
  const contact = rackContact(s, radius, path, profile);
  return {
    phase, side,
    contactX: contact.x, contactY: contact.y,
    centerX: contact.x + radius * Math.cos(contact.alpha + normal),
    centerY: contact.y + radius * Math.sin(contact.alpha + normal),
    heading: contact.alpha,
  };
}

const rackOutlines = new WeakMap<Float64Array, Map<number, Vertex[]>>();
const straightOutlines = new Map<number, Vertex[]>();
/** Shared rounded solid boundary, including end caps, in world units. */
export function rackOutline(radius: number, path?: Float64Array | null, profile?: Float64Array | null): Vertex[] {
  const key = path ?? profile;
  let cache = key ? rackOutlines.get(key) : straightOutlines;
  if (!cache) { cache = new Map(); rackOutlines.set(key!, cache); }
  const existing = cache.get(radius);
  if (existing) return existing;
  const points: Vertex[] = [];
  const length = radius * RACK_SPAN;
  const teeth = Math.max(1, Math.round(length / (2 * Math.PI * 155 / 124)));
  const append = (s: number, normal: number, toothed = false) => {
    const c = rackContact(s, radius, path, profile);
    const width = RACK_HALF_WIDTH + (toothed ? TOOTH_HEIGHT * 0.5 * (1 - Math.cos(s / length * teeth * 2 * Math.PI)) : 0);
    points.push({ x: c.x + width * Math.cos(c.alpha + normal), y: c.y + width * Math.sin(c.alpha + normal) });
  };
  const samples = Math.max(teeth * 12, path ? (path.length / 3 - 1) : profile ? profile.length - 1 : 1);
  for (let i = 0; i <= samples; i++) append(length * i / samples, -Math.PI / 2, true);
  for (let i = 1; i <= 24; i++) append(length, -Math.PI / 2 + i / 24 * Math.PI);
  for (let i = samples - 1; i >= 0; i--) append(length * i / samples, Math.PI / 2, true);
  for (let i = 1; i < 24; i++) append(0, Math.PI / 2 + i / 24 * Math.PI);
  cache.set(radius, points);
  return points;
}
