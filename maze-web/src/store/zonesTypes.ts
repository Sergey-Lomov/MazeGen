import type { Zone } from "../wasm/mazeService";

export interface ZonesState {
  /** Zones of the project, in insertion order (see `Specs/zones.md`). Editing and persistence are
   *  tracked separately, so nothing fills this yet. */
  zones: Zone[];
  /** Whether the zones feature draws `auto` zones. */
  showAutoZones: boolean;
  /** Whether the zones feature draws `manual` zones. */
  showManualZones: boolean;
}

export interface ZonesActions {
  setShowAutoZones: (v: boolean) => void;
  setShowManualZones: (v: boolean) => void;
}
