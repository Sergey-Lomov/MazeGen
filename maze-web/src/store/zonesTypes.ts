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
}

export interface ZonesActions {
  setShowAutoZones: (v: boolean) => void;
  setShowManualZones: (v: boolean) => void;
  setZonesPanelOpen: (open: boolean) => void;
  setZonesListMode: (mode: ZonesListMode) => void;
  setHoveredZone: (id: number | null) => void;
  toggleZoneVisibility: (id: number) => void;
  /** Appends an empty manual zone named after its id. */
  addManualZone: () => void;
  removeZone: (id: number) => void;
}
