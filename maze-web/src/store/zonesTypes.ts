import type { Zone } from "../wasm/mazeService";
import type { ZoneCombine, ZoneCombineOp } from "../pixi/selectors/zoneCombine";

/** Section of the zones list: the zones of one kind. */
export type ZonesListMode = "auto" | "manual";

/** A named set of zones (GitHub issue #1035). Holds zone ids, so deleting a zone drops it from every group. */
export interface ZoneGroup {
  id: number;
  name: string;
  zoneIds: number[];
}

export interface ZonesState {
  /** Zone groups of the project, in insertion order. */
  zoneGroups: ZoneGroup[];
  /** The id the next added group gets. Only grows, so an id of a deleted group is never reused. */
  nextZoneGroupId: number;
  /** Whether the zone groups list side panel is open. */
  zoneGroupsPanelOpen: boolean;
  /** The group whose zones the group panel lists; `null` while only the groups list shows. */
  zoneGroupEditId: number | null;
  /** Working copy of the group being edited; `zoneGroups` takes it only on "Done" (`commitZoneGroupEdit`), so the
   *  list never shows a half-edited or not yet confirmed group. */
  zoneGroupEditDraft: ZoneGroup | null;
  /** Whether the group being edited is new: it is not in `zoneGroups` until "Done". */
  zoneGroupEditIsNew: boolean;
  /** Zones of the project, in insertion order (see `Specs/zones.md`). Editing and persistence are
   *  tracked separately, so only the list's "Add" button fills this yet. */
  zones: Zone[];
  /** The id the next added zone gets. Only grows, so an id of a deleted zone is never reused. */
  nextZoneId: number;
  /** Whether the zones feature draws `auto` zones. */
  showAutoZones: boolean;
  /** Whether the zones feature draws `manual` zones. */
  showManualZones: boolean;
  /** Ids of the zones switched off with the eye icon of their list card. */
  hiddenZoneIds: number[];
  /** Whether the zones list side panel is open. */
  zonesPanelOpen: boolean;
  /** The section of the zones list that is shown. */
  zonesListMode: ZonesListMode;
  /** The zone whose list card is hovered; highlighted on the canvas regardless of its visibility. */
  hoveredZoneId: number | null;
  /** The zones of the hovered group card (GitHub issue #1035), highlighted together; a `hoveredZoneId` wins. */
  hoveredZoneIds: number[];
  /** The manual zone whose cells the shape tools edit (GitHub issue #1031); `null` while the list shows. */
  /** Working copy of the zone being edited. The shape tools and the properties write here; `zones` takes it
   *  only on "Done" (`commitZoneEdit`), so a zone list never shows a half-edited or not yet confirmed zone. */
  zoneEditDraft: Zone | null;
  /** Explicit colour of the draft (`null`: automatic); moves to `zoneColorOverrides` on "Done". */
  zoneEditDraftColor: number | null;
  /** Whether the zone being edited is new (just added): it is not in `zones` until "Done". */
  zoneEditIsNew: boolean;
  /** Ids of the existing groups the draft zone belongs to; applied to `zoneGroups` on "Done". */
  zoneEditDraftGroupIds: number[];
  /** Names of groups to create holding the draft zone on "Done". */
  zoneEditDraftNewGroups: string[];
  /** The combine panel's state (GitHub issue #1032), `null` while the panel is closed; the preview is shown until
   *  it is applied or closed. Transient, and dropped whenever the editor ends. */
  zoneCombine: ZoneCombine | null;
  /** Whether the zones other than the edited one are drawn while a zone is edited. */
  showOtherZones: boolean;
  /** Explicit colours (0xRRGGBB) by zone id. Such a zone keeps its colour and still takes its slot in
   *  the automatic spread, so setting one never shifts the others. */
  zoneColorOverrides: Record<number, number>;
  /** Smoothing of the shape tools in the zone editor. Off by default: it is the field's own switch
   *  (`smoothPrimitives`) that is on, and a zone is usually drawn cell by cell. */
  zoneSmoothing: boolean;
}

