import { useMazeStore } from "../store/mazeStore";
import type { MazeStore } from "../store/storeTypes";

/// Calls `redraw` now and after every store update that changes one of `inputs` (compared by reference), not after
/// every update. The geometry cache is rewarmed by a store subscriber of its own (`topologySync`), so the draw is
/// deferred to a microtask: it runs after the notification has reached every subscriber and reads the warmed snapshot.
/// Returns the unsubscribe.
export function watchStoreInputs(inputs: (state: MazeStore) => readonly unknown[], redraw: () => void): () => void {
  let pending = false;
  const schedule = (): void => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      redraw();
    });
  };
  const unsubscribe = useMazeStore.subscribe((state, prev) => {
    const now = inputs(state);
    const before = inputs(prev);
    if (now.length !== before.length || now.some((value, i) => !Object.is(value, before[i]))) schedule();
  });
  redraw();
  return unsubscribe;
}
