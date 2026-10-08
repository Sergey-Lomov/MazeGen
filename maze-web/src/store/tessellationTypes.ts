import type { FieldConfig as TessellationConfig } from "../fieldConfig";

export type TessellationKind = "square" | "hex" | "triangle" | "cairo";
export type SquareShape = "rect" | "circle" | "triangle" | "free";
export type HexShape = "rectangle" | "circle" | "triangle" | "parallelogram" | "hexagon" | "free";
export type TriangleShape = "rect" | "triangle" | "hexagon" | "circle" | "free";
export type CairoShape = "rect" | "free";
export type HexOrientation = "flat_top" | "pointy_top";
export type TriOrientation = "r0" | "r90" | "r180" | "r270";
export type FieldPrimitive =
  | "point" | "rectangle" | "circle" | "triangle" | "equilateral_triangle" | "hexagon" | "parallelogram" | "polygon" | "symmetry" | "magic_wand";
export type FieldOperation = "add" | "remove" | "select";
export type SymmetrySnapMode = "centers" | "corners" | "free";
export type SymmetryScope = "everything" | "one_side" | "polygon";
export type SymmetryPoint = { x: number; y: number };
export type BackgroundImageLayerMode = "below_grid" | "above_grid" | "above_floor" | "above_everything";
export type BackgroundAutoFillMode = "transparent" | "color";
export interface BackgroundImage {
  dataUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  /** Source-image crop rectangle in natural-image pixels. Optional for in-memory legacy fixtures. */
  cropX?: number;
  cropY?: number;
  cropWidth?: number;
  cropHeight?: number;
  displayWidth: number;
  displayHeight: number;
  centerX: number;
  centerY: number;
  layer: BackgroundImageLayerMode;
  opacity: number;
}
export type FeatureId = "basic_config" | "floors" | "field_setup" | "preset_connections" | "quality" | "generation" | "post_edit" | "analytics" | "image_export";

export type PendingFieldEdit =
  | { kind: "setSquareShape"; shape: SquareShape }
  | { kind: "setHexShape"; shape: HexShape }
  | { kind: "setTriangleShape"; shape: TriangleShape }
  | { kind: "setCairoShape"; shape: CairoShape }
  | { kind: "setTessellationConfig"; config: TessellationConfig }
  | { kind: "setTessellationConfigForFloors"; config: TessellationConfig; applyToAllStandardFloors: boolean }
  | { kind: "setTessellationConfigsForFloors"; configs: Record<string, TessellationConfig>; applyToAllStandardFloors: boolean }
  | { kind: "addFieldPoint"; x: number; y: number }
  | { kind: "removeFieldPoint"; x: number; y: number }
  | { kind: "addFieldPoints"; cells: [number, number][] }
  | { kind: "removeFieldPoints"; cells: [number, number][] }
  | { kind: "moveFieldPoints"; cells: [number, number][]; dx: number; dy: number }
  | { kind: "clearFieldPoints" }
  | { kind: "setFieldEditMode"; mode: "default" | "custom" }
  | { kind: "applySymmetry" }
  | { kind: "copyFloorField"; sourceFloorId: string };

export const DEFAULT_HEX_ORI: HexOrientation = "flat_top";
export const DEFAULT_TRI_ORI: TriOrientation = "r0";

export interface TessellationState {
  seed: number;
  // Confirmed tessellation — set only on confirmTessellation(). Maze-wide: kind/orientation are
  // confirmed once in Basic configuration, not per floor (see Specs/field-editor.md).
  tessellationKind: TessellationKind;
  hexOrientation: HexOrientation;
  triOrientation: TriOrientation;
  tessellationConfirmed: boolean;
  // Preview tessellation — changes with every dropdown selection, drives canvas grid
  previewKind: TessellationKind;
  previewHexOrientation: HexOrientation;
  previewTriOrientation: TriOrientation;
  previewTessellationConfig: TessellationConfig;
  /** Snapshot of the (active floor's) field config taken at generate time — maze-wide, since
   * generation/post-edit/analytics are not yet multi-floor-aware (GitHub issue #355 tracks
   * migrating this once they are; see Specs/floors.md's Non-goals). */
  activeTessellationConfig: TessellationConfig;
  showFieldOverlay: boolean;
  showFieldOrigin: boolean;
  showPrimitiveFrame: boolean;
  /** Whether the custom-field editor shows the shared print paper and margin guides. */
  showPaperLayout: boolean;
  /** Shared visual-only underlay used by the field, preset, and post-edit editors. */
  showBackgroundImage: boolean;
  backgroundImage: BackgroundImage | null;
  /** Enables direct drag/resize interaction with the shared underlay on the canvas. */
  backgroundImageManualPositioning: boolean;
  /** Enables source-image crop interaction with the shared underlay on the canvas. */
  backgroundImageCropping: boolean;
  /** Transient custom-field preview produced by the underlay auto-fill tool. */
  backgroundAutoFillPreview: Set<number> | null;
  smoothPrimitives: boolean;
  symmetrySnapMode: SymmetrySnapMode;
  symmetryScope: SymmetryScope;
  symmetryAxisPoints: SymmetryPoint[];
  symmetrySourceSide: -1 | 1;
  symmetryPolygon: SymmetryPoint[];
  symmetryPolygonFinished: boolean;
}

