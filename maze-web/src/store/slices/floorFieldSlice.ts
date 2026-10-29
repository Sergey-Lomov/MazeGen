import type { StateCreator } from "zustand";
import type { FieldConfig } from "../../fieldConfig";
import { decodePoint, encodePoint } from "../../pixi/tessellationProjection";
import { configAllCells } from "../../pixi/tessellationCells";
import { getCartesian } from "../../pixi/cartesianCache";
import { TESSELLATION_UI } from "../../pixi/geometry/tessellationUi";
import { isFieldOpError } from "../../pixi/fieldOps";
import { translateFieldCells } from "../../wasm/mazeService";
import { computeSymmetryPreview } from "../../pixi/symmetry";
import { tessellationFingerprint } from "../topologyWire";
import type { MazeStore, MazeState, FloorFieldConfig, FloorFieldsState, FloorFieldsActions, PendingFieldEdit } from "../storeTypes";
import {
  buildPredefinedConfig, buildFreeConfig, debugStaleOf, tessellationOf,
  withFieldPointsEdit, setSelectedShapeState, activeFloorField, withActiveFloorField, deriveTessellationFromConfig,
  buildResetDownstreamState, withoutFloorTopology,
} from "../storeHelpers";

function invalidateIfChanged(patch: Partial<import("../storeTypes").MazeState>) {
  return Object.keys(patch).length === 0 ? {} : { ...patch, ...buildResetDownstreamState() };
}

function cloneFloorField(field: FloorFieldConfig): FloorFieldConfig {
  return structuredClone(field);
}

// Topology values are immutable wire data, so targets share the source's object. A source without
// a topology clears the targets' (the copy must not keep stale seams of the replaced field).
function topologyCopiedTo(
  floorTopology: MazeState["floorTopology"],
  sourceFloorId: string,
  targetIds: string[],
): MazeState["floorTopology"] {
  const next = { ...floorTopology };
  const source = floorTopology[sourceFloorId];
  for (const id of targetIds) {
    if (source) next[id] = source;
    else delete next[id];
  }
  return next;
}

function guardFieldEdit(state: MazeState, pending: PendingFieldEdit, apply: () => Partial<MazeState>) {
  // Auto-fill preview is read-only: the canvas renders the candidate set instead of the stored
  // field, so accepting edits here would make them invisible and resurrect them when preview is
  // cancelled. The preview's Confirm action uses applyBackgroundAutoFill, not this guard.
  if (state.backgroundAutoFillPreview !== null) return {};
  return state.mazeDirty || state.postEditDirty
    ? { fieldEditConfirmation: pending }
    : apply();
}

function applyFieldConfigsForFloors(state: MazeState, configs: Record<string, FieldConfig>, applyToAllStandardFloors: boolean): Partial<MazeState> {
  const targetIds = applyToAllStandardFloors
    ? state.floors.filter((floor) => state.floorFields[floor.id].fieldEditMode !== "custom").map((floor) => floor.id)
    : [state.activeFloorId];
  const targetIdSet = new Set(targetIds);
  const floorFields = { ...state.floorFields };
  const leftCustomIds: string[] = [];
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
      field.savedShapes,
      field.selectedShape,
    );
    floorFields[floor.id] = {
      ...field,
      selectedShape: derived.selectedShape,
      savedShapes: derived.savedShapes,
      fieldConfig: cfg,
      freeFieldPoints: derived.freeFieldPoints,
      isEditingField: derived.isEditingField,
      fieldPoints: derived.fieldPoints,
      fieldDirty: true,
    };
    if (field.isEditingField && !derived.isEditingField) leftCustomIds.push(floor.id);
    if (floor.id === state.activeFloorId) derivedForActive = derived;
  }

  if (!derivedForActive) return {};
  // A topology is authored for one tessellation config (GitHub issue #836): a config change
  // invalidates every floor's folds. A field change keeps them; each fold's activity is recomputed
  // against the new cell set (GitHub issue #839) and the user is told when one goes inactive.
  const configChanged =
    tessellationFingerprint(derivedForActive.kind, derivedForActive.params) !==
    tessellationFingerprint(state.tessellationKind, state.tessellationParams);
  return {
    floorTopology: configChanged ? {} : withoutFloorTopology(state.floorTopology, leftCustomIds),
    tessellationKind: derivedForActive.kind,
    tessellationParams: derivedForActive.params,
    hexOrientation: derivedForActive.hexOrientation,
    triOrientation: derivedForActive.triOrientation,
    floorFields,
    ...buildResetDownstreamState(),
    error: null,
    debugStale: debugStaleOf(state),
  };
}

