import { gearRadius, type GearShape } from "./gearMath";
import { outline } from "./contactGeometry";

const cache = new Map<string, Path2D>();
const profileIds = new WeakMap<Float64Array, number>();
let nextId = 0;

/** Pixel-space outlines, rebuilt only when shape, zoom, or tooth parameters change. */
export function gearPath(
  shape: GearShape, radius: number, ecc: number, sides: number,
  teeth: number, toothHeight = 0, toothSign = 1, profile?: Float64Array | null, rimPadding = 0,
): Path2D {
  if (profile && !profileIds.has(profile)) profileIds.set(profile, ++nextId);
  const key = [shape, radius, ecc, sides, teeth, toothHeight, toothSign, profile ? profileIds.get(profile) : 0, rimPadding].join(":");
  const existing = cache.get(key);
  if (existing) return existing;
  const path = new Path2D();
  const points = outline(a => gearRadius(shape, radius, ecc, a, sides, profile) + rimPadding, teeth, shape === "custom" ? 0 : toothHeight, toothSign);
  for (const [i, {x, y}] of points.entries()) {
    if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
  }
  path.closePath();
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, path);
  return path;
}
