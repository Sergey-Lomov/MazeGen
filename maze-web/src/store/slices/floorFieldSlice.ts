import type { StateCreator } from "zustand";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { encodePoint } from "../../pixi/tessellationProjection";
import { configAllCells } from "../../pixi/tessellationCells";
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

export const createFloorFieldSlice: StateCreator<MazeStore, [], [], FloorFieldsState & FloorFieldsActions> = (set, get) => ({
  floorFields: {},
  fieldEditConfirmation: null,

  setSquareShape: (shape) => set((state) => guardFieldEdit(state, { kind: "setSquareShape", shape }, () => makeShapeSetter("squareShape", "square")(shape)(state))),
  setHexShape: (shape) => set((state) => guardFieldEdit(state, { kind: "setHexShape", shape }, () => makeShapeSetter("hexShape", "hex")(shape)(state))),
  setTriangleShape: (shape) => set((state) => guardFieldEdit(state, { kind: "setTriangleShape", shape }, () => makeShapeSetter("triangleShape", "triangle")(shape)(state))),

  setTessellationConfig: (cfg: TessellationConfig) => {
    const state = get();
    if (state.mazeDirty || state.postEditDirty) {
      set({ fieldEditConfirmation: { kind: "setTessellationConfig", config: cfg } });
      return;
    }
    const field = activeFloorField(state);
    const { kind, squareShape, hexShape, triangleShape, hexOrientation, triOrientation, freeFieldPoints, isEditingField, fieldPoints, savedConfigs } =
      deriveTessellationFromConfig(cfg, state.hexOrientation, state.triOrientation, field.freeFieldPoints, field.savedConfigs);
    set({
      tessellationKind: kind, hexOrientation, triOrientation,
      ...withActiveFloorField(state, { squareShape, hexShape, triangleShape, tessellationConfig: cfg, freeFieldPoints, isEditingField, fieldPoints, savedConfigs, fieldDirty: true }),
      ...buildResetDownstreamState(),
      error: null, debugStale: debugStaleOf(state),
    });
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
    const cfg = buildPredefinedConfig(state.tessellationKind, field.hexShape, field.triangleShape, state.hexOrientation, state.triOrientation, field.savedConfigs);
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

  setFieldPrimitive: (p) => set((state) => withActiveFloorField(state, { fieldPrimitive: p })),

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
      case "addFieldPoint": get().addFieldPoint(pending.x, pending.y); break;
      case "removeFieldPoint": get().removeFieldPoint(pending.x, pending.y); break;
      case "addFieldPoints": get().addFieldPoints(pending.cells); break;
      case "removeFieldPoints": get().removeFieldPoints(pending.cells); break;
      case "clearFieldPoints": get().clearFieldPoints(); break;
      case "setFieldEditMode": get().setFieldEditMode(pending.mode); break;
      case "copyFloorField": get().copyFloorField(pending.sourceFloorId); break;
    }
  },

  cancelFieldEdit: () => set({ fieldEditConfirmation: null }),
});