function applyFieldConfigForFloors(state: MazeState, cfg: FieldConfig, applyToAllStandardFloors: boolean): Partial<MazeState> {
  const configs = Object.fromEntries(state.floors.map((floor) => [floor.id, cfg]));
  return applyFieldConfigsForFloors(state, configs, applyToAllStandardFloors);
}

export const createFloorFieldSlice: StateCreator<MazeStore, [], [], FloorFieldsState & FloorFieldsActions> = (set, get) => ({
  floorFields: {},
  fieldEditConfirmation: null,

  setSelectedShape: (shape) => set((state) => guardFieldEdit(state, { kind: "setSelectedShape", shape }, () => setSelectedShapeState(shape)(state))),

  setFieldConfig: (cfg: FieldConfig) => {
    get().setFieldConfigForFloors(cfg, false);
  },

  setFieldConfigForFloors: (cfg: FieldConfig, applyToAllStandardFloors: boolean) => {
    const state = get();
    if (state.backgroundAutoFillPreview !== null) return;
    if (state.mazeDirty || state.postEditDirty) {
      set({ fieldEditConfirmation: { kind: "setFieldConfigForFloors", config: cfg, applyToAllStandardFloors } });
      return;
    }
    set(applyFieldConfigForFloors(state, cfg, applyToAllStandardFloors));
  },

  setFieldConfigsForFloors: (configs, applyToAllStandardFloors) => {
    const state = get();
    if (state.backgroundAutoFillPreview !== null) return;
    if (state.mazeDirty || state.postEditDirty) {
      set({ fieldEditConfirmation: { kind: "setFieldConfigsForFloors", configs, applyToAllStandardFloors } });
      return;
    }
    set(applyFieldConfigsForFloors(state, configs, applyToAllStandardFloors));
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
    if (state.backgroundAutoFillPreview !== null) return {};
    if (state.mazeDirty || state.postEditDirty) return { fieldEditConfirmation: { kind: "setFieldEditMode", mode } };
    const field = activeFloorField(state);
    if (mode === "custom") {
      const cfg = field.fieldConfig;
      const isAlreadyCustom = cfg.shape.shape === "custom";
      let fieldPoints: Set<number>;
      if (isAlreadyCustom) {
        fieldPoints = field.freeFieldPoints[state.tessellationKind];
      } else {
        const cells = configAllCells(cfg, state.smoothPrimitives);
        fieldPoints = new Set(cells.map(([x, y]) => encodePoint(x, y)));
      }
      const freeFieldPoints = { ...field.freeFieldPoints, [state.tessellationKind]: fieldPoints };
      const fieldConfig = isAlreadyCustom ? cfg : buildFreeConfig(tessellationOf(state), fieldPoints, state.hexOrientation, state.triOrientation);
      return {
        ...withActiveFloorField(state, { fieldEditMode: mode, isEditingField: true, fieldPoints, freeFieldPoints, fieldConfig, fieldPrimitive: "point", fieldDirty: true }),
        ...buildResetDownstreamState(),
        backgroundAutoFillPreview: null,
        debugStale: debugStaleOf(state),
      };
    }
    const cfg = buildPredefinedConfig(tessellationOf(state), field.selectedShape, state.hexOrientation, state.triOrientation, field.savedShapes);
    return {
      ...withActiveFloorField(state, { fieldEditMode: mode, isEditingField: false, fieldConfig: cfg, fieldPrimitive: "point", fieldDirty: true }),
      ...(field.isEditingField ? { floorTopology: withoutFloorTopology(state.floorTopology, [state.activeFloorId]) } : {}),
      ...buildResetDownstreamState(),
      backgroundAutoFillPreview: null,
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

  moveFieldPoints: (cells, vector) => set((state) => guardFieldEdit(state, { kind: "moveFieldPoints", cells, vector }, () => {
    if (vector[0] === 0 && vector[1] === 0) return {};
    const field = activeFloorField(state);
    const selected = cells.filter(([x, y]) => field.fieldPoints.has(encodePoint(x, y)));
    if (selected.length === 0) return {};

    let moved: [number, number][];
    try {
      moved = translateFieldCells(field.fieldConfig.tessellation, selected, vector);
    } catch (error) {
      // A refused move leaves the field unchanged.
      if (!isFieldOpError(error)) throw error;
      return {};
    }
    return {
      ...invalidateIfChanged(withFieldPointsEdit(state, (points) => {
        for (const [x, y] of selected) points.delete(encodePoint(x, y));
        for (const [x, y] of moved) points.add(encodePoint(x, y));
        return true;
      })),
    };
  })),

  centerFieldPoints: () => set((state) => guardFieldEdit(state, { kind: "centerFieldPoints" }, () => {
    const field = activeFloorField(state);
    const cells = [...field.fieldPoints].map(decodePoint);
    if (cells.length === 0) return {};

    const centers = cells.map((cell) => getCartesian(cell[0], cell[1], field.fieldConfig));
    const visualCenter: [number, number] = [
      (Math.min(...centers.map(([x]) => x)) + Math.max(...centers.map(([x]) => x))) / 2,
      (Math.min(...centers.map(([, y]) => y)) + Math.max(...centers.map(([, y]) => y))) / 2,
    ];

    // The editor registry provides a valid cell at the visual grid origin. This avoids the
    // arbitrary boundary tie-break that a spatial point query would make at `(0, 0)`.
    const originCell = TESSELLATION_UI[field.fieldConfig.tessellation.kind].originCell;
    const origin = getCartesian(originCell[0], originCell[1], field.fieldConfig);
    const candidates = cells.map((_, index) => ({
      center: centers[index],
      distance: (centers[index][0] - visualCenter[0]) ** 2 + (centers[index][1] - visualCenter[1]) ** 2,
    })).sort((a, b) => a.distance - b.distance);

    for (const candidate of candidates) {
      const vector: [number, number] = [origin[0] - candidate.center[0], origin[1] - candidate.center[1]];
      try {
        const moved = translateFieldCells(field.fieldConfig.tessellation, cells, vector);
        const movedPoints = new Set(moved.map(([x, y]) => encodePoint(x, y)));
        if (movedPoints.size === field.fieldPoints.size
          && [...movedPoints].every((point) => field.fieldPoints.has(point))) return {};
        return invalidateIfChanged(withFieldPointsEdit(state, (points) => {
          points.clear();
          for (const point of movedPoints) points.add(point);
          return true;
        }));
      } catch (error) {
        if (!isFieldOpError(error)) throw error;
      }
    }
    return {};
  })),

  clearFieldPoints: () => set((state) => guardFieldEdit(state, { kind: "clearFieldPoints" }, () => invalidateIfChanged(withFieldPointsEdit(state, (pts) => {
    if (pts.size === 0) return false;
    pts.clear();
    return true;
  })))),

  setFieldOperation: (operation) => set((state) => {
    if (state.backgroundAutoFillPreview !== null) return {};
    const field = activeFloorField(state);
    const enteringSelect = operation === "select" && field.fieldOperation !== "select";
    return {
      ...withActiveFloorField(state, {
        fieldOperation: operation,
        ...(enteringSelect ? { fieldPrimitive: "rectangle" } : {}),
      }),
      ...(enteringSelect && field.fieldPrimitive === "symmetry"
        ? { symmetryAxisPoints: [], symmetryPolygon: [], symmetryPolygonFinished: false }
        : {}),
    };
  }),

  setFieldPrimitive: (p) => set((state) => {
    if (state.backgroundAutoFillPreview !== null) return {};
    return {
      ...withActiveFloorField(state, { fieldPrimitive: p }),
      ...(p === "symmetry"
        ? {}
        : { symmetryAxisPoints: [], symmetryPolygon: [], symmetryPolygonFinished: false }),
    };
  }),

  applySymmetry: () => set((state) => guardFieldEdit(state, { kind: "applySymmetry" }, () => {
    const field = activeFloorField(state);
    const axis = state.symmetryAxisPoints;
    if (field.fieldEditMode !== "custom" || axis.length !== 2
      || (axis[0].x === axis[1].x && axis[0].y === axis[1].y)) return {};
    if (state.symmetryScope === "polygon"
      && (state.symmetryPolygon.length < 3 || !state.symmetryPolygonFinished)) return {};
    const preview = computeSymmetryPreview(
      field.fieldPoints,
      field.fieldConfig,
      {
        scope: state.symmetryScope,
        sourceSide: state.symmetrySourceSide,
        axis: [axis[0], axis[1]],
        polygon: state.symmetryPolygon,
      },
      encodePoint,
      decodePoint,
    );
    if (preview.error) return { fieldOpError: preview.error };
    const fieldPointsPatch = withFieldPointsEdit(state, (points) => {
      let changed = false;
      for (const [x, y] of preview.mirroredCells) {
        const key = encodePoint(x, y);
        if (field.fieldOperation === "add" && !points.has(key)) {
          points.add(key);
          changed = true;
        } else if (field.fieldOperation === "remove" && points.delete(key)) {
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
      fieldOpError: null,
      symmetryAxisPoints: [],
      symmetryPolygon: [],
      symmetryPolygonFinished: false,
    };
  })),

  copyFloorField: (sourceFloorId, includeTopology = true) => set((state) => {
    const source = state.floorFields[sourceFloorId];
    if (!source) return {};
    if (state.backgroundAutoFillPreview !== null) return {};
    if (state.mazeDirty || state.postEditDirty) return { fieldEditConfirmation: { kind: "copyFloorField", sourceFloorId, includeTopology } };
    return {
      ...withActiveFloorField(state, { ...cloneFloorField(source), fieldDirty: true }),
      floorTopology: includeTopology
        ? topologyCopiedTo(state.floorTopology, sourceFloorId, [state.activeFloorId])
        : activeFloorField(state).isEditingField && !source.isEditingField
          ? withoutFloorTopology(state.floorTopology, [state.activeFloorId])
          : state.floorTopology,
      ...buildResetDownstreamState(),
      debugStale: debugStaleOf(state),
    };
  }),

  copyCurrentFloorFieldToAll: () => set((state) => {
    const source = state.floorFields[state.activeFloorId];
    if (!source || state.floors.length <= 1 || state.backgroundAutoFillPreview !== null) return {};
    return {
      floorTopology: topologyCopiedTo(
        state.floorTopology,
        state.activeFloorId,
        state.floors.map((floor) => floor.id).filter((id) => id !== state.activeFloorId),
      ),
      floorFields: Object.fromEntries(state.floors.map((floor) => [
        floor.id,
        floor.id === state.activeFloorId
          ? source
          : { ...cloneFloorField(source), fieldDirty: true },
      ])),
      ...buildResetDownstreamState(),
      debugStale: debugStaleOf(state),
    };
  }),

  applyBackgroundAutoFill: (points) => set((state) => {
    const fieldPoints = new Set(points);
    const field = activeFloorField(state);
    const freeFieldPoints = { ...field.freeFieldPoints, [state.tessellationKind]: fieldPoints };
    const fieldConfig = buildFreeConfig(
      tessellationOf(state),
      fieldPoints,
      state.hexOrientation,
      state.triOrientation,
    );
    return {
      ...withActiveFloorField(state, {
        fieldEditMode: "custom",
        isEditingField: true,
        fieldPoints,
        freeFieldPoints,
        fieldConfig,
        fieldDirty: true,
      }),
      ...buildResetDownstreamState(),
      backgroundAutoFillPreview: null,
      debugStale: debugStaleOf(state),
    };
  }),

  confirmFieldEdit: () => {
    if (get().backgroundAutoFillPreview !== null) return;
    const pending = get().fieldEditConfirmation;
    if (!pending) return;
    set(buildResetDownstreamState());
    switch (pending.kind) {
      case "setSelectedShape": get().setSelectedShape(pending.shape); break;
      case "setFieldConfig": get().setFieldConfig(pending.config); break;
      case "setFieldConfigForFloors": get().setFieldConfigForFloors(pending.config, pending.applyToAllStandardFloors); break;
      case "setFieldConfigsForFloors": get().setFieldConfigsForFloors(pending.configs, pending.applyToAllStandardFloors); break;
      case "addFieldPoint": get().addFieldPoint(pending.x, pending.y); break;
      case "removeFieldPoint": get().removeFieldPoint(pending.x, pending.y); break;
      case "addFieldPoints": get().addFieldPoints(pending.cells); break;
      case "removeFieldPoints": get().removeFieldPoints(pending.cells); break;
      case "moveFieldPoints": get().moveFieldPoints(pending.cells, pending.vector); break;
      case "centerFieldPoints": get().centerFieldPoints(); break;
      case "clearFieldPoints": get().clearFieldPoints(); break;
      case "setFieldEditMode": get().setFieldEditMode(pending.mode); break;
      case "applySymmetry": get().applySymmetry(); break;
      case "copyFloorField": get().copyFloorField(pending.sourceFloorId, pending.includeTopology); break;
      case "applyTopologyOp": get().applyTopologyOp(pending.op); break;
      case "clearTopologyGroups": get().clearTopologyGroups(); break;
    }
  },

  cancelFieldEdit: () => set({ fieldEditConfirmation: null }),
});
