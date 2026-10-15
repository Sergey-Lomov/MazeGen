import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, MazeStatisticsDto, RouteInfoDto, IssueDto, RuleParamDescriptor } from "../wasm/types";
import type { DisplayOrientation, FieldConfig, FieldShape, PresetFieldShape, PresetFieldShapeName } from "../fieldConfig";
import { FIELD_SHAPES_BY_KIND, hexOrientationOf, tessellationConfigOf, triOrientationOf } from "../fieldConfig";
import { encodePoint, decodePoint } from "../pixi/tessellationProjection";
import type { PresetConnectionEntry, PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry, LevelField, ResolveFieldAt } from "../pixi/fieldEditUtils";
import { computeAutoLockedNodes, presetEdgeKey } from "../pixi/fieldEditUtils";
import type { PresetEndpoint } from "../pixi/presetEndpoint";
import { remapPresetEndpointLevel, remapLevelKey } from "../pixi/presetEndpoint";
import type {
  MazeState, TessellationKind, SquareShape, HexShape, TriangleShape, CairoShape, HexOrientation, TriOrientation, DebugArenaHandle, FloorFieldConfig,
} from "./storeTypes";

/** The active floor's own field-shape state — the per-floor scoping point every field-editing
 * helper below reads/writes through (GitHub issue #338). */
export function activeFloorField(state: MazeState): FloorFieldConfig {
  return state.floorFields[state.activeFloorId];
}

/** Replaces the active floor's FloorFieldConfig, keyed by `state.activeFloorId`. */
export function withActiveFloorField(state: MazeState, patch: Partial<FloorFieldConfig>): { floorFields: Record<string, FloorFieldConfig> } {
  return {
    floorFields: {
      ...state.floorFields,
      [state.activeFloorId]: { ...activeFloorField(state), ...patch },
    },
  };
}

/** The active floor's 0-based `levels_ordered()`/`level_fields` index (GitHub issue #340) — the
 * value stamped onto a `PresetEndpoint.level` for anything the user places while this floor is
 * active (edge presets, teleport endpoints, locks, split points, and the start/finish/gen-source
 * markers). `undefined` for floor 0 so the wire stays byte-identical to pre-#340 single-floor
 * projects (`PresetEndpoint.level === undefined` already means floor 0 everywhere). */
export function activeFloorLevel(state: { floors: MazeState["floors"]; activeFloorId: MazeState["activeFloorId"] }): number | undefined {
  const index = state.floors.findIndex((f) => f.id === state.activeFloorId);
  return index <= 0 ? undefined : index;
}

/** Rewrites every `PresetEndpoint.level`-bearing piece of preset state to keep pointing at the
 * same floor after `moveFloor` swaps two floors' array positions (GitHub issue #340) — `level` is
 * a positional index into `floors`, so without this remap a preset would silently jump to
 * whichever floor now occupies its old array slot. `swap` is the pair of 0-based indices that
 * traded places. */
