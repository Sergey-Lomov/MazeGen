import type { StateCreator } from "zustand";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { encodePoint } from "../../pixi/tessellationProjection";
import { configAllCells } from "../../pixi/tessellationCells";
import type { PresetConnectionEntry } from "../../pixi/presetConnectionsUtils";
import type { NodeLockKind } from "../../wasm/types";
import type { MazeStore, TessellationState, TessellationActions, SquareShape, HexShape, TriangleShape } from "../storeTypes";
import { DEFAULT_HEX_ORI, DEFAULT_TRI_ORI } from "../storeTypes";
import {
  buildPredefinedConfig, buildFreeConfig, buildPreviewState, emptyFreePoints, deriveEditState,
  debugStaleOf, withFieldPointsEdit, buildResetMazeState, deriveTessellationFromConfig,
  makeShapeSetter, makeOrientationSetter,
} from "../storeHelpers";

export const createTessellationSlice: StateCreator<MazeStore, [], [], TessellationState & TessellationActions> = (set, get) => ({
  seed: 42,
  tessellationKind: "square",
  hexOrientation: DEFAULT_HEX_ORI,
  triOrientation: DEFAULT_TRI_ORI,
  tessellationConfirmed: false,
  previewKind: "square",
  previewHexOrientation: DEFAULT_HEX_ORI,
  previewTriOrientation: DEFAULT_TRI_ORI,
  previewTessellationConfig: { type: "square", width: 11, height: 11 },
  squareShape: "rect",
  hexShape: "hexagon",
  triangleShape: "triangle",
  savedConfigs: {},
  tessellationConfig: { type: "square", width: 11, height: 11 },
  activeTessellationConfig: { type: "square", width: 11, height: 11 },
  freeFieldPoints: emptyFreePoints(),
  isEditingField: false,
  fieldPoints: new Set<number>(),
  showFieldOverlay: true,
  fieldEditMode: "default",
  fieldPrimitive: "point",
  showFieldOrigin: true,
  fieldDirty: false,

  setSeed: (seed) => set({ seed, error: null }),

  setPreviewKind: (kind) => set((state) => ({
    previewKind: kind,
    previewTessellationConfig: buildPreviewState(kind, state.previewHexOrientation, state.previewTriOrientation).previewTessellationConfig,
  })),

  setPreviewHexOrientation: (orientation) => set((state) => ({
    previewHexOrientation: orientation,
    previewTessellationConfig: buildPreviewState(state.previewKind, orientation, state.previewTriOrientation).previewTessellationConfig,
  })),

  setPreviewTriOrientation: (orientation) => set((state) => ({
    previewTriOrientation: orientation,
    previewTessellationConfig: buildPreviewState(state.previewKind, state.previewHexOrientation, orientation).previewTessellationConfig,
  })),

  syncPreviewToConfirmed: () => set((state) =>
    buildPreviewState(state.tessellationKind, state.hexOrientation, state.triOrientation)
  ),

  confirmTessellation: () => set((state) => {
    const kind = state.previewKind;
    const hexOrientation = state.previewHexOrientation;
    const triOrientation = state.previewTriOrientation;
    const squareShape: SquareShape = "rect";
    const hexShape: HexShape = kind === "hex" ? "hexagon" : "parallelogram";
    const triangleShape: TriangleShape = kind === "triangle" ? "triangle" : "rect";
    const cfg = buildPredefinedConfig(kind, hexShape, triangleShape, hexOrientation, triOrientation, state.savedConfigs);
    const savedConfigs = { ...state.savedConfigs, [cfg.type]: cfg };
    const freeFieldPoints = kind !== state.tessellationKind
      ? { ...state.freeFieldPoints, [kind]: new Set<number>() }
      : state.freeFieldPoints;
    const { isEditingField, fieldPoints } = deriveEditState(kind, squareShape, hexShape, triangleShape, freeFieldPoints);
    const clearMaze = kind !== state.tessellationKind;
    return {
      tessellationKind: kind,
      hexOrientation,
      triOrientation,
      tessellationConfirmed: true,
      ...buildPreviewState(kind, hexOrientation, triOrientation),
      squareShape,
      hexShape,
      triangleShape,
      tessellationConfig: cfg,
      savedConfigs,
      freeFieldPoints,
      isEditingField,
      fieldPoints,
      ...(clearMaze ? {
        ...buildResetMazeState(),
        error: null,
        presetConnections: new Map<string, PresetConnectionEntry>(),
        lockedNodes: new Map<string, NodeLockKind>(),
        autoLockedNodes: new Set<string>(),
        presetStart: null,
        presetFinish: null,
        presetGenSource: null,
        defaultEdgeState: "undefined" as const,
        fieldEditMode: "default" as const,
        debugSnapshot: null, debugStep: 0, debugStale: false,
      } : { debugStale: debugStaleOf(state) }),
      fieldDirty: false,
      presetsDirty: false,
      mazeDirty: false,
      postEditDirty: false,
    };
  }),

  setTessellationKind: (kind) => set((state) => {
    if (kind === state.tessellationKind) return {};
    const squareShape: SquareShape = "rect";
    const hexShape: HexShape = kind === "hex" ? "hexagon" : "parallelogram";
    const triangleShape: TriangleShape = kind === "triangle" ? "triangle" : "rect";
    const cfg = buildPredefinedConfig(kind, hexShape, triangleShape, state.hexOrientation, state.triOrientation, state.savedConfigs);
    const freeFieldPoints = { ...state.freeFieldPoints, [kind]: new Set<number>() };
    const { isEditingField, fieldPoints } = deriveEditState(kind, squareShape, hexShape, triangleShape, freeFieldPoints);
    return {
      tessellationKind: kind, squareShape, hexShape, triangleShape,
      tessellationConfig: cfg, isEditingField, fieldPoints, freeFieldPoints,
      ...buildResetMazeState(),
      error: null,
      debugSnapshot: null, debugStep: 0, debugStale: false,
    };
  }),

  setSquareShape: (shape) => set(makeShapeSetter("squareShape", "square")(shape)),
  setHexShape: (shape) => set(makeShapeSetter("hexShape", "hex")(shape)),
  setTriangleShape: (shape) => set(makeShapeSetter("triangleShape", "triangle")(shape)),

  setHexOrientation: (orientation) => set(makeOrientationSetter("hex", "hexOrientation")(orientation)),
  setTriOrientation: (orientation) => set(makeOrientationSetter("triangle", "triOrientation")(orientation)),

  setTessellationConfig: (cfg: TessellationConfig) => {
    const state = get();
    const { kind, squareShape, hexShape, triangleShape, hexOrientation, triOrientation, freeFieldPoints, isEditingField, fieldPoints, savedConfigs } =
      deriveTessellationFromConfig(cfg, state.hexOrientation, state.triOrientation, state.freeFieldPoints, state.savedConfigs);
    set({ tessellationConfig: cfg, tessellationKind: kind, squareShape, hexShape, triangleShape, hexOrientation, triOrientation, freeFieldPoints, isEditingField, fieldPoints, savedConfigs, fieldDirty: true, error: null, debugStale: debugStaleOf(state) });
  },

  addFieldPoint: (x, y) => set((state) => withFieldPointsEdit(state, (pts) => {
    const key = encodePoint(x, y);
    if (pts.has(key)) return false;
    pts.add(key);
    return true;
  })),

  removeFieldPoint: (x, y) => set((state) => withFieldPointsEdit(state, (pts) => {
    const key = encodePoint(x, y);
    if (!pts.has(key)) return false;
    pts.delete(key);
    return true;
  })),

  setShowFieldOverlay: (show) => set({ showFieldOverlay: show }),

  setFieldEditMode: (mode) => set((state) => {
    if (mode === "custom") {
      const cfg = state.tessellationConfig;
      const isAlreadyCustom = cfg.type === "square_custom" || cfg.type === "hex_custom" || cfg.type === "tri_custom";
      let fieldPoints: Set<number>;
      if (isAlreadyCustom) {
        fieldPoints = state.freeFieldPoints[state.tessellationKind];
      } else {
        const cells = configAllCells(cfg);
        fieldPoints = new Set(cells.map(([x, y]) => encodePoint(x, y)));
      }
      const freeFieldPoints = { ...state.freeFieldPoints, [state.tessellationKind]: fieldPoints };
      const tessellationConfig = isAlreadyCustom ? cfg : buildFreeConfig(state.tessellationKind, fieldPoints, state.hexOrientation, state.triOrientation);
      return { fieldEditMode: mode, isEditingField: true, fieldPoints, freeFieldPoints, tessellationConfig, fieldPrimitive: "point", fieldDirty: true, debugStale: debugStaleOf(state) };
    }
    const cfg = buildPredefinedConfig(state.tessellationKind, state.hexShape, state.triangleShape, state.hexOrientation, state.triOrientation, state.savedConfigs);
    return { fieldEditMode: mode, isEditingField: false, tessellationConfig: cfg, fieldPrimitive: "point", fieldDirty: true, debugStale: debugStaleOf(state) };
  }),

  addFieldPoints: (cells) => set((state) => withFieldPointsEdit(state, (pts) => {
    let changed = false;
    for (const [x, y] of cells) {
      const key = encodePoint(x, y);
      if (!pts.has(key)) { pts.add(key); changed = true; }
    }
    return changed;
  })),

  removeFieldPoints: (cells) => set((state) => withFieldPointsEdit(state, (pts) => {
    let changed = false;
    for (const [x, y] of cells) {
      const key = encodePoint(x, y);
      if (pts.has(key)) { pts.delete(key); changed = true; }
    }
    return changed;
  })),

  clearFieldPoints: () => set((state) => withFieldPointsEdit(state, (pts) => {
    if (pts.size === 0) return false;
    pts.clear();
    return true;
  })),

  setFieldPrimitive: (p) => set({ fieldPrimitive: p }),
  setShowFieldOrigin: (show) => set({ showFieldOrigin: show }),
});
