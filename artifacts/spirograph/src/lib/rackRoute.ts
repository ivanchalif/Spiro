/** One closed route: front face, far-end semicircle, back face, near-end semicircle. */
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
