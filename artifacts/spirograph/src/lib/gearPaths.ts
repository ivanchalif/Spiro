import { gearRadius, type GearShape } from "./gearMath";

const cache = new Map<string, Path2D>();
const profileIds = new WeakMap<Float64Array, number>();
let nextId = 0;

/** Pixel-space outlines, rebuilt only when shape, zoom, or tooth parameters change. */
export function gearPath(
  shape: GearShape, radius: number, ecc: number, sides: number,
  teeth: number, toothHeight = 0, toothSign = 1, profile?: Float64Array | null,
): Path2D {
  if (profile && !profileIds.has(profile)) profileIds.set(profile, ++nextId);
  const key = [shape, radius, ecc, sides, teeth, toothHeight, toothSign, profile ? profileIds.get(profile) : 0].join(":");
  const existing = cache.get(key);
  if (existing) return existing;
  const path = new Path2D();
  const samples = Math.max(180, teeth * 12);
  for (let i = 0; i <= samples; i++) {
    const angle = i / samples * 2 * Math.PI;
    const base = gearRadius(shape, radius, ecc, angle, sides, profile);
    const r = base + (shape === "custom" ? 0 : toothHeight * 0.5 * (1 + toothSign * Math.cos(angle * teeth)));
    const x = r * Math.cos(angle), y = r * Math.sin(angle);
    if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
  }
  path.closePath();
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, path);
  return path;
}
