import type { StateCreator } from "zustand";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { encodePoint } from "../../pixi/tessellationProjection";
import { configAllCells } from "../../pixi/tessellationCells";
import type { MazeStore, FloorFieldsState, FloorFieldsActions } from "../storeTypes";
import {
  buildPredefinedConfig, buildFreeConfig, debugStaleOf,
  withFieldPointsEdit, makeShapeSetter, activeFloorField, withActiveFloorField, deriveTessellationFromConfig,
} from "../storeHelpers";

export const createFloorFieldSlice: StateCreator<MazeStore, [], [], FloorFieldsState & FloorFieldsActions> = (set, get) => ({
  floorFields: {},

  setSquareShape: (shape) => set(makeShapeSetter("squareShape", "square")(shape)),
  setHexShape: (shape) => set(makeShapeSetter("hexShape", "hex")(shape)),
  setTriangleShape: (shape) => set(makeShapeSetter("triangleShape", "triangle")(shape)),

  setTessellationConfig: (cfg: TessellationConfig) => {
    const state = get();
    const field = activeFloorField(state);
    const { kind, squareShape, hexShape, triangleShape, hexOrientation, triOrientation, freeFieldPoints, isEditingField, fieldPoints, savedConfigs } =
      deriveTessellationFromConfig(cfg, state.hexOrientation, state.triOrientation, field.freeFieldPoints, field.savedConfigs);
    set({
      tessellationKind: kind, hexOrientation, triOrientation,
      ...withActiveFloorField(state, { squareShape, hexShape, triangleShape, tessellationConfig: cfg, freeFieldPoints, isEditingField, fieldPoints, savedConfigs, fieldDirty: true }),
      error: null, debugStale: debugStaleOf(state),
    });
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

  setFieldEditMode: (mode) => set((state) => {
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
        debugStale: debugStaleOf(state),
      };
    }
    const cfg = buildPredefinedConfig(state.tessellationKind, field.hexShape, field.triangleShape, state.hexOrientation, state.triOrientation, field.savedConfigs);
    return {
      ...withActiveFloorField(state, { fieldEditMode: mode, isEditingField: false, tessellationConfig: cfg, fieldPrimitive: "point", fieldDirty: true }),
      debugStale: debugStaleOf(state),
    };
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

  setFieldPrimitive: (p) => set((state) => withActiveFloorField(state, { fieldPrimitive: p })),

  copyFloorField: (sourceFloorId) => set((state) => {
    const source = state.floorFields[sourceFloorId];
    if (!source) return {};
    return {
      ...withActiveFloorField(state, { ...source, fieldDirty: true }),
      debugStale: debugStaleOf(state),
    };
  }),
});
