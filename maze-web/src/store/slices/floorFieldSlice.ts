import type { StateCreator } from "zustand";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { decodePoint, encodePoint } from "../../pixi/tessellationProjection";
import { configAllCells } from "../../pixi/tessellationCells";
import { computeSymmetryPreview, symmetryCandidateCells } from "../../pixi/symmetry";
import type { MazeStore, MazeState, FloorFieldsState, FloorFieldsActions, PendingFieldEdit } from "../storeTypes";
import {
  buildPredefinedConfig, buildFreeConfig, debugStaleOf,
  withFieldPointsEdit, makeShapeSetter, activeFloorField, withActiveFloorField, deriveTessellationFromConfig,
  buildResetDownstreamState,
} from "../storeHelpers";

function invalidateIfChanged(patch: Partial<import("../storeTypes").MazeState>) {
  return Object.keys(patch).length === 0 ? {} : { ...patch, ...buildResetDownstreamState() };
}

function guardFieldEdit(state: MazeState, pending: PendingFieldEdit, apply: () => Partial<MazeState>) {
  return state.mazeDirty || state.postEditDirty
    ? { fieldEditConfirmation: pending }
    : apply();
}

function applyTessellationConfigsForFloors(state: MazeState, configs: Record<string, TessellationConfig>, applyToAllStandardFloors: boolean): Partial<MazeState> {
  const targetIds = applyToAllStandardFloors
    ? state.floors.filter((floor) => state.floorFields[floor.id].fieldEditMode !== "custom").map((floor) => floor.id)
    : [state.activeFloorId];
  const targetIdSet = new Set(targetIds);
  const floorFields = { ...state.floorFields };
  let derivedForActive: ReturnType<typeof deriveTessellationFromConfig> | null = null;

  for (const floor of state.floors) {
    const field = state.floorFields[floor.id];
    if (!targetIdSet.has(floor.id)) continue;
    const cfg = configs[floor.id];
    if (!cfg) continue;
    const derived = deriveTessellationFromConfig(
      cfg,
      state.hexOrientation,
      state.triOrientation,
      field.freeFieldPoints,
      field.savedConfigs,
    );
    floorFields[floor.id] = {
      ...field,
      squareShape: derived.squareShape,
      hexShape: derived.hexShape,
      triangleShape: derived.triangleShape,
      savedConfigs: derived.savedConfigs,
      tessellationConfig: cfg,
      freeFieldPoints: derived.freeFieldPoints,
      isEditingField: derived.isEditingField,
      fieldPoints: derived.fieldPoints,
      fieldDirty: true,
    };
    if (floor.id === state.activeFloorId) derivedForActive = derived;
  }

  if (!derivedForActive) return {};
  return {
    tessellationKind: derivedForActive.kind,
    hexOrientation: derivedForActive.hexOrientation,
    triOrientation: derivedForActive.triOrientation,
    floorFields,
    ...buildResetDownstreamState(),
    error: null,
    debugStale: debugStaleOf(state),
  };
}

function applyTessellationConfigForFloors(state: MazeState, cfg: TessellationConfig, applyToAllStandardFloors: boolean): Partial<MazeState> {
  const configs = Object.fromEntries(state.floors.map((floor) => [floor.id, cfg]));
  return applyTessellationConfigsForFloors(state, configs, applyToAllStandardFloors);
}