export function remapPresetLevelsOnFloorSwap(state: MazeState, swap: [number, number]): {
  presetConnections: Map<string, PresetConnectionEntry>;
  presetStart: PresetEndpoint | null;
  presetFinish: PresetEndpoint | null;
  presetGenSource: PresetEndpoint | null;
  lockedNodes: Map<string, import("../wasm/types").NodeLockKind>;
  presetTeleports: PresetTeleportEntry[];
  presetVerticalPassages: PresetVerticalPassageEntry[];
  presetElevators: PresetElevatorEntry[];
  presetSplitPoints: Record<string, number[]>;
  presetActiveSplitNode: Record<string, PresetEndpoint>;
} {
  const remapEp = (ep: PresetEndpoint) => remapPresetEndpointLevel(ep, swap);
  const remapEpOrNull = (ep: PresetEndpoint | null) => (ep === null ? null : remapEp(ep));

  const presetConnections = new Map<string, PresetConnectionEntry>();
  for (const entry of state.presetConnections.values()) {
    const from = remapEp(entry.from);
    const to = remapEp(entry.to);
    presetConnections.set(presetEdgeKey(from, to), { ...entry, from, to });
  }

  const lockedNodes = new Map<string, import("../wasm/types").NodeLockKind>();
  for (const [key, kind] of state.lockedNodes) lockedNodes.set(remapLevelKey(key, swap), kind);

  const presetTeleports = state.presetTeleports.map((t) => ({ ...t, from: remapEp(t.from), to: remapEp(t.to) }));
  const presetVerticalPassages = state.presetVerticalPassages.map((p) => ({ ...p, from: remapEp(p.from), to: remapEp(p.to) }));
  const presetElevators = state.presetElevators.map((e) => ({ ...e, floors: e.floors.map(remapEp) }));

  const presetSplitPoints: Record<string, number[]> = {};
  for (const [key, slots] of Object.entries(state.presetSplitPoints)) presetSplitPoints[remapLevelKey(key, swap)] = slots;

  const presetActiveSplitNode: Record<string, PresetEndpoint> = {};
  for (const [key, ep] of Object.entries(state.presetActiveSplitNode)) presetActiveSplitNode[remapLevelKey(key, swap)] = remapEp(ep);

  return {
    presetConnections,
    presetStart: remapEpOrNull(state.presetStart),
    presetFinish: remapEpOrNull(state.presetFinish),
    presetGenSource: remapEpOrNull(state.presetGenSource),
    lockedNodes,
    presetTeleports,
    presetVerticalPassages,
    presetElevators,
    presetSplitPoints,
    presetActiveSplitNode,
  };
}

/** Level-index equivalent of `remapPresetLevelsOnFloorSwap`, for `removeFloor` (GitHub issue
 * #340): every preset entry naming the removed floor (`removedLevel`, `undefined` = floor 0) is
 * dropped entirely — its floor no longer exists — and every entry above it has its `level` shifted
 * down by one to track the same floor's new array position, mirroring how `removeFloor` already
 * deletes the removed id's own `floorFields` entry. */
