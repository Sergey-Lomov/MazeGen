export type FieldConfig =
  | { type: "square"; width: number; height: number }
  | { type: "hex_parallelogram"; cols: number; rows: number; orientation?: "flat_top" | "pointy_top" }
  | { type: "hex_hexagon"; radius: number; orientation?: "flat_top" | "pointy_top" }
  | { type: "triangle_rect"; cols: number; rows: number; orientation?: "r0" | "r90" | "r180" | "r270" }
  | { type: "triangle_triangle"; side: number; orientation?: "r0" | "r90" | "r180" | "r270" }
  | { type: "triangle_hexagon"; radius: number; orientation?: "r0" | "r90" | "r180" | "r270" }
  | { type: "square_custom"; points: [number, number][] }
  | { type: "hex_custom"; points: [number, number][]; orientation?: "flat_top" | "pointy_top" }
  | { type: "tri_custom"; points: [number, number][]; orientation?: "r0" | "r90" | "r180" | "r270" };
