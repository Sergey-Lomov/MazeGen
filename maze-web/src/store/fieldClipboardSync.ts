import type { StoreApi } from "zustand";
import type { MazeStore } from "./storeTypes";
import { tessellationFingerprint } from "./topologyWire";

/** The field clipboard holds cell coordinates, which only mean something in the tessellation
 * they were copied from: it is dropped when the confirmed kind, params or orientation change. */
export function installFieldClipboardSync(store: StoreApi<MazeStore>): void {
  const key = (s: MazeStore) =>
    `${tessellationFingerprint(s.tessellationKind, s.tessellationParams)}|${s.hexOrientation}|${s.triOrientation}`;
  store.subscribe((state, prev) => {
    if (state.fieldClipboard !== null && state.fieldClipboard === prev.fieldClipboard && key(state) !== key(prev)) {
      store.setState({ fieldClipboard: null });
    }
  });
}