export function dropPresetLevelOnFloorRemove(state: MazeState, removedLevel: number): {
  presetConnections: Map<string, PresetConnectionEntry>;
  presetStart: PresetEndpoint | null;
  presetFinish: PresetEndpoint | null;
  presetGenSource: PresetEndpoint | null;
  lockedNodes: Map<string, import("../wasm/types").NodeLockKind>;
  presetTeleports: PresetTeleportEntry[];
  presetVerticalPassages: PresetVerticalPassageEntry[];
  presetElevators: PresetElevatorEntry[];
  presetSplitPoints: Record<string, number[]>;
  presetActiveSplitNode: Record<string, PresetEndpoint>;
} {
  const shift = (level: number | undefined): number | undefined => {
    const current = level ?? 0;
    const next = current > removedLevel ? current - 1 : current;
    return next === 0 ? undefined : next;
  };
  const touchesRemoved = (level: number | undefined) => (level ?? 0) === removedLevel;
  const shiftEp = (ep: PresetEndpoint): PresetEndpoint => {
    const level = shift(ep.level);
    return level === ep.level ? ep : { ...ep, level };
  };
  const shiftEpOrNull = (ep: PresetEndpoint | null): PresetEndpoint | null =>
    ep === null || touchesRemoved(ep.level) ? null : shiftEp(ep);

  const presetConnections = new Map<string, PresetConnectionEntry>();
  for (const entry of state.presetConnections.values()) {
    if (touchesRemoved(entry.from.level) || touchesRemoved(entry.to.level)) continue;
    const from = shiftEp(entry.from);
    const to = shiftEp(entry.to);
    presetConnections.set(presetEdgeKey(from, to), { ...entry, from, to });
  }

  const shiftKey = (key: string): string | null => {
    const [pointPart, levelPart] = key.split("@");
    const level = levelPart === undefined ? undefined : Number(levelPart);
    if (touchesRemoved(level)) return null;
    const next = shift(level);
    return next === undefined ? pointPart : `${pointPart}@${next}`;
  };

  const lockedNodes = new Map<string, import("../wasm/types").NodeLockKind>();
  for (const [key, kind] of state.lockedNodes) {
    const nextKey = shiftKey(key);
    if (nextKey !== null) lockedNodes.set(nextKey, kind);
  }

  const presetTeleports = state.presetTeleports
    .filter((t) => !touchesRemoved(t.from.level) && !touchesRemoved(t.to.level))
    .map((t) => ({ ...t, from: shiftEp(t.from), to: shiftEp(t.to) }));

  const presetVerticalPassages = state.presetVerticalPassages
    .filter((p) => !touchesRemoved(p.from.level) && !touchesRemoved(p.to.level))
    .map((p) => ({ ...p, from: shiftEp(p.from), to: shiftEp(p.to) }));

  // An elevator loses its entry entirely if the removed floor was one of its endpoints (the same
  // "nowhere to go" rationale as the other collections above); a surviving elevator has every
  // remaining endpoint's level shifted down.
  const presetElevators = state.presetElevators
    .filter((e) => !e.floors.some((f) => touchesRemoved(f.level)))
    .map((e) => ({ ...e, floors: e.floors.map(shiftEp) }));

  const presetSplitPoints: Record<string, number[]> = {};
  for (const [key, slots] of Object.entries(state.presetSplitPoints)) {
    const nextKey = shiftKey(key);
    if (nextKey !== null) presetSplitPoints[nextKey] = slots;
  }

  const presetActiveSplitNode: Record<string, PresetEndpoint> = {};
  for (const [key, ep] of Object.entries(state.presetActiveSplitNode)) {
    const nextKey = shiftKey(key);
    if (nextKey !== null) presetActiveSplitNode[nextKey] = shiftEp(ep);
  }

  return {
    presetConnections,
    presetStart: shiftEpOrNull(state.presetStart),
    presetFinish: shiftEpOrNull(state.presetFinish),
    presetGenSource: shiftEpOrNull(state.presetGenSource),
    lockedNodes,
    presetTeleports,
    presetVerticalPassages,
    presetElevators,
    presetSplitPoints,
    presetActiveSplitNode,
  };
}

/** Per-kind editor shape selection for `cfg` — the kind's own selection follows `cfg.shape`, every
 * other kind keeps its default selection. */
export function kindAndShapeFromConfig(cfg: FieldConfig): { kind: TessellationKind; squareShape: SquareShape; hexShape: HexShape; triangleShape: TriangleShape; cairoShape: CairoShape } {
  const kind = cfg.tessellation.kind;
  const selected = cfg.shape.shape === "custom" ? "free" : cfg.shape.shape;
  return {
    kind,
    squareShape: kind === "square" ? selected as SquareShape : "rect",
    hexShape: kind === "hex" ? selected as HexShape : "hexagon",
    triangleShape: kind === "tri" ? selected as TriangleShape : "triangle",
    cairoShape: kind === "cairo" ? selected as CairoShape : "rect",
  };
}

/** Default params of each preset shape per kind — UI registry metadata. */
const DEFAULT_PRESET_SHAPES: Record<TessellationKind, Partial<Record<PresetFieldShapeName, PresetFieldShape>>> = {
  square: {
    rect: { shape: "rect", cols: 11, rows: 11 },
    circle: { shape: "circle", radius: 10 },
    triangle: { shape: "triangle", side: 20 },
  },
  hex: {
    rect: { shape: "rect", cols: 10, rows: 10 },
    parallelogram: { shape: "parallelogram", cols: 10, rows: 10 },
    hexagon: { shape: "hexagon", radius: 8 },
    circle: { shape: "circle", radius: 8 },
    triangle: { shape: "triangle", side: 20 },
  },
  tri: {
    rect: { shape: "rect", cols: 10, rows: 10 },
    triangle: { shape: "triangle", side: 12 },
    hexagon: { shape: "hexagon", radius: 10 },
    circle: { shape: "circle", radius: 10 },
  },
  cairo: {
    rect: { shape: "rect", cols: 10, rows: 10 },
    circle: { shape: "circle", radius: 12 },
    triangle: { shape: "triangle", side: 20 },
    hexagon: { shape: "hexagon", radius: 12 },
  },
};

