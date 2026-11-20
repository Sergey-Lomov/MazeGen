import type { StateCreator } from "zustand";
import type { MazeStore, MazeState, ZonesState, ZonesActions } from "../storeTypes";
import type { ZoneCellWire } from "../../wasm/mazeService";
import type { ZoneGroup } from "../zonesTypes";
import { translateFieldCells } from "../../wasm/mazeService";
import { activeFieldCellKeys, activeFloorIndexOf, editedZoneOf, zonePointsOnFloor } from "../../pixi/fieldEditTarget";
import { isFieldOpError } from "../../pixi/fieldOps";
import { encodePoint } from "../../pixi/tessellationProjection";
import { overridesWithDraft, zoneFloors, zonesWithDraft } from "../../pixi/selectors/zoneSelectors";
import { combineZoneCells } from "../../pixi/selectors/zoneCombine";

/** The zones state that is saved with the project (GitHub issue #1048) and set from the file by `loadProject`; these are
 *  the values of a new project and of a file without zones. */
export const zonesProjectState = {
  zones: [],
  nextZoneId: 1,
  zoneGroups: [],
  nextZoneGroupId: 1,
  zoneColorOverrides: {},
} satisfies Partial<ZonesState>;

/** Resting values of the zones UI state: modes, panels, drafts, hover and toggles. Loading a project resets them. */
export const zonesTransientUi = {
  zoneGroupsPanelOpen: false,
  zoneGroupEditId: null,
  zoneGroupEditDraft: null,
  zoneGroupEditIsNew: false,
  showAutoZones: true,
  showManualZones: true,
  hiddenZoneIds: [],
  zonesPanelOpen: false,
  zonesListMode: "auto",
  hoveredZoneId: null,
  hoveredZoneIds: [],
  zoneEditDraft: null,
  zoneEditDraftColor: null,
  zoneEditIsNew: false,
  zoneEditDraftGroupIds: [],
  zoneEditDraftNewGroups: [],
  zoneCombine: null,
  showOtherZones: true,
  zoneSmoothing: false,
} satisfies Partial<ZonesState>;

/** Every zones key at its resting value: the slice's initial state, and what tests reset the zones state to. */
export const zonesInitialState = { ...zonesProjectState, ...zonesTransientUi } satisfies Partial<ZonesState>;

/** The zone with the edited zone's cells replaced, or `{}` when nothing changed. Cells of other
 *  floors are kept as they are; the cells of the active floor are rebuilt by `edit` from a set. */
export function withEditedZoneCells(state: MazeState, edit: (onFloor: Map<number, [number, number]>) => boolean): Partial<MazeState> {
  const zone = editedZoneOf(state);
  if (!zone) return {};
  const floor = activeFloorIndexOf(state);
  const onFloor = new Map<number, [number, number]>();
  for (const [f, x, y] of zone.cells) if (f === floor) onFloor.set(encodePoint(x, y), [x, y]);
  if (!edit(onFloor)) return {};
  const cells: ZoneCellWire[] = [
    ...zone.cells.filter(([f]) => f !== floor),
    ...[...onFloor.values()].map(([x, y]): ZoneCellWire => [floor, x, y]),
  ];
  return { zoneEditDraft: { ...zone, cells } };
}

/** The patch that leaves the zone editor with no draft. */
const noZoneEdit = { zoneEditDraft: null, zoneEditDraftColor: null, zoneEditIsNew: false, zoneEditDraftGroupIds: [], zoneEditDraftNewGroups: [], zoneCombine: null } satisfies Partial<MazeState>;

/** The patch that leaves the group editor with no draft. */
const noGroupEdit = { zoneGroupEditId: null, zoneGroupEditDraft: null, zoneGroupEditIsNew: false } satisfies Partial<MazeState>;

const withoutZoneId = (group: ZoneGroup, id: number): ZoneGroup => (group.zoneIds.includes(id) ? { ...group, zoneIds: group.zoneIds.filter((z) => z !== id) } : group);

/** The patch that deletes a zone with everything that refers to it. */
function withoutZone(s: MazeState, id: number): Partial<MazeState> {
  return {
    zones: s.zones.filter((zone) => zone.id !== id),
    zoneGroups: s.zoneGroups.map((group) => withoutZoneId(group, id)),
    ...(s.zoneGroupEditDraft ? { zoneGroupEditDraft: withoutZoneId(s.zoneGroupEditDraft, id) } : {}),
    hiddenZoneIds: s.hiddenZoneIds.filter((hidden) => hidden !== id),
    hoveredZoneId: s.hoveredZoneId === id ? null : s.hoveredZoneId,
    hoveredZoneIds: s.hoveredZoneIds.includes(id) ? s.hoveredZoneIds.filter((z) => z !== id) : s.hoveredZoneIds,
    ...(s.zoneEditDraft?.id === id ? noZoneEdit : {}),
    ...(s.zoneCombine?.otherId === id ? { zoneCombine: { ...s.zoneCombine, otherId: null } } : {}),
    zoneColorOverrides: withoutKey(s.zoneColorOverrides, id),
  };
}