export interface TessellationActions {
  setSeed: (seed: number) => void;
  // Preview actions — only change preview, not confirmed
  setPreviewKind: (kind: TessellationKind) => void;
  setPreviewHexOrientation: (orientation: HexOrientation) => void;
  setPreviewTriOrientation: (orientation: TriOrientation) => void;
  // Confirm — copies preview -> confirmed, triggers confirmed-dependent state
  confirmTessellation: () => void;
  syncPreviewToConfirmed: () => void;
  // Shape actions (operate on confirmed tessellation)
  setTessellationKind: (kind: TessellationKind) => void;
  setHexOrientation: (orientation: HexOrientation) => void;
  setTriOrientation: (orientation: TriOrientation) => void;
  setShowFieldOverlay: (show: boolean) => void;
  setShowFieldOrigin: (show: boolean) => void;
  setShowPrimitiveFrame: (show: boolean) => void;
  setShowPaperLayout: (show: boolean) => void;
  setShowBackgroundImage: (show: boolean) => void;
  setBackgroundImage: (image: BackgroundImage) => void;
  setBackgroundImageLayer: (layer: BackgroundImageLayerMode) => void;
  setBackgroundImageOpacity: (opacity: number) => void;
  setBackgroundImageManualPositioning: (enabled: boolean) => void;
  setBackgroundImageCropping: (enabled: boolean) => void;
  setBackgroundImageTransform: (transform: Pick<BackgroundImage, "displayWidth" | "displayHeight" | "centerX" | "centerY">) => void;
  setBackgroundAutoFillPreview: (points: Set<number> | null) => void;
  setSmoothPrimitives: (smooth: boolean) => void;
  setSymmetrySnapMode: (mode: SymmetrySnapMode) => void;
  setSymmetryScope: (scope: SymmetryScope) => void;
  setSymmetryAxisPoints: (points: SymmetryPoint[]) => void;
  setSymmetrySourceSide: (side: -1 | 1) => void;
  setSymmetryPolygon: (points: SymmetryPoint[]) => void;
  finishSymmetryPolygon: () => void;
  resetSymmetryPolygon: () => void;
  resetSymmetryAxis: () => void;
}

/** Per-floor field-shape state — GitHub issue #338. Everything about "what cells make up this
 * floor's field" lives here, keyed by floor id; kind/orientation stay maze-wide in
 * TessellationState (see Specs/field-editor.md). */
export interface FloorFieldConfig {
  squareShape: SquareShape;
  hexShape: HexShape;
  triangleShape: TriangleShape;
  cairoShape: CairoShape;
  /** Saved params per predefined config type, preserved across shape/mode switches. */
  savedConfigs: Partial<Record<TessellationConfig["type"], TessellationConfig>>;
  tessellationConfig: TessellationConfig;
  /** Per-kind free-field points, preserved when switching shapes within same kind. */
  freeFieldPoints: Record<TessellationKind, Set<number>>;
  /**
   * True when the active field is custom (free-draw). Set by:
   * - shape actions (setSquareShape/setHexShape/setTriangleShape) when shape === "free"
   * - setFieldEditMode("custom") / setFieldEditMode("default") for card-based editing
   * generate() reads this directly to decide whether to use fieldPoints.
   */
  isEditingField: boolean;
  /**
   * Active custom cell set for the current tessellation kind.
   * Mirrors freeFieldPoints[tessellationKind] for predefined-shape flow;
   * set directly by setFieldEditMode for card-based custom editing.
   */
  fieldPoints: Set<number>;
  fieldEditMode: "default" | "custom";
  /** Operation applied by the active primitive. */
  fieldOperation: FieldOperation;
  fieldPrimitive: FieldPrimitive;
  /** True after any field setup change since the last confirmTessellation. */
  fieldDirty: boolean;
}

export interface FloorFieldsState {
  /** One FloorFieldConfig per floor id — always has an entry for every id in `floors` (see
   * floorsSlice.ts's addFloor/removeFloor, which keep this map in sync). */
  floorFields: Record<string, FloorFieldConfig>;
  fieldEditConfirmation: PendingFieldEdit | null;
}

export interface FloorFieldsActions {
  setSquareShape: (shape: SquareShape) => void;
  setHexShape: (shape: HexShape) => void;
  setTriangleShape: (shape: TriangleShape) => void;
  setCairoShape: (shape: CairoShape) => void;
  setTessellationConfig: (cfg: TessellationConfig) => void;
  setTessellationConfigForFloors: (cfg: TessellationConfig, applyToAllStandardFloors: boolean) => void;
  setTessellationConfigsForFloors: (configs: Record<string, TessellationConfig>, applyToAllStandardFloors: boolean) => void;
  addFieldPoint: (x: number, y: number) => void;
  removeFieldPoint: (x: number, y: number) => void;
  addFieldPoints: (cells: [number, number][]) => void;
  removeFieldPoints: (cells: [number, number][]) => void;
  /** Moves selected custom-field cells atomically, preserving destination collisions. */
  moveFieldPoints: (cells: [number, number][], dx: number, dy: number) => void;
  clearFieldPoints: () => void;
  setFieldEditMode: (mode: "default" | "custom") => void;
  setFieldOperation: (operation: FieldOperation) => void;
  setFieldPrimitive: (p: FieldPrimitive) => void;
  applySymmetry: () => void;
  /** Replaces the active floor's field config with a copy of `sourceFloorId`'s (GitHub issue
   * #338's "Copy floor" dialog). */
  copyFloorField: (sourceFloorId: string) => void;
  applyBackgroundAutoFill: (points: Set<number>) => void;
  confirmFieldEdit: () => void;
  cancelFieldEdit: () => void;
}