/** The maze-wide display orientation a kind's field carries (hex/tri only). */
export function orientationFor(kind: TessellationKind, hexOrientation: HexOrientation, triOrientation: TriOrientation): DisplayOrientation | undefined {
  return kind === "hex" ? hexOrientation : kind === "tri" ? triOrientation : undefined;
}

/** Composes a runtime `FieldConfig` from the maze-wide kind/orientation and a floor's shape. */
export function composeFieldConfig(kind: TessellationKind, shape: FieldShape, hexOrientation: HexOrientation, triOrientation: TriOrientation): FieldConfig {
  const orientation = orientationFor(kind, hexOrientation, triOrientation);
  return orientation === undefined
    ? { tessellation: tessellationConfigOf(kind), shape }
    : { tessellation: tessellationConfigOf(kind), orientation, shape };
}

export function buildPredefinedConfig(
  kind: TessellationKind,
  hexShape: HexShape,
  triangleShape: TriangleShape,
  hexOrientation: HexOrientation,
  triOrientation: TriOrientation,
  saved?: Partial<Record<PresetFieldShapeName, PresetFieldShape>>,
  squareShape: SquareShape = "rect",
  cairoShape: CairoShape = "rect",
): FieldConfig {
  const selected = kind === "square" ? squareShape : kind === "hex" ? hexShape : kind === "tri" ? triangleShape : cairoShape;
  const fallback: PresetFieldShapeName = kind === "hex" ? "circle" : kind === "tri" ? "hexagon" : "rect";
  const name: PresetFieldShapeName = selected !== "free" && FIELD_SHAPES_BY_KIND[kind].includes(selected) ? selected : fallback;
  const shape = saved?.[name] ?? DEFAULT_PRESET_SHAPES[kind][name]!;
  return composeFieldConfig(kind, shape, hexOrientation, triOrientation);
}

// Memoized on its own inputs (last-call cache) — `activeTessellationOf` calls this on every
// render while `isEditingField` is true (e.g. `ParamFields`' `useMazeStore` selector), so a fresh
// object per call would fail zustand's reference-equality snapshot check on every render and loop
// forever ("Maximum update depth exceeded" / "getSnapshot should be cached").
let freeConfigCacheKey: string | null = null;
let freeConfigCacheValue: FieldConfig | null = null;

export function buildFreeConfig(kind: TessellationKind, pts: Set<number>, hexOrientation: HexOrientation, triOrientation: TriOrientation): FieldConfig {
  const key = `${kind}|${hexOrientation}|${triOrientation}|${Array.from(pts).sort((a, b) => a - b).join(",")}`;
  if (freeConfigCacheKey === key && freeConfigCacheValue) return freeConfigCacheValue;

  const points = Array.from(pts).map(k => decodePoint(k) as [number, number]);
  const config = composeFieldConfig(kind, { shape: "custom", points }, hexOrientation, triOrientation);

  freeConfigCacheKey = key;
  freeConfigCacheValue = config;
  return config;
}

/** The kind's full default shape shown while choosing a tessellation in Basic configuration. */
const PREVIEW_SHAPES: Record<TessellationKind, PresetFieldShape> = {
  square: { shape: "rect", cols: 11, rows: 11 },
  hex: { shape: "parallelogram", cols: 10, rows: 10 },
  tri: { shape: "rect", cols: 10, rows: 10 },
  cairo: { shape: "rect", cols: 5, rows: 5 },
};

export function buildPreviewConfig(kind: TessellationKind, hexOri: HexOrientation, triOri: TriOrientation): FieldConfig {
  return composeFieldConfig(kind, PREVIEW_SHAPES[kind], hexOri, triOri);
}

export function buildPreviewState(kind: TessellationKind, hexOri: HexOrientation, triOri: TriOrientation) {
  return {
    previewKind: kind,
    previewHexOrientation: hexOri,
    previewTriOrientation: triOri,
    previewFieldConfig: buildPreviewConfig(kind, hexOri, triOri),
  };
}

