---
name: Curved rack physics
description: How non-linear rack paths are represented and how the gear rolls on them.
---

## Rule
Use intrinsic-curve representation: define each path by tangent angle α(s) as a function of arc length s, then integrate numerically to get (x, y). This avoids approximations and gives exact tangential rolling.

**Why:** Parameterising by arc length means the gear rolls the same distance regardless of path shape. The gear center offset perpendicular to the tangent is always `R·[sin α, -cos α]`, and `psi = psiRolling + alpha` bakes the path tangent into the returned orientation. All existing rotation formulas `psi + rackAngle` in callers remain correct without changes.

## How to apply
- `buildRackPathTable(curveType, bend, totalLen, N)` returns a packed `Float64Array [x, y, α …]` for N+1 arc-length samples (Simpson integration).
- `evalRackPath(table, s, totalLen)` interpolates `{x, y, alpha}` at any arc length.
- `computeMeshState` last optional param: `rackPathTable?: Float64Array | null`. When provided, it uses `evalRackPath` instead of the straight-line formula.
- For curved racks **skip the bottom pass**: `maxPhi = RACK_MAX_PHI` (not `2 × RACK_MAX_PHI`). The return-pass mirror logic only makes sense for a straight horizontal rack.
