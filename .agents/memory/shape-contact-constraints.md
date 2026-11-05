---
name: Shape contact constraints
description: Non-overlap requirement and the tradeoff for oversized interior gears.
---

The user requires gear edges to follow the governing shape without overlap, regardless of shape, in interior and exterior modes.

**Why:** Radius-only placement lets other portions of noncircular gears cross the governing boundary. Visible tooth tips, custom outlines, fills, nested gears, and rack thickness must obey the same constraint, not just the nominal pitch curves.

**How to apply:** Keep rendered and contact boundaries identical. Preserve the no-overlap invariant when changing outlines or adding decorations.

Use a conservative, constant fit reduction when an interior or nested gear cannot fit throughout rotation, and disclose it in the controls.

**Why:** An arbitrary large gear cannot fit inside a narrow shape without overlap. Changing its scale frame by frame would deform the moving gear and its trace. Arbitrary user-drawn shapes also need not form physically conjugate, no-slip gear pairs; do not claim exact mechanical rolling for them.

**How to apply:** Keep the fit factor independent of animation phase. Do not silently revert to overlapping or phase-dependent resizing to preserve a requested nominal radius.