export const emptyFreePoints = (): Record<TessellationKind, Set<number>> => ({
  square: new Set<number>(),
  hex: new Set<number>(),
  tri: new Set<number>(),
  cairo: new Set<number>(),
});

/** A fresh FloorFieldConfig for the given (maze-wide) tessellation kind/orientation — the kind's
 * "full" predefined shape (see Specs/field-editor.md's "Default shape per kind" table), no custom
 * points, default mode. Used by floorsSlice's addFloor for a floor with no field config yet. */
export function defaultFloorFieldConfig(kind: TessellationKind, hexOrientation: HexOrientation, triOrientation: TriOrientation): FloorFieldConfig {
  const squareShape: SquareShape = "rect";
  const hexShape: HexShape = kind === "hex" ? "hexagon" : "parallelogram";
  const triangleShape: TriangleShape = kind === "tri" ? "triangle" : "rect";
  const cairoShape: CairoShape = "rect";
  const cfg = buildPredefinedConfig(kind, hexShape, triangleShape, hexOrientation, triOrientation, undefined, squareShape, cairoShape);
  return {
    squareShape, hexShape, triangleShape, cairoShape,
    savedShapes: cfg.shape.shape === "custom" ? {} : { [cfg.shape.shape]: cfg.shape },
    fieldConfig: cfg,
    freeFieldPoints: emptyFreePoints(),
    isEditingField: false,
    fieldPoints: new Set<number>(),
    fieldEditMode: "default",
    fieldOperation: "add",
    fieldPrimitive: "point",
    fieldDirty: false,
  };
}

export function deriveEditState(
  kind: TessellationKind,
  squareShape: SquareShape,
  hexShape: HexShape,
  triangleShape: TriangleShape,
  cairoShape: CairoShape,
  freeFieldPoints: Record<TessellationKind, Set<number>>,
): { isEditingField: boolean; fieldPoints: Set<number> } {
  const isEditingField = squareShape === "free" || hexShape === "free" || triangleShape === "free" || cairoShape === "free";
  const fieldPoints = isEditingField ? freeFieldPoints[kind] : new Set<number>();
  return { isEditingField, fieldPoints };
}

/** Stale-debug flag, recomputed identically across nearly every mutating action. */
export function debugStaleOf(state: { debugArena: DebugArenaHandle | null }): boolean {
  return state.debugArena !== null;
}

/** Apply an edit to the active floor's active tessellation kind's free-field point set and
 * rebuild its config. */
export function withFieldPointsEdit(
  state: MazeState,
  editFn: (pts: Set<number>) => boolean,
): Partial<MazeState> {
  const field = activeFloorField(state);
  const fieldPoints = new Set(field.fieldPoints);
  const changed = editFn(fieldPoints);
  if (!changed) return {};
  const freeFieldPoints = { ...field.freeFieldPoints, [state.tessellationKind]: fieldPoints };
  const fieldConfig = buildFreeConfig(state.tessellationKind, fieldPoints, state.hexOrientation, state.triOrientation);
  return {
    ...withActiveFloorField(state, { fieldPoints, freeFieldPoints, fieldConfig, fieldDirty: true }),
    debugStale: debugStaleOf(state),
  };
}

/** Derive any floor's active FieldConfig, accounting for free-field editing. */
export function floorTessellationOf(state: { tessellationKind: TessellationKind; hexOrientation: HexOrientation; triOrientation: TriOrientation; floorFields: MazeState["floorFields"] }, floorId: string): FieldConfig {
  const field = state.floorFields[floorId];
  return field.isEditingField
    ? buildFreeConfig(state.tessellationKind, field.fieldPoints, state.hexOrientation, state.triOrientation)
    : field.fieldConfig;
}

/** Derive the active floor's active FieldConfig, accounting for free-field editing. */
export function activeFloorTessellationOf(state: { tessellationKind: TessellationKind; hexOrientation: HexOrientation; triOrientation: TriOrientation } & MazeState): FieldConfig {
  return floorTessellationOf(state, state.activeFloorId);
}