export interface ZonesActions {
  setZoneGroupsPanelOpen: (open: boolean) => void;
  /** Opens a new empty unnamed group in the group panel as a draft; it joins the list on "Done"; does nothing while a new group is being edited. */
  addZoneGroup: () => void;
  removeZoneGroup: (id: number) => void;
  /** Opens a group in the editor (as a draft), or confirms and closes it with `null`. */
  setZoneGroupEditId: (id: number | null) => void;
  /** "Done": the draft goes into `zoneGroups` (a new group is appended). */
  commitZoneGroupEdit: () => void;
  /** Leaves the editor discarding the draft. */
  cancelZoneGroupEdit: () => void;
  setZoneGroupName: (id: number, name: string) => void;
  /** Adds zones to a group; ids already in it, or of no zone, are ignored. */
  addZonesToGroup: (groupId: number, zoneIds: number[]) => void;
  removeZoneFromGroup: (groupId: number, zoneId: number) => void;
  setShowAutoZones: (v: boolean) => void;
  setShowManualZones: (v: boolean) => void;
  setZonesPanelOpen: (open: boolean) => void;
  setZonesListMode: (mode: ZonesListMode) => void;
  setHoveredZone: (id: number | null) => void;
  setHoveredZones: (ids: number[]) => void;
  toggleZoneVisibility: (id: number) => void;
  /** Appends an empty manual zone named after its id and opens it in the zone editor. */
  addManualZone: () => void;
  removeZone: (id: number) => void;
  /** Opens a manual zone in the zone editor (as a draft), or confirms and closes the editor with `null`. */
  setZoneEditId: (id: number | null) => void;
  /** The zone editor's Groups section, all on the draft: put the zone in an existing group, take it out, or
   *  have a new group created for it on "Done" (removed by its index in `zoneEditDraftNewGroups`). */
  addZoneEditGroup: (groupId: number) => void;
  removeZoneEditGroup: (groupId: number) => void;
  addZoneEditNewGroup: (name: string) => void;
  removeZoneEditNewGroup: (index: number) => void;
  /** "Done": the draft goes into `zones` (a new zone is appended) with its colour. */
  commitZoneEdit: () => void;
  /** Leaves the editor discarding the draft: a new zone never reaches `zones`, an existing one stays as it was. */
  cancelZoneEdit: () => void;
  /** Opens the combine panel on the draft (union, no zone chosen); closes it when it is already open. */
  toggleZoneCombine: () => void;
  setZoneCombineOp: (op: ZoneCombineOp) => void;
  /** Chooses the zone the draft is combined with; ids of the draft itself or of no zone are ignored. */
  setZoneCombineOther: (id: number | null) => void;
  /** Applies the previewed combination to the draft's cells (every floor) and closes the panel. */
  applyZoneCombine: () => void;
  /** Closes the combine panel without applying. */
  cancelZoneCombine: () => void;
  /** Removes every cell, on every floor, from the zone being edited (its draft). */
  clearZoneCells: () => void;
  setShowOtherZones: (v: boolean) => void;
  setZoneSmoothing: (v: boolean) => void;
  /** Rename / recolour the zone being edited (its draft); no-op while no zone is edited. */
  setZoneName: (name: string) => void;
  /** Sets the explicit colour of a zone, or `null` to return it to the automatic one. */
  setZoneColor: (color: number | null) => void;
  /** The shape tools' writes: cells of the active floor, added to / removed from / moved within the
   *  edited zone. Cells must already be field cells (`cellsInActiveField`). Moves return whether the
   *  zone changed; a move that leaves the field or that core refuses changes nothing. */
  addZoneCells: (cells: [number, number][]) => void;
  removeZoneCells: (cells: [number, number][]) => void;
  moveZoneCells: (cells: [number, number][], vector: [number, number]) => boolean;
}
