import { z } from "zod";

const number = z.number().finite();
const range = (min: number, max: number) => number.min(min).max(max);
const shape = z.enum(["circle", "ellipse", "polygon", "custom"]);
const point = z.object({ x: number, y: number });
const table = z.array(range(-10, 10)).length(256).nullable();

export const savedDrawingSchema = z.object({
  version: z.literal(1),
  settings: z.object({
    gearIdx: range(0, 6).int(), gearRatio: range(20, 80),
    meshMode: z.enum(["internal", "external", "rack"]),
    fixedShape: shape, fixedEcc: range(0, 1), fixedSides: range(3, 12).int(),
    movingShape: shape, movingEcc: range(0, 1), movingSides: range(3, 12).int(),
    rackAngle: range(0, 360), rackCurveType: z.enum(["straight", "arc", "wave", "spiral"]), rackBend: range(0, 100),
    penMode: z.enum(["interior", "circumference"]), penOffset: range(0, 1), penCount: range(1, 5).int(),
    penWeight: range(0.5, 10), penColor: z.string().regex(/^#[0-9a-f]{6}$/i),
    rainbow: z.boolean(), compositeMode: z.boolean(), speed: z.enum(["partial", "full", "accelerated"]),
    nestedEnabled: z.boolean(), nestedRatio: range(10, 80), nestedSpeed: range(1, 8).int(), nestedPenOffset: range(0, 1),
    drawingEngine: z.enum(["spirograph", "threebody"]),
    nbodyPreset: z.enum(["figure8", "lagrange", "pythagorean", "butterfly", "binaryguest", "chaos"]),
    nbodyTrail: range(100, 10000).int(), nbodySteps: range(1, 50).int(),
  }),
  customFixed: table, customMoving: table,
  runs: z.array(z.object({
    points: z.array(point).max(80000),
    color: z.string().max(64), weight: range(0.5, 10), action: number.int().optional(),
  })).max(1024),
  archive: z.object({
    image: z.string().startsWith("data:image/png;base64,").max(6000000),
    view: z.object({ size: range(1, 4000), scale: range(0.0001, 1000), offX: number, offY: number, dpr: range(1, 2) }),
  }).optional(),
  bodies: z.array(z.object({ x: number, y: number, vx: number, vy: number, m: number.positive() })).max(3),
  trails: z.array(z.array(point).max(10000)).length(3),
});
export type SavedDrawing = z.infer<typeof savedDrawingSchema>;
export const SAVE_KEY = "spirograph:drawing:v1";