/** Minimal shape `levelFieldsOf`/`resolveFieldAtOf` need — a structural subset of `MazeState` so
 * callers (e.g. React components subscribing to individual store slices via `useMazeStore`) can
 * build this from a handful of selected fields without pulling in the whole state shape. */
type FloorFieldsSource = { floors: MazeState["floors"]; floorFields: MazeState["floorFields"] }
  & { tessellationKind: TessellationKind; hexOrientation: HexOrientation; triOrientation: TriOrientation };

/** One `LevelField` per floor, in `floors` array order (index = `PresetEndpoint.level`, `undefined`
 * for index 0) — feeds `computeAutoLockedNodes`'s multi-floor walk (GitHub issue #340). */
export function levelFieldsOf(state: FloorFieldsSource): LevelField[] {
  return state.floors.map((floor, index) => {
    const field = state.floorFields[floor.id];
    return {
      level: index === 0 ? undefined : index,
      cfg: floorTessellationOf(state, floor.id),
      customPoints: field.isEditingField ? field.fieldPoints : undefined,
    };
  });
}

/** `ResolveFieldAt` backed by `state.floors`/`state.floorFields` (GitHub issue #340) — feeds
 * `computeInvalidKeys`/`computeInvalidTeleportIds`/`computeInvalidMarkers`/
 * `computeInvalidSplitPoints`, each of which needs to resolve an arbitrary entry's own `level`
 * against that floor's own field, not just the active floor's. */
export function resolveFieldAtOf(state: FloorFieldsSource): ResolveFieldAt {
  const fields = levelFieldsOf(state);
  return (level) => {
    const index = level ?? 0;
    const field = fields[index];
    return field ? { cfg: field.cfg, customPoints: field.customPoints } : undefined;
  };
}

/** `presetConnections`/`presetSplitPoints`, allowing an in-flight patch to override either before
 * recomputation — mirrors the override pattern `withRecomputedAutoLock` needs when called with a
 * not-yet-committed `presetConnections` change. Walks every floor (GitHub issue #340) — an entry
 * on floor N only affects floor N's own auto-lock, but the combined result spans all floors since
 * `autoLockedNodes` is one flat, maze-wide set. */
export function recomputeAutoLock(state: MazeState, presetOverride?: { presetConnections?: Map<string, PresetConnectionEntry>; presetSplitPoints?: Record<string, number[]> }): Set<string> {
  if (!state.autoLock) return new Set<string>();
  const presetConnections = presetOverride?.presetConnections ?? state.presetConnections;
  const presetSplitPoints = presetOverride?.presetSplitPoints ?? state.presetSplitPoints;
  return computeAutoLockedNodes(presetConnections, levelFieldsOf(state), presetSplitPoints);
}

/** Recompute autoLockedNodes after a change to presetConnections (or other auto-lock inputs). */
export function withRecomputedAutoLock<T extends { presetConnections: Map<string, PresetConnectionEntry> }>(
  state: MazeState,
  patch: T,
): T & { autoLockedNodes: Set<string>; debugStale: boolean } {
  return { ...patch, autoLockedNodes: recomputeAutoLock(state, patch), debugStale: debugStaleOf(state) };
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
    statistics: null as MazeStatisticsDto | null,
    selectedNode: null as number | null,
    issues: [] as IssueDto[],
    routeInfo: null as RouteInfoDto | null,
    _generatedNodes: [] as NodeDto[],
    _generatedEdges: [] as EdgeDto[],
  };
}

