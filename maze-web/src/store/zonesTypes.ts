import type { Zone } from "../wasm/mazeService";

/** Section of the zones list: the zones of one kind. */
export type ZonesListMode = "auto" | "manual";

export interface ZonesState {
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
  /** The manual zone whose cells the shape tools edit (GitHub issue #1031); `null` while the list shows. */
  zoneEditId: number | null;
  /** Whether the zone being edited is new (just added): cancelling the editor then deletes it. */
  zoneEditIsNew: boolean;
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
  setShowAutoZones: (v: boolean) => void;
  setShowManualZones: (v: boolean) => void;
  setZonesPanelOpen: (open: boolean) => void;
  setZonesListMode: (mode: ZonesListMode) => void;
  setHoveredZone: (id: number | null) => void;
  toggleZoneVisibility: (id: number) => void;
  /** Appends an empty manual zone named after its id and opens it in the zone editor. */
  addManualZone: () => void;
  removeZone: (id: number) => void;
  /** Opens a manual zone in the zone editor, or closes the editor with `null`. */
  setZoneEditId: (id: number | null) => void;
  /** Leaves the editor without confirming: a zone added in this session is deleted, any other stays. */
  cancelZoneEdit: () => void;
  setShowOtherZones: (v: boolean) => void;
  setZoneSmoothing: (v: boolean) => void;
  setZoneName: (id: number, name: string) => void;
  /** Sets the explicit colour of a zone, or `null` to return it to the automatic one. */
  setZoneColor: (id: number, color: number | null) => void;
  /** The shape tools' writes: cells of the active floor, added to / removed from / moved within the
   *  edited zone. Cells must already be field cells (`cellsInActiveField`). Moves return whether the
   *  zone changed; a move that leaves the field or that core refuses changes nothing. */
  addZoneCells: (cells: [number, number][]) => void;
  removeZoneCells: (cells: [number, number][]) => void;
  moveZoneCells: (cells: [number, number][], vector: [number, number]) => boolean;
}
