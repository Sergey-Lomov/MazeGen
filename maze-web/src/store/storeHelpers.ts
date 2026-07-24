import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, GraphAnalyticsDto, NodeStatsDto, SpatialEdgeStatsDto, TeleportEdgeStatsDto, RouteInfoDto, IssueDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { encodePoint, decodePoint } from "../pixi/tessellationProjection";
import type { PresetConnectionEntry } from "../pixi/fieldEditUtils";
import { computeAutoLockedNodes } from "../pixi/fieldEditUtils";
import type {
  MazeState, TessellationKind, SquareShape, HexShape, TriangleShape, HexOrientation, TriOrientation, DebugArenaHandle,
} from "./storeTypes";
import { DEFAULT_HEX_ORI, DEFAULT_TRI_ORI } from "./storeTypes";

export function kindAndShapeFromConfig(cfg: TessellationConfig): { kind: TessellationKind; squareShape: SquareShape; hexShape: HexShape; triangleShape: TriangleShape } {
  switch (cfg.type) {
    case "square":
      return { kind: "square", squareShape: "rect", hexShape: "hexagon", triangleShape: "triangle" };
    case "hex_parallelogram":
      return { kind: "hex", squareShape: "rect", hexShape: "parallelogram", triangleShape: "triangle" };
    case "hex_hexagon":
      return { kind: "hex", squareShape: "rect", hexShape: "hexagon", triangleShape: "triangle" };
    case "triangle_rect":
      return { kind: "triangle", squareShape: "rect", hexShape: "hexagon", triangleShape: "rect" };
    case "triangle_triangle":
      return { kind: "triangle", squareShape: "rect", hexShape: "hexagon", triangleShape: "triangle" };
    case "triangle_hexagon":
      return { kind: "triangle", squareShape: "rect", hexShape: "hexagon", triangleShape: "hexagon" };
    case "square_custom":
      return { kind: "square", squareShape: "free", hexShape: "hexagon", triangleShape: "triangle" };
    case "hex_custom":
      return { kind: "hex", squareShape: "rect", hexShape: "free", triangleShape: "triangle" };
    case "tri_custom":
      return { kind: "triangle", squareShape: "rect", hexShape: "hexagon", triangleShape: "free" };
  }
}

export function buildPredefinedConfig(
  kind: TessellationKind,
  hexShape: HexShape,
  triangleShape: TriangleShape,
  hexOrientation: HexOrientation,
  triOrientation: TriOrientation,
  saved?: Partial<Record<TessellationConfig["type"], TessellationConfig>>,
): TessellationConfig {
  if (kind === "square") {
    const base = saved?.["square"] as { type: "square"; width: number; height: number } | undefined;
    return { type: "square", width: base?.width ?? 11, height: base?.height ?? 11 };
  }
  if (kind === "hex") {
    if (hexShape === "parallelogram") {
      const base = saved?.["hex_parallelogram"] as { type: "hex_parallelogram"; cols: number; rows: number; orientation: HexOrientation } | undefined;
      return { type: "hex_parallelogram", cols: base?.cols ?? 10, rows: base?.rows ?? 10, orientation: hexOrientation };
    }
    const base = saved?.["hex_hexagon"] as { type: "hex_hexagon"; radius: number; orientation: HexOrientation } | undefined;
    return { type: "hex_hexagon", radius: base?.radius ?? 5, orientation: hexOrientation };
  }
  if (triangleShape === "rect") {
    const base = saved?.["triangle_rect"] as { type: "triangle_rect"; cols: number; rows: number; orientation: TriOrientation } | undefined;
    return { type: "triangle_rect", cols: base?.cols ?? 10, rows: base?.rows ?? 10, orientation: triOrientation };
  }
  if (triangleShape === "triangle") {
    const base = saved?.["triangle_triangle"] as { type: "triangle_triangle"; side: number; orientation: TriOrientation } | undefined;
    return { type: "triangle_triangle", side: base?.side ?? 8, orientation: triOrientation };
  }
  const base = saved?.["triangle_hexagon"] as { type: "triangle_hexagon"; radius: number; orientation: TriOrientation } | undefined;
  return { type: "triangle_hexagon", radius: base?.radius ?? 4, orientation: triOrientation };
}

export function buildFreeConfig(kind: TessellationKind, pts: Set<number>, hexOrientation: HexOrientation, triOrientation: TriOrientation): TessellationConfig {
  const points = Array.from(pts).map(k => decodePoint(k) as [number, number]);
  if (kind === "square") return { type: "square_custom", points };
  if (kind === "hex") return { type: "hex_custom", points, orientation: hexOrientation } as TessellationConfig;
  return { type: "tri_custom", points, orientation: triOrientation } as TessellationConfig;
}