/** Clear results derived from generation/post-edit while preserving presets and inputs. */
export function buildResetDownstreamState() {
  return {
    ...buildResetMazeState(),
    error: null,
    generationStatus: "idle" as const,
    fieldEditConfirmation: null,
    debugArena: null, debugStep: 0, debugStale: false,
    postEditCommands: [], postEditBaseline: null, postEditDerived: null,
    postEditDraftEdges: null, postEditDraftTeleports: [], postEditTeleportPendingFrom: null,
    _nextPostEditTeleportId: 1, postEditDraftMeta: null, postEditEdges: null,
    postEditTeleportEdges: [], postEditMeta: null, postEditAnalytics: null,
    postEditDirty: false, mazeDirty: false, activeRenderMode: null, openRenderModeSettings: null,
    postEditDraftSplitPoints: {},
    postEditDraftVerticalPassages: [], postEditVerticalPassagePending: null,
    _nextPostEditVerticalPassageId: 1, postEditDraftElevators: [], postEditElevatorPending: null,
    _nextPostEditElevatorId: 1, postEditSplitTargetPrompt: null, _nextSplitSlotId: {},
    postEditActiveSplitNode: {}, postEditDraftSplitPointIds: {}, _nextPostEditSplitPointId: 1,
    postEditFocusedPoint: null, postEditHoveredEntity: null, postEditEntityDeletePrompt: null,
    postEditResetPrompt: null, postEditChangesOpen: false, postEditChangesEntityFilter: null,
    postEditDragOverride: null, postEditDragFailureMessage: null,
    postEditEntityPickPrompt: null, postEditMoveRequest: null, postEditConnectionSettingsPrompt: null,
  };
}

/** Derive kind/shape/orientation/freeFieldPoints/savedShapes from a FieldConfig for the
 * active floor — shared by setFieldConfig and loadProject. */
export function deriveTessellationFromConfig(
  cfg: FieldConfig,
  currentHexOrientation: HexOrientation,
  currentTriOrientation: TriOrientation,
  currentFreeFieldPoints: Record<TessellationKind, Set<number>>,
  currentSavedShapes: Partial<Record<PresetFieldShapeName, PresetFieldShape>>,
) {
  const { kind, squareShape, hexShape, triangleShape, cairoShape } = kindAndShapeFromConfig(cfg);
  const hexOrientation = kind === "hex" ? hexOrientationOf(cfg) : currentHexOrientation;
  const triOrientation = kind === "tri" ? triOrientationOf(cfg) : currentTriOrientation;
  const shape = cfg.shape;
  const isCustom = shape.shape === "custom";
  const freeFieldPoints = shape.shape === "custom"
    ? { ...currentFreeFieldPoints, [kind]: new Set<number>(shape.points.map(([x, y]) => encodePoint(x, y))) }
    : currentFreeFieldPoints;
  const { isEditingField, fieldPoints } = deriveEditState(kind, squareShape, hexShape, triangleShape, cairoShape, freeFieldPoints);
  const savedShapes = shape.shape === "custom" ? currentSavedShapes : { ...currentSavedShapes, [shape.shape]: shape };
  return { kind, squareShape, hexShape, triangleShape, cairoShape, hexOrientation, triOrientation, freeFieldPoints, isEditingField, fieldPoints, savedShapes, isCustom };
}

/** Shape-setter factory — setSquareShape/setHexShape/setTriangleShape differ only by which shape field changes. Operates on the active floor's own FloorFieldConfig. */
export function makeShapeSetter<K extends "squareShape" | "hexShape" | "triangleShape" | "cairoShape">(
  fieldKey: K,
  kind: TessellationKind,
) {
  return (shape: SquareShape | HexShape | TriangleShape | CairoShape) => (state: MazeState): Partial<MazeState> => {
    const field = activeFloorField(state);
    if (shape === field[fieldKey]) return {};
    const squareShape = fieldKey === "squareShape" ? (shape as SquareShape) : field.squareShape;
    const hexShape = fieldKey === "hexShape" ? (shape as HexShape) : field.hexShape;
    const triangleShape = fieldKey === "triangleShape" ? (shape as TriangleShape) : field.triangleShape;
    const cairoShape = fieldKey === "cairoShape" ? (shape as CairoShape) : field.cairoShape;
    const { isEditingField, fieldPoints } = deriveEditState(state.tessellationKind, squareShape, hexShape, triangleShape, cairoShape, field.freeFieldPoints);
    const cfg = isEditingField
      ? buildFreeConfig(kind, fieldPoints, state.hexOrientation, state.triOrientation)
      : buildPredefinedConfig(kind, hexShape, triangleShape, state.hexOrientation, state.triOrientation, field.savedShapes, squareShape, cairoShape);
    return {
      ...withActiveFloorField(state, { [fieldKey]: shape, fieldConfig: cfg, isEditingField, fieldPoints, fieldDirty: true } as Partial<FloorFieldConfig>),
      ...buildResetDownstreamState(),
      error: null,
      debugStale: debugStaleOf(state),
    };
  };
}

