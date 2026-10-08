export type FieldConfig =
  | { type: "square"; width: number; height: number }
  | { type: "square_circle"; radius: number }
  | { type: "square_triangle"; side: number }
  | { type: "hex_parallelogram"; cols: number; rows: number; orientation?: "flat_top" | "pointy_top" }
  | { type: "hex_hexagon"; radius: number; orientation?: "flat_top" | "pointy_top" }
  | { type: "hex_rectangle"; cols: number; rows: number; orientation?: "flat_top" | "pointy_top" }
  | { type: "hex_circle"; radius: number; orientation?: "flat_top" | "pointy_top" }
  | { type: "hex_triangle"; side: number; orientation?: "flat_top" | "pointy_top" }
  | { type: "triangle_rect"; cols: number; rows: number; orientation?: "r0" | "r90" | "r180" | "r270" }
  | { type: "triangle_triangle"; side: number; orientation?: "r0" | "r90" | "r180" | "r270" }
  | { type: "triangle_hexagon"; radius: number; orientation?: "r0" | "r90" | "r180" | "r270" }
  | { type: "triangle_circle"; radius: number; orientation?: "r0" | "r90" | "r180" | "r270" }
  | { type: "cairo"; cols: number; rows: number }
  | { type: "square_custom"; points: [number, number][] }
  | { type: "hex_custom"; points: [number, number][]; orientation?: "flat_top" | "pointy_top" }
  | { type: "tri_custom"; points: [number, number][]; orientation?: "r0" | "r90" | "r180" | "r270" }
  | { type: "cairo_custom"; points: [number, number][] };

/**
 * The field after its editor-only shape definition has been resolved. Runtime consumers must use
 * this form: a new preset shape changes only the resolver, never geometry, rendering, or export.
 */
export type ResolvedField =
  | { type: "square"; width: 0; height: 0; kind: "square"; cells: [number, number][] }
  | { type: "hex_parallelogram"; cols: 0; rows: 0; kind: "hex"; orientation: "flat_top" | "pointy_top"; cells: [number, number][] }
  | { type: "triangle_rect"; cols: 0; rows: 0; kind: "triangle"; orientation: "r0" | "r90" | "r180" | "r270"; cells: [number, number][] }
  | { type: "cairo"; cols: 0; rows: 0; kind: "cairo"; cells: [number, number][] };

/** Accept legacy editor configurations at the field-configuration boundary only. */
export type Tessellation = FieldConfig | ResolvedField;

/** Family lookup safe for hot paths: it never resolves the field's cells. */
export function tessellationFamily(config: Tessellation): "square" | "hex" | "triangle" | "cairo" {
  if ("kind" in config) return config.kind;
  return config.type.startsWith("square") ? "square"
    : config.type.startsWith("hex") ? "hex"
      : config.type.startsWith("tri") ? "triangle" : "cairo";
}