export const createFloorFieldSlice: StateCreator<MazeStore, [], [], FloorFieldsState & FloorFieldsActions> = (set, get) => ({
  floorFields: {},
  fieldEditConfirmation: null,

  setSquareShape: (shape) => set((state) => guardFieldEdit(state, { kind: "setSquareShape", shape }, () => makeShapeSetter("squareShape", "square")(shape)(state))),
  setHexShape: (shape) => set((state) => guardFieldEdit(state, { kind: "setHexShape", shape }, () => makeShapeSetter("hexShape", "hex")(shape)(state))),
  setTriangleShape: (shape) => set((state) => guardFieldEdit(state, { kind: "setTriangleShape", shape }, () => makeShapeSetter("triangleShape", "triangle")(shape)(state))),

  setTessellationConfig: (cfg: TessellationConfig) => {
    get().setTessellationConfigForFloors(cfg, false);
  },

  setTessellationConfigForFloors: (cfg: TessellationConfig, applyToAllStandardFloors: boolean) => {
    const state = get();
    if (state.mazeDirty || state.postEditDirty) {
      set({ fieldEditConfirmation: { kind: "setTessellationConfigForFloors", config: cfg, applyToAllStandardFloors } });
      return;
    }
    set(applyTessellationConfigForFloors(state, cfg, applyToAllStandardFloors));
  },

  setTessellationConfigsForFloors: (configs, applyToAllStandardFloors) => {
    const state = get();
    if (state.mazeDirty || state.postEditDirty) {
      set({ fieldEditConfirmation: { kind: "setTessellationConfigsForFloors", configs, applyToAllStandardFloors } });
      return;
    }
    set(applyTessellationConfigsForFloors(state, configs, applyToAllStandardFloors));
  },

  addFieldPoint: (x, y) => set((state) => guardFieldEdit(state, { kind: "addFieldPoint", x, y }, () => withFieldPointsEdit(state, (pts) => {
    const key = encodePoint(x, y);
    if (pts.has(key)) return false;
    pts.add(key);
    return true;
  }))),

  removeFieldPoint: (x, y) => set((state) => guardFieldEdit(state, { kind: "removeFieldPoint", x, y }, () => withFieldPointsEdit(state, (pts) => {
    const key = encodePoint(x, y);
    if (!pts.has(key)) return false;
    pts.delete(key);
    return true;
  }))),

  setFieldEditMode: (mode) => set((state) => {
    if (state.mazeDirty || state.postEditDirty) return { fieldEditConfirmation: { kind: "setFieldEditMode", mode } };
    const field = activeFloorField(state);
    if (mode === "custom") {
      const cfg = field.tessellationConfig;
      const isAlreadyCustom = cfg.type === "square_custom" || cfg.type === "hex_custom" || cfg.type === "tri_custom";
      let fieldPoints: Set<number>;
      if (isAlreadyCustom) {
        fieldPoints = field.freeFieldPoints[state.tessellationKind];
      } else {
        const cells = configAllCells(cfg);
        fieldPoints = new Set(cells.map(([x, y]) => encodePoint(x, y)));
      }
      const freeFieldPoints = { ...field.freeFieldPoints, [state.tessellationKind]: fieldPoints };
      const tessellationConfig = isAlreadyCustom ? cfg : buildFreeConfig(state.tessellationKind, fieldPoints, state.hexOrientation, state.triOrientation);
      return {
        ...withActiveFloorField(state, { fieldEditMode: mode, isEditingField: true, fieldPoints, freeFieldPoints, tessellationConfig, fieldPrimitive: "point", fieldDirty: true }),
        ...buildResetDownstreamState(),
        debugStale: debugStaleOf(state),
      };
    }
    const cfg = buildPredefinedConfig(state.tessellationKind, field.hexShape, field.triangleShape, state.hexOrientation, state.triOrientation, field.savedConfigs, field.squareShape);
    return {
      ...withActiveFloorField(state, { fieldEditMode: mode, isEditingField: false, tessellationConfig: cfg, fieldPrimitive: "point", fieldDirty: true }),
      ...buildResetDownstreamState(),
      debugStale: debugStaleOf(state),
    };
  }),

  addFieldPoints: (cells) => set((state) => guardFieldEdit(state, { kind: "addFieldPoints", cells }, () => invalidateIfChanged(withFieldPointsEdit(state, (pts) => {
    let changed = false;
    for (const [x, y] of cells) {
      const key = encodePoint(x, y);
      if (!pts.has(key)) { pts.add(key); changed = true; }
    }
    return changed;
  })))),

  removeFieldPoints: (cells) => set((state) => guardFieldEdit(state, { kind: "removeFieldPoints", cells }, () => invalidateIfChanged(withFieldPointsEdit(state, (pts) => {
    let changed = false;
    for (const [x, y] of cells) {
      const key = encodePoint(x, y);
      if (pts.has(key)) { pts.delete(key); changed = true; }
    }
    return changed;
  })))),

  clearFieldPoints: () => set((state) => guardFieldEdit(state, { kind: "clearFieldPoints" }, () => invalidateIfChanged(withFieldPointsEdit(state, (pts) => {
    if (pts.size === 0) return false;
    pts.clear();
    return true;
  })))),

  setFieldPrimitive: (p) => set((state) => ({
    ...withActiveFloorField(state, { fieldPrimitive: p }),
    ...(p === "symmetry"
      ? {}
      : { symmetryAxisPoints: [], symmetryPolygon: [], symmetryPolygonFinished: false }),
  })),

  setPolygonOperation: (operation) => set((state) => withActiveFloorField(state, { polygonOperation: operation })),

  applySymmetry: () => set((state) => guardFieldEdit(state, { kind: "applySymmetry" }, () => {
    const field = activeFloorField(state);
    const axis = state.symmetryAxisPoints;
    if (field.fieldEditMode !== "custom" || axis.length !== 2
      || (axis[0].x === axis[1].x && axis[0].y === axis[1].y)) return {};
    if (state.symmetryScope === "polygon"
      && (state.symmetryPolygon.length < 3 || !state.symmetryPolygonFinished)) return {};
    const preview = computeSymmetryPreview(
      field.fieldPoints,
      symmetryCandidateCells(field.fieldPoints, field.tessellationConfig, axis, decodePoint),
      field.tessellationConfig,
      {
        scope: state.symmetryScope,
        sourceSide: state.symmetrySourceSide,
        axis: [axis[0], axis[1]],
        polygon: state.symmetryPolygon,
      },
      encodePoint,
    );
    const fieldPointsPatch = withFieldPointsEdit(state, (points) => {
      let changed = false;
      for (const [x, y] of preview.mirroredCells) {
        const key = encodePoint(x, y);
        if (state.symmetryOperation === "add" && !points.has(key)) {
          points.add(key);
          changed = true;
        } else if (state.symmetryOperation === "subtract" && points.delete(key)) {
          changed = true;
        }
      }
      return changed;
    });
    const nextFloorFields = fieldPointsPatch.floorFields ?? state.floorFields;
    return {
      ...invalidateIfChanged(fieldPointsPatch),
      floorFields: {
        ...nextFloorFields,
        [state.activeFloorId]: {
          ...nextFloorFields[state.activeFloorId],
          fieldPrimitive: "point",
        },
      },
      symmetryAxisPoints: [],
      symmetryPolygon: [],
      symmetryPolygonFinished: false,
    };
  })),

  copyFloorField: (sourceFloorId) => set((state) => {
    const source = state.floorFields[sourceFloorId];
    if (!source) return {};
    if (state.mazeDirty || state.postEditDirty) return { fieldEditConfirmation: { kind: "copyFloorField", sourceFloorId } };
    return {
      ...withActiveFloorField(state, { ...source, fieldDirty: true }),
      ...buildResetDownstreamState(),
      debugStale: debugStaleOf(state),
    };
  }),

  confirmFieldEdit: () => {
    const pending = get().fieldEditConfirmation;
    if (!pending) return;
    set(buildResetDownstreamState());
    switch (pending.kind) {
      case "setSquareShape": get().setSquareShape(pending.shape); break;
      case "setHexShape": get().setHexShape(pending.shape); break;
      case "setTriangleShape": get().setTriangleShape(pending.shape); break;
      case "setTessellationConfig": get().setTessellationConfig(pending.config); break;
      case "setTessellationConfigForFloors": get().setTessellationConfigForFloors(pending.config, pending.applyToAllStandardFloors); break;
      case "setTessellationConfigsForFloors": get().setTessellationConfigsForFloors(pending.configs, pending.applyToAllStandardFloors); break;
      case "addFieldPoint": get().addFieldPoint(pending.x, pending.y); break;
      case "removeFieldPoint": get().removeFieldPoint(pending.x, pending.y); break;
      case "addFieldPoints": get().addFieldPoints(pending.cells); break;
      case "removeFieldPoints": get().removeFieldPoints(pending.cells); break;
      case "clearFieldPoints": get().clearFieldPoints(); break;
      case "setFieldEditMode": get().setFieldEditMode(pending.mode); break;
      case "applySymmetry": get().applySymmetry(); break;
      case "copyFloorField": get().copyFloorField(pending.sourceFloorId); break;
    }
  },

  cancelFieldEdit: () => set({ fieldEditConfirmation: null }),
});