/** Orientation-setter factory — setHexOrientation/setTriOrientation differ only by axis kind and
 * field name. Kind/orientation are maze-wide (Specs/field-editor.md), so a rotation rewrites
 * every floor's own fieldConfig/savedShapes for the affected kind, not just the active floor's. */
export function makeOrientationSetter(axisKind: "hex" | "tri", field: "hexOrientation" | "triOrientation") {
  return (orientation: HexOrientation | TriOrientation) => (state: MazeState): Partial<MazeState> => {
    if (orientation === state[field]) return {};
    if (state.tessellationKind !== axisKind) return { ...buildResetDownstreamState(), [field]: orientation } as Partial<MazeState>;
    const floorFields: Record<string, FloorFieldConfig> = {};
    for (const [floorId, f] of Object.entries(state.floorFields)) {
      const fieldConfig = mergeOrientation(f.fieldConfig, orientation);
      const { isEditingField } = deriveEditState(state.tessellationKind, f.squareShape, f.hexShape, f.triangleShape, f.cairoShape, f.freeFieldPoints);
      const savedShapes = isEditingField || fieldConfig.shape.shape === "custom" ? f.savedShapes : { ...f.savedShapes, [fieldConfig.shape.shape]: fieldConfig.shape };
      floorFields[floorId] = { ...f, fieldConfig, savedShapes, fieldDirty: true };
    }
    const activeFieldConfig = state.nodes.length > 0
      ? mergeOrientation(state.activeFieldConfig, orientation)
      : state.activeFieldConfig;
    return {
      [field]: orientation, floorFields, activeFieldConfig,
      ...buildResetDownstreamState(),
      // A rotation changes which geometric face each offset index means (GitHub issue #235
      // follow-up) — a split-node panel left open across the flip would keep addressing faces
      // that no longer mean what its tile diagram was drawn for. Closing it is the same
      // "point/config just changed under it" rule `confirmTessellation`'s kind-change path
      // already applies to both focused-point fields.
      presetFocusedPoint: null,
      postEditFocusedPoint: null,
      presetSplitTargetPrompt: null,
      presetEntityPickPrompt: null,
      presetMoveRequest: null,
      presetConnectionSettingsPrompt: null,
      presetLockSettingsPrompt: null,
    } as Partial<MazeState>;
  };
}

export function mergeOrientation(current: FieldConfig, orientation: HexOrientation | TriOrientation): FieldConfig {
  return { ...current, orientation };
}

/** Rule-level parameters (GitHub issue #253) relevant to a rule's own composition — filters
 * `availableRuleParams` down to entries whose `applies_to` names at least one of this rule's own
 * active check `type_id`s or its strategy `id`. Not every rule shares the same rule-level
 * parameter set (e.g. `protect_route` is meaningless for a `min_region_count` rule). Shared by
 * `RuleParamsSection` (UI panel) and `generateConfigBuilder`'s `ruleToConfig` (wire config) so
 * both apply the exact same relevance rule instead of maintaining it independently in two places. */
export function relevantRuleParams(
  availableRuleParams: RuleParamDescriptor[],
  checkTypeIds: string[],
  strategyId: string | null,
): RuleParamDescriptor[] {
  const memberIds = new Set(checkTypeIds);
  if (strategyId) memberIds.add(strategyId);
  return availableRuleParams.filter((p) => p.applies_to.some((id) => memberIds.has(id)));
}
