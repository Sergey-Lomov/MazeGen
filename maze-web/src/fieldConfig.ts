import { TESSELLATION_UI } from "./pixi/geometry/tessellationUi";

/** Registered tessellation kinds — mirrors `maze-runner`'s `TessellationKind` wire values. */
export type TessellationKind = "square" | "hex" | "tri" | "cairo" | "square_octagon" | "brick" | "trihexagonal" | "snub_hexagonal" | "rhombitrihexagonal" | "truncated_hexagonal" | "truncated_trihexagonal" | "elongated_triangular" | "snub_square" | "curved_quadrilateral" | "radial";

/**
 * A tessellation instance config, `{ kind, params }` — the same shape the wasm wire and project
 * files carry. Core builds the instance deterministically from it; the built-in kinds take no
 * params.
 */
export interface TessellationConfig {
  kind: TessellationKind;
  params: Record<string, unknown>;
}

export type HexOrientation = "flat_top" | "pointy_top";
export type TriOrientation = "r0" | "r90" | "r180" | "r270";
/** Display-only orientation; never part of the tessellation config or the field shape. */
export type DisplayOrientation = HexOrientation | TriOrientation;

/**
 * A floor's field shape, independent of the tessellation kind. Which preset shapes a tessellation
 * offers is decided by core (`field_capabilities`); `custom` carries the cell list directly.
 */
export type FieldShape =
  | { shape: "rect"; cols: number; rows: number }
  | { shape: "parallelogram"; cols: number; rows: number }
  | { shape: "circle"; radius: number }
  | { shape: "triangle"; side: number }
  | { shape: "hexagon"; radius: number }
  | { shape: "custom"; points: [number, number][] };

export type FieldShapeName = FieldShape["shape"];
export type PresetFieldShape = Exclude<FieldShape, { shape: "custom" }>;
export type PresetFieldShapeName = PresetFieldShape["shape"];

/**
 * A floor field as runtime code consumes it: the maze-wide tessellation config, its maze-wide
 * display orientation (hex/tri only) and the floor's own shape. Kind, params and shape are
 * separate settings — never a combined type tag.
 */
export interface FieldConfig {
  tessellation: TessellationConfig;
  orientation?: DisplayOrientation;
  shape: FieldShape;
}

/** A `FieldConfig` whose shape has been resolved to its explicit cell list. */
export type ResolvedField = FieldConfig & { shape: { shape: "custom"; points: [number, number][] } };

/** Family lookup safe for hot paths: it never resolves the field's cells. */
export function tessellationFamily(config: FieldConfig): TessellationKind {
  return config.tessellation.kind;
}

/** The `{ kind, params }` config of `kind` with its registry default params. */
export function tessellationConfigOf(kind: TessellationKind): TessellationConfig {
  return { kind, params: TESSELLATION_UI[kind].defaultParams };
}

export function hexOrientationOf(config: FieldConfig): HexOrientation {
  return (config.orientation as HexOrientation | undefined) ?? "flat_top";
}

export function triOrientationOf(config: FieldConfig): TriOrientation {
  return (config.orientation as TriOrientation | undefined) ?? "r0";
}

export function isCustomField(config: FieldConfig): config is ResolvedField {
  return config.shape.shape === "custom";
}

/** An empty field of `kind` — for geometry calls that only need the tessellation and orientation. */
export function kindFieldConfig(kind: TessellationKind, orientation?: DisplayOrientation): FieldConfig {
  const shape: FieldShape = { shape: "custom", points: [] };
  return orientation === undefined
    ? { tessellation: tessellationConfigOf(kind), shape }
    : { tessellation: tessellationConfigOf(kind), orientation, shape };
}
