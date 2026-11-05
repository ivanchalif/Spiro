---
name: Curved rack physics
description: How non-linear rack paths are represented and how the gear rolls on them.
---

## Rule
Use arc-length-based rack paths, preserving continuous travel around both ends and along the reverse face.

**Why:** The user explicitly corrected “wrap around”: resetting to the beginning or jumping between rack sides is not acceptable.

## How to apply
- Treat endpoint turns as part of one closed route, including curved racks.
- Check continuity of both gear position and pen trace across the turnarounds.
- A nominal-radius offset alone is inadequate for noncircular gears or rack thickness. Actual outline contact must determine clearance.
