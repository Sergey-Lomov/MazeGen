import type { StoreApi } from "zustand";
import { warmCartesianCache } from "../pixi/cartesianCache";
import { notify } from "../notifications/notificationStore";
import { registerNotificationCode } from "../notifications/notificationRegistry";
import * as m from "~/paraglide/messages";
import type { MazeStore } from "./storeTypes";
import { floorTessellationOf } from "./storeHelpers";
import { floorTopologyInfo, inactiveFoldCount } from "./topologyInfo";

export const TOPOLOGY_FOLDS_INACTIVE = "topology.folds_inactive";

registerNotificationCode(TOPOLOGY_FOLDS_INACTIVE, {
  severity: "warning",
  message: (params) => m[TOPOLOGY_FOLDS_INACTIVE]({ floor: String(params.floor), count: Number(params.count) }),
  dedupParams: ["floor"],
});

/** Keeps the geometry cache and the user in step with a floor's topology (GitHub issue #839):
 * - the cache is rewarmed with the active floor's folds when they or the active floor change, so
 *   its snapshot is keyed by topology as well as field version;
 * - a field edit that leaves more of a floor's folds inactive than before is announced. */
export function installTopologySync(store: StoreApi<MazeStore>): void {
  store.subscribe((state, prev) => {
    const floor = state.activeFloorId;
    const topology = state.floorTopology[floor] ?? null;
    const prevTopology = prev.floorTopology[prev.activeFloorId] ?? null;
    if ((floor !== prev.activeFloorId || topology !== prevTopology) && (topology !== null || prevTopology !== null)) {
      try {
        warmCartesianCache(floorTessellationOf(state, floor), topology);
      } catch {
        // The cache is rebuilt lazily by the next read; a floor mid-reset must not break the store.
      }
    }

    for (const { id, title } of state.floors) {
      if (state.floorTopology[id] === undefined || state.floorTopology[id] !== prev.floorTopology[id]) continue;
      const field = state.floorFields[id];
      const prevField = prev.floorFields[id];
      if (!field || !prevField || (field.fieldPoints === prevField.fieldPoints && field.fieldConfig === prevField.fieldConfig)) continue;
      const count = inactiveFoldCount(floorTopologyInfo(state, id));
      if (count > inactiveFoldCount(floorTopologyInfo(prev, id))) notify({ source: "topology", code: TOPOLOGY_FOLDS_INACTIVE, params: { floor: title, count } });
    }
  });
}