export function buildPreviewConfig(kind: TessellationKind, hexOri: HexOrientation, triOri: TriOrientation): TessellationConfig {
  if (kind === "square") return { type: "square", width: 11, height: 11 };
  if (kind === "hex") return { type: "hex_parallelogram", cols: 10, rows: 10, orientation: hexOri };
  return { type: "triangle_rect", cols: 10, rows: 10, orientation: triOri };
}

export function buildPreviewState(kind: TessellationKind, hexOri: HexOrientation, triOri: TriOrientation) {
  return {
    previewKind: kind,
    previewHexOrientation: hexOri,
    previewTriOrientation: triOri,
    previewTessellationConfig: buildPreviewConfig(kind, hexOri, triOri),
  };
}

export const emptyFreePoints = (): Record<TessellationKind, Set<number>> => ({
  square: new Set<number>(),
  hex: new Set<number>(),
  triangle: new Set<number>(),
});

export function deriveEditState(
  kind: TessellationKind,
  squareShape: SquareShape,
  hexShape: HexShape,
  triangleShape: TriangleShape,
  freeFieldPoints: Record<TessellationKind, Set<number>>,
): { isEditingField: boolean; fieldPoints: Set<number> } {
  const isEditingField = squareShape === "free" || hexShape === "free" || triangleShape === "free";
  const fieldPoints = isEditingField ? freeFieldPoints[kind] : new Set<number>();
  return { isEditingField, fieldPoints };
}

/** Stale-debug flag, recomputed identically across nearly every mutating action. */
export function debugStaleOf(state: { debugArena: DebugArenaHandle | null }): boolean {
  return state.debugArena !== null;
}

/** Apply an edit to the active tessellation kind's free-field point set and rebuild its config. */
export function withFieldPointsEdit(
  state: MazeState,
  editFn: (pts: Set<number>) => boolean,
): Partial<MazeState> {
  const fieldPoints = new Set(state.fieldPoints);
  const changed = editFn(fieldPoints);
  if (!changed) return {};
  const freeFieldPoints = { ...state.freeFieldPoints, [state.tessellationKind]: fieldPoints };
  const tessellationConfig = buildFreeConfig(state.tessellationKind, fieldPoints, state.hexOrientation, state.triOrientation);
  return { fieldPoints, freeFieldPoints, tessellationConfig, fieldDirty: true, debugStale: debugStaleOf(state) };
}

/** Derive the active tessellation TessellationConfig, accounting for free-field editing. */
export function activeTessellationOf(state: { isEditingField: boolean; tessellationKind: TessellationKind; fieldPoints: Set<number>; hexOrientation: HexOrientation; triOrientation: TriOrientation; tessellationConfig: TessellationConfig }): TessellationConfig {
  return state.isEditingField
    ? buildFreeConfig(state.tessellationKind, state.fieldPoints, state.hexOrientation, state.triOrientation)
    : state.tessellationConfig;
}

export function recomputeAutoLock(state: MazeState): Set<string> {
  if (!state.autoLock) return new Set<string>();
  const activeTessellation = activeTessellationOf(state);
  const customPts = state.isEditingField ? state.fieldPoints : undefined;
  return computeAutoLockedNodes(state.presetConnections, activeTessellation, customPts, state.presetSplitPoints);
}

/** Recompute autoLockedNodes after a change to presetConnections (or other auto-lock inputs). */
export function withRecomputedAutoLock<T extends { presetConnections: Map<string, PresetConnectionEntry> }>(
  state: MazeState,
  patch: T,
): T & { autoLockedNodes: Set<string>; debugStale: boolean } {
  return { ...patch, autoLockedNodes: recomputeAutoLock({ ...state, ...patch }), debugStale: debugStaleOf(state) };
}

/** Shared "wipe maze + derived analytics" fields, used by tessellation-kind switches, reset, and project load. */
export function buildResetMazeState() {
  return {
    nodes: [] as NodeDto[],
    edges: [] as EdgeDto[],
    start: null as number | null,
    finish: null as number | null,
    navNodes: [] as NavNodeDto[],
    navEdges: [] as NavEdgeDto[],
    graphAnalytics: null as GraphAnalyticsDto | null,
    selectedNode: null as number | null,
    issues: [] as IssueDto[],
    nodeStats: null as NodeStatsDto | null,
    edgeStats: null as SpatialEdgeStatsDto | null,
    teleportEdgeStats: null as TeleportEdgeStatsDto | null,
    routeInfo: null as RouteInfoDto | null,
  };
}

