import { useCallback, useState, useSyncExternalStore } from "react";

/** Module-level mount-order stack (GitHub issue #629) — every live `SidePanel` instance (in either
 *  mode) pushes its own id here on mount and pops it on unmount, regardless of which feature owns
 *  it. Several `SidePanel`s can be mounted at once (e.g. `DebugPanel` and `VertexBasedSettingsPanel`
 *  both live under `openCard === "generation"`, independently toggled) since nothing here stops a
 *  second feature from opening its own panel while another is already up — only the most recently
 *  mounted one is shown (absolutely positioned, filling the slot); the rest stay mounted but hidden
 *  so their own internal state (scroll position, drafts, ...) survives underneath. Unmounting the
 *  top one (closing it) drops it from the stack and the next-most-recent becomes visible again,
 *  without any feature needing to know about another's open/closed state. A plain module array +
 *  listener set rather than a React context: `SidePanel` instances mount across unrelated,
 *  non-nested component trees (portal target aside), so no single context provider could wrap
 *  all of them.
 *
 *  Reopening a panel that is already in the stack raises it (GitHub issue #1049). That rule lives
 *  in exactly two adapters, never in a caller: the store's panel-open actions
 *  (`store/sidePanelRaise.ts`) and `useSidePanelOpen` for panels whose open flag is local state.
 *  `raiseSidePanel` itself is not meant to be called from feature code. */
export interface PanelStackEntry {
  id: symbol;
  /** Stable name of the panel, used to raise an already-mounted instance. */
  stackKey?: string;
  /** Mirrors this entry's own `overlay` prop — needed so a lower entry can tell whether it's fully
   *  occluded (an in-flow entry stacked on top of it) or merely visually covered (an absolutely
   *  positioned overlay on top of it, which takes no width of its own). */
  overlay: boolean;
}

let panelStack: PanelStackEntry[] = [];
const panelStackListeners = new Set<() => void>();

function notifyPanelStackChange() {
  for (const listener of panelStackListeners) listener();
}

export function pushPanel(id: symbol, overlay: boolean, stackKey?: string) {
  panelStack = [...panelStack, { id, overlay, stackKey }];
  notifyPanelStackChange();
}

export function popPanel(id: symbol) {
  panelStack = panelStack.filter((p) => p.id !== id);
  notifyPanelStackChange();
}

/** Moves the live panel identified by `stackKey` to the top of the shared stack. When it is not
 *  mounted yet this is deliberately a no-op: its normal mount makes it topmost. */
export function raiseSidePanel(stackKey: string) {
  let index = -1;
  for (let i = panelStack.length - 1; i >= 0; i -= 1) {
    if (panelStack[i].stackKey === stackKey) {
      index = i;
      break;
    }
  }
  if (index < 0 || index === panelStack.length - 1) return;
  const entry = panelStack[index];
  panelStack = [...panelStack.slice(0, index), ...panelStack.slice(index + 1), entry];
  notifyPanelStackChange();
}

function subscribePanelStack(listener: () => void) {
  panelStackListeners.add(listener);
  return () => { panelStackListeners.delete(listener); };
}

/** True while `id` is the topmost (most recently mounted, still-live) entry in `panelStack`. */
export function useIsTopPanel(id: symbol): boolean {
  return useSyncExternalStore(
    subscribePanelStack,
    () => panelStack.length > 0 && panelStack[panelStack.length - 1].id === id,
  );
}

/** True while every entry above `id` on the stack is an overlay (or there is none) — i.e. `id`
 *  should stay in normal flow (still contributing its box/width to the slot) even though it isn't
 *  the topmost entry. An overlay is `position: absolute` and contributes no width of its own
 *  (GitHub issue #629 follow-up): if the entry underneath it also left the flow (`display: none`,
 *  the in-flow-panel-stacked-on-in-flow-panel case), the slot has nothing left to size itself by
 *  and collapses to zero width, taking the overlay's `inset: 0` down with it. Only an in-flow entry
 *  stacked on top should pull a lower entry out of the flow. */
export function useKeepsFlowWidth(id: symbol): boolean {
  return useSyncExternalStore(
    subscribePanelStack,
    () => {
      const index = panelStack.findIndex((p) => p.id === id);
      if (index === -1) return true;
      return panelStack.slice(index + 1).every((p) => p.overlay);
    },
  );
}

/** Open flag of a panel whose state is local to its owning component. Opening it, also when it is
 *  already open beneath another panel, raises it — the store-backed panels get the same rule from
 *  `store/sidePanelRaise.ts`. */
export function useSidePanelOpen(stackKey: string, initial = false): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(initial);
  const setPanelOpen = useCallback((next: boolean) => {
    if (next) raiseSidePanel(stackKey);
    setOpen(next);
  }, [stackKey]);
  return [open, setPanelOpen];
}