/** The patch that leaves the group editor discarding the draft: leaving any way but "Done" is a cancel. */
function discardingGroupEdit(s: MazeState): Partial<MazeState> {
  return s.zoneGroupEditId === null ? {} : noGroupEdit;
}

/** The patch that confirms the group draft: it replaces its group, or is appended when new. */
function committingGroupEdit(s: MazeState): Partial<MazeState> {
  const draft = s.zoneGroupEditDraft;
  if (!draft) return {};
  return {
    zoneGroups: s.zoneGroups.some((g) => g.id === draft.id) ? s.zoneGroups.map((g) => (g.id === draft.id ? draft : g)) : [...s.zoneGroups, draft],
    ...noGroupEdit,
  };
}

/** The patch applying `change` to a group: to the draft when that group is being edited, else to the list. */
function withGroupChange(s: MazeState, groupId: number, change: (group: ZoneGroup) => ZoneGroup): Partial<MazeState> {
  if (s.zoneGroupEditDraft?.id === groupId) return { zoneGroupEditDraft: change(s.zoneGroupEditDraft) };
  return { zoneGroups: s.zoneGroups.map((g) => (g.id === groupId ? change(g) : g)) };
}

/** The patch that leaves the zone editor discarding the draft: leaving any way but "Done" is a cancel, as the
 *  close cross is. Nothing was written outside the draft, so there is nothing to roll back. */
function discardingZoneEdit(s: MazeState): Partial<MazeState> {
  return s.zoneEditDraft === null ? {} : noZoneEdit;
}

/** The patch that confirms the draft: it replaces its zone (or is appended, when new), takes its colour and its
 *  group links; the groups it asked for are created. */
function committingZoneEdit(s: MazeState): Partial<MazeState> {
  const draft = s.zoneEditDraft;
  if (!draft) return {};
  const linked = new Set(s.zoneEditDraftGroupIds);
  const relink = (g: ZoneGroup): ZoneGroup => {
    if (g.zoneIds.includes(draft.id) === linked.has(g.id)) return g;
    return linked.has(g.id) ? { ...g, zoneIds: [...g.zoneIds, draft.id] } : withoutZoneId(g, draft.id);
  };
  const updated = s.zoneGroups.map(relink);
  const created = s.zoneEditDraftNewGroups.map((name, i): ZoneGroup => ({ id: s.nextZoneGroupId + i, name, zoneIds: [draft.id] }));
  return {
    zones: zonesWithDraft(s.zones, draft),
    zoneColorOverrides: overridesWithDraft(s.zoneColorOverrides, draft, s.zoneEditDraftColor),
    zoneGroups: [...updated, ...created],
    // An open group draft takes the same link, or its "Done" would write the old members back.
    ...(s.zoneGroupEditDraft ? { zoneGroupEditDraft: relink(s.zoneGroupEditDraft) } : {}),
    nextZoneGroupId: s.nextZoneGroupId + created.length,
    ...noZoneEdit,
  };
}

