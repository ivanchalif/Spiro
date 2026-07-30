---
name: Curved rack UI wiring
description: How rackCurveType/rackBend state is kept in sync with the zero-dep rebuildTables callback.
---

## Rule
`rebuildTables` has a `[]` deps array (captures nothing from closure). It reads `rackCurveTypeRef.current` and `rackBendRef.current` — stable mutable refs that are always kept in sync with the matching React state via the handlers.

**Why:** React state would be stale inside a zero-dep useCallback. Using refs sidesteps this without changing the entire rebuildTables dependency chain.

## How to apply
- Declare `const rackCurveTypeRef = useRef<RackCurveType>("straight")` and `rackBendRef = useRef<number>(50)` directly after their corresponding `useState`.
- In `handleRackCurveType` and `handleRackBend`: set state AND update the ref before calling `rebuildTables`.
- In `handleMeshMode` when leaving rack: reset both state and refs, and clear `rackPathTableRef.current = null`.
- `simRef` carries `rackPathMidX`, `rackPathMidY`, `rackBounds` (computed in rebuildTables) for use in scale/centering.
