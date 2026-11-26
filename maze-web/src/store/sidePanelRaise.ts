import type { MazeStore } from "./storeTypes";
import { raiseSidePanel } from "../components/sidePanelStack";

/** A store action that opens a side panel. `keys` names the panels to raise (in this order, so the
 *  last one ends on top) for a call with these arguments; an empty list means the call opens
 *  nothing (e.g. a close, or clearing a selection). */
interface PanelOpeningAction {
  name: keyof MazeStore;
  keys: (args: unknown[]) => string[];
}

const whenOpened = (key: string) => (args: unknown[]) => (args[0] ? [key] : []);
/** For actions taking a nullable target (an id, a mode, a point): `null` closes or clears, anything else
 *  opens, including a falsy value such as id `0`. */
const whenNotNull = (key: string) => (args: unknown[]) => (args[0] != null ? [key] : []);
const always = (...keys: string[]) => () => keys;

/** Every store action that opens a panel (GitHub issue #1049). The panel stack orders panels by
 *  mount time, so a panel that is already mounted beneath another one is only seen again if it is
 *  raised. That rule is applied here, once, for every call of these actions — also for the ones
 *  that change nothing because the panel is already open. Callers never raise panels themselves. */
export const PANEL_OPENING_ACTIONS: PanelOpeningAction[] = [
  { name: "setTopologyPanelOpen", keys: whenOpened("topology") },
  { name: "setVertexSettingsPanelOpen", keys: whenOpened("vertex-based-settings") },
  { name: "setExportTopologyOpen", keys: whenOpened("image-export-topology") },
  { name: "setOpenRenderModeSettings", keys: whenNotNull("image-export-render-mode") },
  { name: "setOpenExportFormatSettings", keys: whenNotNull("image-export-format") },
  { name: "setCompositionPanelOpen", keys: whenOpened("composition") },
  { name: "setPostEditChangesOpen", keys: whenOpened("post-edit-changes") },
  { name: "setPostEditFocusedPoint", keys: whenNotNull("post-edit-split-nodes") },
  { name: "setPresetFocusedPoint", keys: whenNotNull("preset-split-nodes") },
  { name: "setZonesPanelOpen", keys: whenOpened("zones") },
  { name: "setZoneGroupsPanelOpen", keys: whenOpened("zone-groups") },
  { name: "addManualZone", keys: always("zone-edit") },
  { name: "setZoneEditId", keys: whenNotNull("zone-edit") },
  { name: "addZoneGroup", keys: always("zone-group-edit") },
  { name: "setZoneGroupEditId", keys: whenNotNull("zone-group-edit") },
];

/** Wraps the panel-opening actions of `store` so each call raises the panels it opens. */
export function raisePanelsOnOpen(store: MazeStore): MazeStore {
  const actions = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const { name, keys } of PANEL_OPENING_ACTIONS) {
    const original = actions[name];
    actions[name] = (...args: unknown[]) => {
      const result = original(...args);
      for (const key of keys(args)) raiseSidePanel(key);
      return result;
    };
  }
  return store;
}
