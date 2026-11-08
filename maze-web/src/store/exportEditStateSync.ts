import type { StoreApi } from "zustand";
import type { MazeStore } from "./storeTypes";

/** Canvas edit modes owned by the export card (connector editing, floor-label drag) end when another
 * card opens, so returning to export starts with them off (GitHub issue #947). */
export function installExportEditStateSync(store: StoreApi<MazeStore>): void {
  store.subscribe((state, prev) => {
    if (state.openCard === prev.openCard || state.openCard === "image_export") return;
    if (state.teleportConnectorEdit !== null) state.finishTeleportConnectorEdit();
    if (state.floorLabelDrag !== null) state.finishFloorLabelDrag();
  });
}
