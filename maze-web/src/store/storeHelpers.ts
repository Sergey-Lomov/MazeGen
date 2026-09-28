import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, MazeStatisticsDto, RouteInfoDto, IssueDto, RuleParamDescriptor } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { encodePoint, decodePoint } from "../pixi/tessellationProjection";
import type { PresetConnectionEntry, PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry, LevelField, ResolveFieldAt } from "../pixi/fieldEditUtils";
import { computeAutoLockedNodes, presetEdgeKey } from "../pixi/fieldEditUtils";
import type { PresetEndpoint } from "../pixi/presetEndpoint";
import { remapPresetEndpointLevel, remapLevelKey } from "../pixi/presetEndpoint";
import type {
  MazeState, TessellationKind, SquareShape, HexShape, TriangleShape, HexOrientation, TriOrientation, DebugArenaHandle, FloorFieldConfig,
} from "./storeTypes";
import { DEFAULT_HEX_ORI, DEFAULT_TRI_ORI } from "./storeTypes";

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

export function kindAndShapeFromConfig(cfg: TessellationConfig): { kind: TessellationKind; squareShape: SquareShape; hexShape: HexShape; triangleShape: TriangleShape } {
  switch (cfg.type) {
    case "square":
      return { kind: "square", squareShape: "rect", hexShape: "hexagon", triangleShape: "triangle" };
    case "square_circle":
      return { kind: "square", squareShape: "circle", hexShape: "hexagon", triangleShape: "triangle" };
    case "square_triangle":
      return { kind: "square", squareShape: "triangle", hexShape: "hexagon", triangleShape: "triangle" };
    case "hex_triangle":
      return { kind: "hex", squareShape: "rect", hexShape: "triangle", triangleShape: "triangle" };
    case "hex_parallelogram":
      return { kind: "hex", squareShape: "rect", hexShape: "parallelogram", triangleShape: "triangle" };
    case "hex_hexagon":
      return { kind: "hex", squareShape: "rect", hexShape: "hexagon", triangleShape: "triangle" };
    case "hex_rectangle":
      return { kind: "hex", squareShape: "rect", hexShape: "rectangle", triangleShape: "triangle" };
    case "hex_circle":
      return { kind: "hex", squareShape: "rect", hexShape: "circle", triangleShape: "triangle" };
    case "triangle_rect":
      return { kind: "triangle", squareShape: "rect", hexShape: "hexagon", triangleShape: "rect" };
    case "triangle_triangle":
      return { kind: "triangle", squareShape: "rect", hexShape: "hexagon", triangleShape: "triangle" };
    case "triangle_hexagon":
      return { kind: "triangle", squareShape: "rect", hexShape: "hexagon", triangleShape: "hexagon" };
    case "triangle_circle":
      return { kind: "triangle", squareShape: "rect", hexShape: "hexagon", triangleShape: "circle" };
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
  squareShape: SquareShape = "rect",
): TessellationConfig {
  if (kind === "square") {
    if (squareShape === "circle") {
      const circleBase = saved?.["square_circle"] as { type: "square_circle"; radius: number } | undefined;
      return { type: "square_circle", radius: circleBase?.radius ?? 10 };
    }
    if (squareShape === "triangle") {
      const base = saved?.["square_triangle"] as { type: "square_triangle"; side: number } | undefined;
      return { type: "square_triangle", side: base?.side ?? 20 };
    }
    const base = saved?.["square"] as { type: "square"; width: number; height: number } | undefined;
    return { type: "square", width: base?.width ?? 11, height: base?.height ?? 11 };
  }
  if (kind === "hex") {
    if (hexShape === "rectangle") {
      const base = saved?.["hex_rectangle"] as { type: "hex_rectangle"; cols: number; rows: number; orientation: HexOrientation } | undefined;
      return { type: "hex_rectangle", cols: base?.cols ?? 10, rows: base?.rows ?? 10, orientation: hexOrientation };
    }
    if (hexShape === "circle") {
      const base = saved?.["hex_circle"] as { type: "hex_circle"; radius: number; orientation: HexOrientation } | undefined;
      return { type: "hex_circle", radius: base?.radius ?? 8, orientation: hexOrientation };
    }
    if (hexShape === "triangle") {
      const base = saved?.["hex_triangle"] as { type: "hex_triangle"; side: number; orientation: HexOrientation } | undefined;
      return { type: "hex_triangle", side: base?.side ?? 20, orientation: hexOrientation };
    }
    if (hexShape === "parallelogram") {
      const base = saved?.["hex_parallelogram"] as { type: "hex_parallelogram"; cols: number; rows: number; orientation: HexOrientation } | undefined;
      return { type: "hex_parallelogram", cols: base?.cols ?? 10, rows: base?.rows ?? 10, orientation: hexOrientation };
    }
    if (hexShape === "hexagon") {
      const base = saved?.["hex_hexagon"] as { type: "hex_hexagon"; radius: number; orientation: HexOrientation } | undefined;
      return { type: "hex_hexagon", radius: base?.radius ?? 8, orientation: hexOrientation };
    }
    const base = saved?.["hex_circle"] as { type: "hex_circle"; radius: number; orientation: HexOrientation } | undefined;
    return { type: "hex_circle", radius: base?.radius ?? 8, orientation: hexOrientation };
  }
  if (triangleShape === "rect") {
    const base = saved?.["triangle_rect"] as { type: "triangle_rect"; cols: number; rows: number; orientation: TriOrientation } | undefined;
    return { type: "triangle_rect", cols: base?.cols ?? 10, rows: base?.rows ?? 10, orientation: triOrientation };
  }
  if (triangleShape === "triangle") {
    const base = saved?.["triangle_triangle"] as { type: "triangle_triangle"; side: number; orientation: TriOrientation } | undefined;
    return { type: "triangle_triangle", side: base?.side ?? 12, orientation: triOrientation };
  }
  if (triangleShape === "circle") {
    const base = saved?.["triangle_circle"] as { type: "triangle_circle"; radius: number; orientation: TriOrientation } | undefined;
    return { type: "triangle_circle", radius: base?.radius ?? 10, orientation: triOrientation };
  }
  if (triangleShape === "hexagon") {
    const base = saved?.["triangle_hexagon"] as { type: "triangle_hexagon"; radius: number; orientation: TriOrientation } | undefined;
    return { type: "triangle_hexagon", radius: base?.radius ?? 10, orientation: triOrientation };
  }
  const base = saved?.["triangle_hexagon"] as { type: "triangle_hexagon"; radius: number; orientation: TriOrientation } | undefined;
  return { type: "triangle_hexagon", radius: base?.radius ?? 10, orientation: triOrientation };
}

// Memoized on its own inputs (last-call cache) — `activeTessellationOf` calls this on every
// render while `isEditingField` is true (e.g. `ParamFields`' `useMazeStore` selector), so a fresh
// object per call would fail zustand's reference-equality snapshot check on every render and loop
// forever ("Maximum update depth exceeded" / "getSnapshot should be cached").
let freeConfigCacheKey: string | null = null;
let freeConfigCacheValue: TessellationConfig | null = null;

export function buildFreeConfig(kind: TessellationKind, pts: Set<number>, hexOrientation: HexOrientation, triOrientation: TriOrientation): TessellationConfig {
  const key = `${kind}|${hexOrientation}|${triOrientation}|${Array.from(pts).sort((a, b) => a - b).join(",")}`;
  if (freeConfigCacheKey === key && freeConfigCacheValue) return freeConfigCacheValue;

  const points = Array.from(pts).map(k => decodePoint(k) as [number, number]);
  const config: TessellationConfig = kind === "square"
    ? { type: "square_custom", points }
    : kind === "hex"
      ? ({ type: "hex_custom", points, orientation: hexOrientation } as TessellationConfig)
      : ({ type: "tri_custom", points, orientation: triOrientation } as TessellationConfig);

  freeConfigCacheKey = key;
  freeConfigCacheValue = config;
  return config;
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

/** A fresh FloorFieldConfig for the given (maze-wide) tessellation kind/orientation — the kind's
 * "full" predefined shape (see Specs/field-editor.md's "Default shape per kind" table), no custom
 * points, default mode. Used by floorsSlice's addFloor for a floor with no field config yet. */
export function defaultFloorFieldConfig(kind: TessellationKind, hexOrientation: HexOrientation, triOrientation: TriOrientation): FloorFieldConfig {
  const squareShape: SquareShape = "rect";
  const hexShape: HexShape = kind === "hex" ? "hexagon" : "parallelogram";
  const triangleShape: TriangleShape = kind === "triangle" ? "triangle" : "rect";
  const cfg = buildPredefinedConfig(kind, hexShape, triangleShape, hexOrientation, triOrientation, undefined, squareShape);
  return {
    squareShape, hexShape, triangleShape,
    savedConfigs: { [cfg.type]: cfg },
    tessellationConfig: cfg,
    freeFieldPoints: emptyFreePoints(),
    isEditingField: false,
    fieldPoints: new Set<number>(),
    fieldEditMode: "default",
    fieldPrimitive: "point",
    fieldDirty: false,
  };
}

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
  const tessellationConfig = buildFreeConfig(state.tessellationKind, fieldPoints, state.hexOrientation, state.triOrientation);
  return {
    ...withActiveFloorField(state, { fieldPoints, freeFieldPoints, tessellationConfig, fieldDirty: true }),
    debugStale: debugStaleOf(state),
  };
}

/** Derive any floor's active TessellationConfig, accounting for free-field editing. */
export function floorTessellationOf(state: { tessellationKind: TessellationKind; hexOrientation: HexOrientation; triOrientation: TriOrientation; floorFields: MazeState["floorFields"] }, floorId: string): TessellationConfig {
  const field = state.floorFields[floorId];
  return field.isEditingField
    ? buildFreeConfig(state.tessellationKind, field.fieldPoints, state.hexOrientation, state.triOrientation)
    : field.tessellationConfig;
}

/** Derive the active floor's active TessellationConfig, accounting for free-field editing. */
export function activeFloorTessellationOf(state: { tessellationKind: TessellationKind; hexOrientation: HexOrientation; triOrientation: TriOrientation } & MazeState): TessellationConfig {
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
  };
}

