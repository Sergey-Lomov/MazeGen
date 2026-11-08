import type { StoreApi } from "zustand";
import type { MazeStore } from "./storeTypes";
import { teleportConnectorKey } from "../pixi/renderers/teleportConnectorManual";

/** A manual connector path is keyed by its teleport pair. Whatever removes a teleport (post-edit,
 * preset, regeneration) ends in a new `edges`, so a path whose pair is no longer there is dropped
 * here, in one place (GitHub issue #950). An empty `edges` means "no maze yet" and drops nothing. */
export function installTeleportConnectorPathSync(store: StoreApi<MazeStore>): void {
  store.subscribe((state, prev) => {
    if (state.edges === prev.edges || state.edges.length === 0) return;
    const paths = state.vectorByWallsSettings.manualTeleportConnectorPaths;
    const keys = paths ? Object.keys(paths) : [];
    if (keys.length === 0) return;
    const live = new Set<string>();
    for (const e of state.edges) {
      if (e.kind === "teleport") live.add(teleportConnectorKey({ fromNode: e.from, toNode: e.to })!);
    }
    const kept = keys.filter((key) => live.has(key));
    if (kept.length === keys.length) return;
    state.setManualTeleportConnectorPaths(Object.fromEntries(kept.map((key) => [key, paths![key]])));
  });
}
