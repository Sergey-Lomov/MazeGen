import type { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import type { MazeState } from "../store/storeTypes";
import { SeamArrowRenderer, type SeamArrowData } from "./renderers/SeamArrowRenderer";
import { selectActiveSeamArrows } from "./selectors/seamHop";

/// What feeds the seam arrow layers of the feature-renderers (GitHub issue #841): the arrows of the active
/// floor and the focus on one of them or on one of their pairs. The pointer's focus (`seamHover`, set by
/// `SeamHoverTracker`) wins over the topology panel's.
export function selectSeamArrowData(state: MazeState): SeamArrowData {
  const arrows = selectActiveSeamArrows(state);
  const pointer = state.seamHover;
  if (pointer !== null && pointer.arrow < arrows.length) return { arrows, focus: pointer };
  return { arrows, focus: panelFocus(arrows, state.topologyHover) };
}

/// The arrow (and pair) the topology panel hovers: a whole glue, or one of its pairs.
function panelFocus(arrows: SeamArrowData["arrows"], hover: MazeState["topologyHover"]): SeamArrowData["focus"] {
  if (hover === null) return null;
  const arrow = arrows.findIndex((candidate) => candidate.group === hover.glue);
  if (arrow < 0) return null;
  if (hover.fold === null) return { arrow, pair: null };
  const pair = arrows[arrow].pairs.findIndex((candidate) => candidate.fold === hover.fold);
  return { arrow, pair: pair < 0 ? null : pair };
}

/// Calls `render` with the current arrows now and after every change of what they are drawn from. The
/// geometry cache is rewarmed by a store subscriber of its own (`topologySync`); drawing after the
/// current notification has reached every subscriber reads the warmed snapshot. Returns the unsubscribe.
export function watchSeamArrows(render: (data: SeamArrowData) => void): () => void {
  let pending = false;
  const schedule = (): void => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      render(selectSeamArrowData(useMazeStore.getState()));
    });
  };
  const unsubscribe = useMazeStore.subscribe((state, prev) => {
    const field = state.floorFields[state.activeFloorId];
    const prevField = prev.floorFields[prev.activeFloorId];
    if (
      state.activeFloorId !== prev.activeFloorId
      || state.floorTopology !== prev.floorTopology
      || state.topologyHover !== prev.topologyHover
      || state.seamHover !== prev.seamHover
      || field?.fieldConfig !== prevField?.fieldConfig
      || field?.fieldPoints !== prevField?.fieldPoints
    ) schedule();
  });
  schedule();
  return unsubscribe;
}

/// The seam layer of a feature-renderer: draws the arrows into `container` and keeps them current. `onData`
/// replaces the plain drawing for a renderer that adds its own focus before it draws (through `render`).
export class SeamArrowLayer {
  private readonly renderer: SeamArrowRenderer;
  private readonly unwatch: () => void;

  constructor(container: Container, onData?: (data: SeamArrowData) => void) {
    this.renderer = new SeamArrowRenderer(container);
    this.unwatch = watchSeamArrows(onData ?? ((data) => this.renderer.render(data)));
  }

  render(data: SeamArrowData): void {
    this.renderer.render(data);
  }

  destroy(): void {
    this.unwatch();
    this.renderer.destroy();
  }
}