/** Derive kind/shape/orientation/freeFieldPoints/savedConfigs from a TessellationConfig for the
 * active floor — shared by setTessellationConfig and loadProject. */
export function deriveTessellationFromConfig(
  cfg: TessellationConfig,
  currentHexOrientation: HexOrientation,
  currentTriOrientation: TriOrientation,
  currentFreeFieldPoints: Record<TessellationKind, Set<number>>,
  currentSavedConfigs: Partial<Record<TessellationConfig["type"], TessellationConfig>>,
) {
  const { kind, squareShape, hexShape, triangleShape } = kindAndShapeFromConfig(cfg);
  const hexOrientation = (cfg.type === "hex_rectangle" || cfg.type === "hex_circle" || cfg.type === "hex_triangle" || cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon" || cfg.type === "hex_custom")
    ? ((cfg as { orientation?: HexOrientation }).orientation ?? DEFAULT_HEX_ORI)
    : currentHexOrientation;
  const triOrientation = (cfg.type === "triangle_rect" || cfg.type === "triangle_triangle" || cfg.type === "triangle_hexagon" || cfg.type === "triangle_circle" || cfg.type === "tri_custom")
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

/** Shape-setter factory — setSquareShape/setHexShape/setTriangleShape differ only by which shape field changes. Operates on the active floor's own FloorFieldConfig. */
export function makeShapeSetter<K extends "squareShape" | "hexShape" | "triangleShape">(
  fieldKey: K,
  kind: TessellationKind,
) {
  return (shape: SquareShape | HexShape | TriangleShape) => (state: MazeState): Partial<MazeState> => {
    const field = activeFloorField(state);
    if (shape === field[fieldKey]) return {};
    const squareShape = fieldKey === "squareShape" ? (shape as SquareShape) : field.squareShape;
    const hexShape = fieldKey === "hexShape" ? (shape as HexShape) : field.hexShape;
    const triangleShape = fieldKey === "triangleShape" ? (shape as TriangleShape) : field.triangleShape;
    const { isEditingField, fieldPoints } = deriveEditState(state.tessellationKind, squareShape, hexShape, triangleShape, field.freeFieldPoints);
    const cfg = isEditingField
      ? buildFreeConfig(kind, fieldPoints, state.hexOrientation, state.triOrientation)
      : buildPredefinedConfig(kind, hexShape, triangleShape, state.hexOrientation, state.triOrientation, field.savedConfigs, squareShape);
    return {
      ...withActiveFloorField(state, { [fieldKey]: shape, tessellationConfig: cfg, isEditingField, fieldPoints, fieldDirty: true } as Partial<FloorFieldConfig>),
      ...buildResetDownstreamState(),
      error: null,
      debugStale: debugStaleOf(state),
    };
  };
}

/** Orientation-setter factory — setHexOrientation/setTriOrientation differ only by axis kind and
 * field name. Kind/orientation are maze-wide (Specs/field-editor.md), so a rotation rewrites
 * every floor's own tessellationConfig/savedConfigs for the affected kind, not just the active floor's. */
export function makeOrientationSetter(axisKind: "hex" | "triangle", field: "hexOrientation" | "triOrientation") {
  return (orientation: HexOrientation | TriOrientation) => (state: MazeState): Partial<MazeState> => {
    if (orientation === state[field]) return {};
    if (state.tessellationKind !== axisKind) return { ...buildResetDownstreamState(), [field]: orientation } as Partial<MazeState>;
    const floorFields: Record<string, FloorFieldConfig> = {};
    for (const [floorId, f] of Object.entries(state.floorFields)) {
      const tessellationConfig = mergeOrientation(f.tessellationConfig, orientation);
      const { isEditingField } = deriveEditState(state.tessellationKind, f.squareShape, f.hexShape, f.triangleShape, f.freeFieldPoints);
      const savedConfigs = isEditingField ? f.savedConfigs : { ...f.savedConfigs, [tessellationConfig.type]: tessellationConfig };
      floorFields[floorId] = { ...f, tessellationConfig, savedConfigs, fieldDirty: true };
    }
    const activeTessellationConfig = state.nodes.length > 0
      ? mergeOrientation(state.activeTessellationConfig, orientation)
      : state.activeTessellationConfig;
    return {
      [field]: orientation, floorFields, activeTessellationConfig,
      ...buildResetDownstreamState(),
      // A rotation changes which geometric face each offset index means (GitHub issue #235
      // follow-up) — a split-node panel left open across the flip would keep addressing faces
      // that no longer mean what its tile diagram was drawn for. Closing it is the same
      // "point/config just changed under it" rule `confirmTessellation`'s kind-change path
      // already applies to both focused-point fields.
      presetFocusedPoint: null,
      postEditFocusedPoint: null,
      presetSplitTargetPrompt: null,
    } as Partial<MazeState>;
  };
}

export function mergeOrientation(current: TessellationConfig, orientation: HexOrientation | TriOrientation): TessellationConfig {
  return { ...current, orientation } as TessellationConfig;
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