/** Derive kind/shape/orientation/freeFieldPoints/savedConfigs from a TessellationConfig — shared by setTessellationConfig and loadProject. */
export function deriveTessellationFromConfig(
  cfg: TessellationConfig,
  currentHexOrientation: HexOrientation,
  currentTriOrientation: TriOrientation,
  currentFreeFieldPoints: Record<TessellationKind, Set<number>>,
  currentSavedConfigs: Partial<Record<TessellationConfig["type"], TessellationConfig>>,
) {
  const { kind, squareShape, hexShape, triangleShape } = kindAndShapeFromConfig(cfg);
  const hexOrientation = (cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon" || cfg.type === "hex_custom")
    ? ((cfg as { orientation?: HexOrientation }).orientation ?? DEFAULT_HEX_ORI)
    : currentHexOrientation;
  const triOrientation = (cfg.type === "triangle_rect" || cfg.type === "triangle_triangle" || cfg.type === "triangle_hexagon" || cfg.type === "tri_custom")
    ? ((cfg as { orientation?: TriOrientation }).orientation ?? DEFAULT_TRI_ORI)
    : currentTriOrientation;
  const isCustom = cfg.type === "square_custom" || cfg.type === "hex_custom" || cfg.type === "tri_custom";
  const freeFieldPoints = isCustom
    ? {
        ...currentFreeFieldPoints,
        [kind]: new Set<number>((cfg as { points?: [number, number][] }).points?.map(([x, y]) => encodePoint(x, y)) ?? []),
      }
    : currentFreeFieldPoints;
  const { isEditingField, fieldPoints } = deriveEditState(kind, squareShape, hexShape, triangleShape, freeFieldPoints);
  const savedConfigs = isCustom ? currentSavedConfigs : { ...currentSavedConfigs, [cfg.type]: cfg };
  return { kind, squareShape, hexShape, triangleShape, hexOrientation, triOrientation, freeFieldPoints, isEditingField, fieldPoints, savedConfigs, isCustom };
}

/** Shape-setter factory — setSquareShape/setHexShape/setTriangleShape differ only by which shape field changes. */
export function makeShapeSetter<K extends "squareShape" | "hexShape" | "triangleShape">(
  field: K,
  kind: TessellationKind,
) {
  return (shape: SquareShape | HexShape | TriangleShape) => (state: MazeState): Partial<MazeState> => {
    if (shape === state[field]) return {};
    const squareShape = field === "squareShape" ? (shape as SquareShape) : state.squareShape;
    const hexShape = field === "hexShape" ? (shape as HexShape) : state.hexShape;
    const triangleShape = field === "triangleShape" ? (shape as TriangleShape) : state.triangleShape;
    const { isEditingField, fieldPoints } = deriveEditState(state.tessellationKind, squareShape, hexShape, triangleShape, state.freeFieldPoints);
    const cfg = isEditingField
      ? buildFreeConfig(kind, fieldPoints, state.hexOrientation, state.triOrientation)
      : buildPredefinedConfig(kind, hexShape, triangleShape, state.hexOrientation, state.triOrientation, state.savedConfigs);
    return { [field]: shape, tessellationConfig: cfg, isEditingField, fieldPoints, fieldDirty: true, error: null, debugStale: debugStaleOf(state) } as Partial<MazeState>;
  };
}

/** Orientation-setter factory — setHexOrientation/setTriOrientation differ only by axis kind and field name. */
export function makeOrientationSetter(axisKind: "hex" | "triangle", field: "hexOrientation" | "triOrientation") {
  return (orientation: HexOrientation | TriOrientation) => (state: MazeState): Partial<MazeState> => {
    if (orientation === state[field]) return {};
    if (state.tessellationKind !== axisKind) return { [field]: orientation } as Partial<MazeState>;
    const tessellationConfig = mergeOrientation(state.tessellationConfig, orientation);
    const { isEditingField } = deriveEditState(state.tessellationKind, state.squareShape, state.hexShape, state.triangleShape, state.freeFieldPoints);
    const savedConfigs = isEditingField ? state.savedConfigs : { ...state.savedConfigs, [tessellationConfig.type]: tessellationConfig };
    const activeTessellationConfig = state.nodes.length > 0
      ? mergeOrientation(state.activeTessellationConfig, orientation)
      : state.activeTessellationConfig;
    return { [field]: orientation, tessellationConfig, savedConfigs, activeTessellationConfig, fieldDirty: true, error: null, debugStale: debugStaleOf(state) } as Partial<MazeState>;
  };
}

export function mergeOrientation(current: TessellationConfig, orientation: HexOrientation | TriOrientation): TessellationConfig {
  return { ...current, orientation } as TessellationConfig;
}
