import type { Zone } from "../wasm/mazeService";
import type { ZoneCombine, ZoneCombineOp } from "../domain/selectors/zoneCombine";
import type { ZonesGrouping } from "./zoneListSort";

/** Section of the zones list: the zones of one kind. */
export type ZonesListMode = "auto" | "manual";

/** A named set of zones (GitHub issue #1035). Holds zone ids, so deleting a zone drops it from every group. */
export interface ZoneGroup {
  id: number;
  name: string;
  zoneIds: number[];
}

/** Generation parameters a zone override can set (GitHub issue #1038); the names are the wire keys core reads. */
export type ZoneOverrideParamKey =
  | "corridor_chance" | "branching" | "directionality" | "cyclicity"
  | "one_way_chance" | "teleport_chance" | "teleport_one_way_chance" | "cross_floor_teleport_balance"
  | "split_chance"
  | "vertical_chance" | "vertical_passage_elevator_balance" | "one_way_vertical_passage_chance" | "vertical_up_down_balance"
  | "elevator_span_min" | "elevator_span_max" | "elevator_branching"
  | "allow_non_consecutive_elevator_floors";


/** Generation parameters set inside some zones and groups only (GitHub issue #1038). Where overrides overlap on a
 *  parameter, the zone with the smaller id wins; the generation feature warns about it. */
export interface ZoneOverride {
  id: number;
  zoneIds: number[];
  groupIds: number[];
  /** The parameters this override sets; every other one keeps its global value inside the zones. */
  params: Partial<Record<ZoneOverrideParamKey, number>>;
}

/** The render mode whose settings an export zone override changes. */
export type ExportOverrideMode = "walls" | "corridors";

/** A value of an export parameter: a colour (0xRRGGBB), a size, a switch or the id of an option. */
export type ExportOverrideValue = number | boolean | string;

/** Export parameters set inside some zones and groups only (GitHub issue #1040). The parameters are named by their path
 *  in the mode's settings (`wallColor`, `startMarker.fillColor`). Where overrides of one mode overlap on a parameter
 *  with different values, the export feature warns. */
export interface ExportZoneOverride {
  id: number;
  mode: ExportOverrideMode;
  zoneIds: number[];
  groupIds: number[];
  params: Record<string, ExportOverrideValue>;
}

/** The zone or group an override applies to. */
export interface ZoneOverrideTarget {
  kind: "zone" | "group";
  id: number;
}

export interface ZonesState {
  /** Zone overrides of the generation parameters, in insertion order. */
  zoneOverrides: ZoneOverride[];
  /** The id the next added override gets. Only grows. */
  nextZoneOverrideId: number;
  /** Zone overrides of the export parameters (GitHub issue #1040), in insertion order. */
  exportZoneOverrides: ExportZoneOverride[];
  nextExportZoneOverrideId: number;
  /** The zone or group whose settings the export panel shows and edits; `null` for the global ones. */
  exportOverrideContext: ZoneOverrideTarget | null;
  /** Zone groups of the project, in insertion order. */
  zoneGroups: ZoneGroup[];
  /** The id the next added group gets. Only grows, so an id of a deleted group is never reused. */
  nextZoneGroupId: number;
  /** Whether the zone groups list side panel is open. */
  zoneGroupsPanelOpen: boolean;
  /** The section of the groups list that is shown: the automatic groups or the manual ones. */
  zoneGroupsListMode: ZonesListMode;
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
  /** How each section of the zones list folds its cards into collapsible sections; the two sections group independently. */
  zonesGrouping: Record<ZonesListMode, ZonesGrouping>;
  /** A request (GitHub issue #1036) for the zones list to group by groups and open the section of this group; the
   *  open list consumes it (`clearZonesFocusedGroup`), so one opened later still honours it. */
  zonesFocusedGroupId: number | null;
  /** The zone whose list card is hovered; highlighted on the canvas regardless of its visibility. */
  hoveredZoneId: number | null;
  /** The group hovered where a group is picked (GitHub issue #1038): all its zones are highlighted in the info blue. */
  hoveredZoneGroupId: number | null;
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
  /** Appends an override that sets `params` inside one zone or group. */
  addZoneOverride: (params: ZoneOverride["params"], target: ZoneOverrideTarget) => void;
  removeZoneOverride: (id: number) => void;
  /** Points an override at one zone or one group; an id of no zone or group is ignored. */
  setZoneOverrideTarget: (overrideId: number, target: ZoneOverrideTarget) => void;
  /** Sets a parameter of an override; `null` takes it out (back to the global value). Span bounds stay ordered. */
  setZoneOverrideParam: (overrideId: number, key: ZoneOverrideParamKey, value: number | null) => void;
  /** Writes parameters into the export override of one zone or group (created when missing): a value sets a parameter,
   *  `null` takes it out; an override left empty is dropped (GitHub issue #1040). */
  setExportZoneParams: (mode: ExportOverrideMode, target: ZoneOverrideTarget, changes: Record<string, ExportOverrideValue | null>) => void;
  removeExportZoneOverride: (id: number) => void;
  setExportOverrideContext: (target: ZoneOverrideTarget | null) => void;
  setZoneGroupsPanelOpen: (open: boolean) => void;
  setZoneGroupsListMode: (mode: ZonesListMode) => void;
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
  setZonesGrouping: (mode: ZonesListMode, grouping: ZonesGrouping) => void;
  /** Opens the zones list grouped by groups, with only this group's section expanded (see `zonesFocusedGroupId`), on
   *  the list section that holds the group's zones (the current one when it does). */
  showZonesOfGroup: (groupId: number) => void;
  clearZonesFocusedGroup: () => void;
  setHoveredZone: (id: number | null) => void;
  setHoveredZoneGroup: (id: number | null) => void;
  toggleZoneVisibility: (id: number) => void;
  /** Shows or hides all the given zones at once. */
  setZonesVisible: (ids: number[], visible: boolean) => void;
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
