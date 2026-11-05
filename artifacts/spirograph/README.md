# Advanced Digital Spirograph

## Checks

From the workspace root:

```sh
pnpm --filter @workspace/spirograph test
pnpm --filter @workspace/spirograph run typecheck
PORT=23285 BASE_PATH=/ pnpm --filter @workspace/spirograph run build
```

Use the artifact's managed web workflow for development; it supplies the preview port and base path.

## Drawing behavior

- Play resumes a paused stroke without resetting its phase.
- New stroke adds a new drawing action, preserving existing artwork.
- Changing gear or pen configuration while paused starts a fresh stroke on the next Play.
- Rack motion follows one closed route: forward, around the far end, backward along the opposite side, around the near end. Path position wraps; rotation remains continuous.
- The three-body and spirograph engines own separate animation-frame handles.
- Simulation runs at fixed 60 Hz steps with capped catch-up after tab suspension. Rendering does not control simulation speed.
- Gear contact uses complete rendered polygons, including teeth and custom profiles, rather than subtracting radii. Interior contact stops at the first boundary collision; exterior contact stops outside the last collision along the travel ray. Rack thickness and rounded caps participate in contact.
- Oversized interior and nested gears use a constant, rotation-independent fit factor. This is deliberately conservative: the gear must fit at every angle, rather than changing size while rotating. The controls disclose auto-fitting.
- Arc-length phase drives rotation. Arbitrary custom shapes are constrained visualizations, not necessarily mechanically conjugate gear pairs with exact no-slip rolling.

## Modules

- `lib/rackRoute.ts`: shared rack contact and endpoint geometry.
- `lib/simulation.ts`: world transforms, nested gears, fixed-step timing, bounded trail buffers.
- `lib/gearMath.ts`: gear profiles and arc-length integration.
- `lib/contactGeometry.ts`: shared outline sampling and binned polygon contact events.
- `lib/gearPaths.ts`: bounded cache of reusable canvas gear outlines.
- `lib/traceLayer.ts`: incremental trace rasterization and long-session archival.
- `lib/nbodyRenderer.ts`: three-body trail/body rendering.
- `lib/savedDrawing.ts`: versioned, validated browser-save contract.
- `components/SimulationLayout.tsx`, `ControlSlider.tsx`, `DrawingActions.tsx`: responsive layout, accessible inputs, history/file controls.

The page connects configuration, animation, and the existing gear renderer. Preview, extra pens, and live animation use the same world-space evaluator.

## History and local files

Recent strokes support undo/redo while paused. During long sessions, older vector segments are flattened into an image to keep playback memory and drawing work bounded. Flattened artwork remains visible and exportable, but cannot be individually undone and may soften when enlarged.

Save locally stores one versioned drawing and its settings in this browser. It replaces the previous local save; restore asks before replacing current artwork. Three-body saves include body state and trails. Storage failures are shown explicitly. Export PNG downloads the artwork without gear overlays in spirograph mode, or the current simulation in three-body mode.

No accounts, cloud storage, or database tables are needed for these features. The shared health API/database scaffolding is intentionally unchanged.