export const createZonesSlice: StateCreator<MazeStore, [], [], ZonesState & ZonesActions> = (set, get) => ({
  ...zonesInitialState,

  // Closing the panel is a cancel of an unconfirmed group edit.
  setZoneGroupsPanelOpen: (open) => set((s) => (open ? { zoneGroupsPanelOpen: true } : { ...discardingGroupEdit(s), zoneGroupsPanelOpen: false, hoveredZoneId: null, hoveredZoneIds: [] })),
  // The new group lives only as the editor's draft until "Done" (`commitZoneGroupEdit`).
  // While a new group is still being edited, adding again changes nothing: the editor stays as it is.
  addZoneGroup: () => set((s) => (s.zoneGroupEditIsNew && s.zoneGroupEditId !== null ? {} : {
    ...discardingGroupEdit(s),
    zoneGroupEditId: s.nextZoneGroupId,
    zoneGroupEditDraft: { id: s.nextZoneGroupId, name: "", zoneIds: [] },
    zoneGroupEditIsNew: true,
    nextZoneGroupId: s.nextZoneGroupId + 1,
  })),
  removeZoneGroup: (id) => set((s) => ({
    zoneGroups: s.zoneGroups.filter((group) => group.id !== id),
    zoneEditDraftGroupIds: s.zoneEditDraftGroupIds.filter((g) => g !== id),
    ...(s.zoneGroupEditId === id ? noGroupEdit : {}),
  })),
  // `null` is "Done": the draft is confirmed. Opening another group drops the unconfirmed draft.
  setZoneGroupEditId: (id) => set((s) => {
    if (id === null) return committingGroupEdit(s);
    if (id === s.zoneGroupEditId) return {};
    const group = s.zoneGroups.find((g) => g.id === id);
    if (!group) return {};
    return { ...discardingGroupEdit(s), zoneGroupEditId: id, zoneGroupEditDraft: group, zoneGroupEditIsNew: false };
  }),
  commitZoneGroupEdit: () => set((s) => committingGroupEdit(s)),
  cancelZoneGroupEdit: () => set((s) => discardingGroupEdit(s)),
  setZoneGroupName: (id, name) => set((s) => withGroupChange(s, id, (g) => ({ ...g, name }))),
  addZonesToGroup: (groupId, zoneIds) => set((s) => {
    const known = new Set(s.zones.map((z) => z.id));
    return withGroupChange(s, groupId, (g) => {
      const added = zoneIds.filter((id, i) => known.has(id) && !g.zoneIds.includes(id) && zoneIds.indexOf(id) === i);
      return added.length === 0 ? g : { ...g, zoneIds: [...g.zoneIds, ...added] };
    });
  }),
  removeZoneFromGroup: (groupId, zoneId) => set((s) => withGroupChange(s, groupId, (g) => withoutZoneId(g, zoneId))),
  setShowAutoZones: (v) => set({ showAutoZones: v }),
  setShowManualZones: (v) => set({ showManualZones: v }),
  setZonesPanelOpen: (open) => set((s) => (open
    ? { zonesPanelOpen: true }
    : { ...discardingZoneEdit(s), zonesPanelOpen: false, hoveredZoneId: null })),
  setZonesListMode: (mode) => set({ zonesListMode: mode, hoveredZoneId: null }),
  setHoveredZone: (id) => set({ hoveredZoneId: id }),
  setHoveredZones: (ids) => set({ hoveredZoneIds: ids }),
  toggleZoneVisibility: (id) => set((s) => ({
    hiddenZoneIds: s.hiddenZoneIds.includes(id) ? s.hiddenZoneIds.filter((hidden) => hidden !== id) : [...s.hiddenZoneIds, id],
  })),
  // An unnamed zone shows as "Zone #id" (`zoneDisplayName`).
  // While a new zone is still being edited, adding again changes nothing: the editor stays as it is.
  // The new zone lives only as the editor's draft until "Done" (`commitZoneEdit`).
  addManualZone: () => set((s) => (s.zoneEditIsNew && s.zoneEditDraft !== null ? {} : {
    ...discardingZoneEdit(s),
    zoneEditDraft: { id: s.nextZoneId, name: "", kind: "manual", cells: [] },
    zoneEditDraftColor: null,
    zoneEditIsNew: true,
    zoneEditDraftGroupIds: [],
    zoneEditDraftNewGroups: [],
    nextZoneId: s.nextZoneId + 1,
    hoveredZoneId: null,
  })),
  removeZone: (id) => set((s) => withoutZone(s, id)),
  // `null` is "Done": the draft is confirmed. Opening another zone drops the unconfirmed draft.
  setZoneEditId: (id) => {
    let floorToShow: string | undefined;
    set((s) => {
      if (id === null) return committingZoneEdit(s);
      if (id === s.zoneEditDraft?.id) return { hoveredZoneId: null };
      const zone = s.zones.find((z) => z.id === id);
      if (!zone) return {};
      // Editing starts on the zone's lowest floor, unless the active floor already holds some of its cells.
      const floors = zoneFloors(zone);
      if (floors.length > 0 && !floors.includes(s.floors.findIndex((f) => f.id === s.activeFloorId))) floorToShow = s.floors[floors[0]]?.id;
      return {
        ...discardingZoneEdit(s),
        zoneEditDraft: zone,
        zoneEditDraftColor: s.zoneColorOverrides[id] ?? null,
        zoneEditIsNew: false,
        zoneEditDraftGroupIds: s.zoneGroups.filter((g) => g.zoneIds.includes(id)).map((g) => g.id),
        zoneEditDraftNewGroups: [],
        hoveredZoneId: null,
      };
    });
    // Through the floors slice, so the floor switch resets the per-floor drafts as any other switch does.
    if (floorToShow !== undefined) get().setActiveFloorId(floorToShow);
  },
  commitZoneEdit: () => set((s) => committingZoneEdit(s)),
  addZoneEditGroup: (groupId) => set((s) => (
    !s.zoneEditDraft || s.zoneEditDraftGroupIds.includes(groupId) || !s.zoneGroups.some((g) => g.id === groupId)
      ? {}
      : { zoneEditDraftGroupIds: [...s.zoneEditDraftGroupIds, groupId] })),
  removeZoneEditGroup: (groupId) => set((s) => ({ zoneEditDraftGroupIds: s.zoneEditDraftGroupIds.filter((g) => g !== groupId) })),
  addZoneEditNewGroup: (name) => set((s) => (s.zoneEditDraft ? { zoneEditDraftNewGroups: [...s.zoneEditDraftNewGroups, name] } : {})),
  removeZoneEditNewGroup: (index) => set((s) => ({ zoneEditDraftNewGroups: s.zoneEditDraftNewGroups.filter((_, i) => i !== index) })),
  cancelZoneEdit: () => set((s) => discardingZoneEdit(s)),
  toggleZoneCombine: () => set((s) => (!s.zoneEditDraft ? {} : { zoneCombine: s.zoneCombine ? null : { op: "union", otherId: null } })),
  setZoneCombineOp: (op) => set((s) => (s.zoneCombine ? { zoneCombine: { ...s.zoneCombine, op } } : {})),
  setZoneCombineOther: (id) => set((s) => {
    if (!s.zoneCombine) return {};
    const valid = id !== null && id !== s.zoneEditDraft?.id && s.zones.some((z) => z.id === id);
    return { zoneCombine: { ...s.zoneCombine, otherId: valid ? id : null } };
  }),
  applyZoneCombine: () => set((s) => {
    const other = s.zoneCombine && s.zones.find((z) => z.id === s.zoneCombine?.otherId);
    if (!s.zoneCombine || !s.zoneEditDraft || !other) return {};
    return { zoneEditDraft: { ...s.zoneEditDraft, cells: combineZoneCells(s.zoneEditDraft.cells, other.cells, s.zoneCombine.op) }, zoneCombine: null };
  }),
  cancelZoneCombine: () => set({ zoneCombine: null }),
  clearZoneCells: () => set((s) => (s.zoneEditDraft && s.zoneEditDraft.cells.length > 0 ? { zoneEditDraft: { ...s.zoneEditDraft, cells: [] } } : {})),
  setShowOtherZones: (v) => set({ showOtherZones: v }),
  setZoneSmoothing: (v) => set({ zoneSmoothing: v }),
  // Name and colour belong to the editor: they change the draft only, `zones` takes them on "Done".
  setZoneName: (name) => set((s) => (s.zoneEditDraft ? { zoneEditDraft: { ...s.zoneEditDraft, name } } : {})),
  setZoneColor: (color) => set((s) => (s.zoneEditDraft ? { zoneEditDraftColor: color } : {})),

  addZoneCells: (cells) => set((s) => withEditedZoneCells(s, (onFloor) => {
    let changed = false;
    for (const [x, y] of cells) {
      const key = encodePoint(x, y);
      if (!onFloor.has(key)) { onFloor.set(key, [x, y]); changed = true; }
    }
    return changed;
  })),

  removeZoneCells: (cells) => set((s) => withEditedZoneCells(s, (onFloor) => {
    let changed = false;
    for (const [x, y] of cells) if (onFloor.delete(encodePoint(x, y))) changed = true;
    return changed;
  })),

  moveZoneCells: (cells, vector) => {
    const before = get();
    if (vector[0] === 0 && vector[1] === 0) return false;
    const zone = editedZoneOf(before);
    if (!zone) return false;
    const held = zonePointsOnFloor(zone, activeFloorIndexOf(before));
    const selected = cells.filter(([x, y]) => held.has(encodePoint(x, y)));
    if (selected.length === 0) return false;
    let moved: [number, number][];
    try {
      moved = translateFieldCells(before.floorFields[before.activeFloorId].fieldConfig.tessellation, selected, vector);
    } catch (error) {
      // A refused move leaves the zone unchanged, as it does the field.
      if (!isFieldOpError(error)) throw error;
      return false;
    }
    const fieldCells = activeFieldCellKeys(before);
    if (moved.some(([x, y]) => !fieldCells.has(encodePoint(x, y)))) return false;
    set((s) => withEditedZoneCells(s, (onFloor) => {
      for (const [x, y] of selected) onFloor.delete(encodePoint(x, y));
      for (const [x, y] of moved) onFloor.set(encodePoint(x, y), [x, y]);
      return true;
    }));
    return true;
  },
});

function withoutKey(record: Record<number, number>, id: number): Record<number, number> {
  const { [id]: _removed, ...rest } = record;
  return rest;
}
