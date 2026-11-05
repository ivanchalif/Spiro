---
name: Long-session drawing history
description: Tradeoff between indefinite playback, preserved artwork, and undo precision.
---

Long-running drawings must remain bounded in memory without deleting visible artwork. Flatten older vector strokes to a raster archive, retaining recent vectors for undo/redo.

**Why:** Continuously accumulating and replaying all trace points makes an indefinitely looping drawing progressively slower. Raster archival preserves the visible result but intentionally sacrifices undo of individual archived strokes and some sharpness when enlarged.

**How to apply:** Keep this limitation visible in history controls. Include the archive in local saves and PNG exports. Do not advertise unlimited undo or lossless vector export without introducing a separate durable vector-storage strategy.
