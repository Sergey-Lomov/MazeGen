import type { TessellationShapes } from "../wasm/mazeService";
import type { TessellationConfig } from "../fieldConfig";

/** Stand-in for `getTessellationShapes` in suites that mock `mazeService` — the built-in
 *  tessellations' templates as core binds them (one template per kind, every cell bound to it).
 *  The real wasm answer is covered by `maze-wasm`'s own `tessellation_shapes` test. */
const KEYS: Record<TessellationConfig["kind"], string> = {
  square: "regular:4",
  hex: "regular:6",
  tri: "regular:3",
  cairo: "cairo_pentagon",
  square_octagon: "regular:8",
  brick: "brick:brick",
  trihexagonal: "regular:6",
  snub_hexagonal: "regular:6",
  rhombitrihexagonal: "regular:6",
  curved_quadrilateral: "curved_quadrilateral:curved_quadrilateral",
  radial: "radial:ring",
};

export function fakeTessellationShapes(config: { tessellation: TessellationConfig; points: [number, number][] }): TessellationShapes {
  const key = KEYS[config.tessellation.kind];
  return { keys: [key], point_shapes: config.points.map(() => key) };
}
