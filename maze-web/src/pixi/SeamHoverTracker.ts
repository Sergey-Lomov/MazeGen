import type { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import type { MazeState } from "../store/storeTypes";
import { arrowContains, pairAt, type SeamArrow } from "./selectors/seamArrows";
import { selectSeamArrowData } from "./seamArrowSync";

/// The pointer reach around an arrow, relative to its width.
const HIT_SLACK_SHARE = 0.5;
/// How long the pointer has to rest on an arrow (or pair) before it is focused, in ms: a pointer just passing over it
/// does not make the layer flicker. Losing the focus is immediate, and so is moving the focus from one arrow or pair
/// to another.
export const HOVER_DELAY_MS = 100;

/// Bounding box of everything an arrow can be hit on, per arrow (arrows are cached per config and topology), so a
/// pointer move far from an arrow skips its segment and zone scans.
const boundsCache = new WeakMap<SeamArrow, [number, number, number, number]>();

function arrowBounds(arrow: SeamArrow): [number, number, number, number] {
  let box = boundsCache.get(arrow);
  if (!box) {
    box = [Infinity, Infinity, -Infinity, -Infinity];
    const lines = [arrow.path, ...(arrow.braces ?? []), arrow.headA, arrow.headB, ...(arrow.pairs ?? []).flatMap((pair) => pair.zones)];
    for (const line of lines) {
      for (const [x, y] of line ?? []) {
        if (x < box[0]) box[0] = x;
        if (y < box[1]) box[1] = y;
        if (x > box[2]) box[2] = x;
        if (y > box[3]) box[3] = y;
      }
    }
    boundsCache.set(arrow, box);
  }
  return box;
}

/// The cards whose canvas shows the seam arrows (the field, presets, generation, analytics and post-edit
/// renderers own a layer of them, image export one while its topology panel is open; tessellation has none).
export function seamArrowsShown(state: MazeState): boolean {
  switch (state.openCard) {
    case "field_setup":
    case "preset_connections":
    case "post_edit":
    case "analytics":
      return true;
    case "image_export":
      return state.exportTopologyOpen;
    case "generation":
      return state.showMaze && state._generatedNodes.length > 0;
    default:
      return false;
  }
}

/// Cards whose hovered face is highlighted together with its copy across the seam.
function isEdgeHighlightCard(state: MazeState): boolean {
  return state.openCard === "post_edit" || state.openCard === "preset_connections";
}

/// Input of the seam arrows (GitHub issue #841): finds the arrow (and glued pair) under the pointer and
/// keeps it in the store as `seamHover`, which the arrow layers of the feature-renderers draw as focus.
export class SeamHoverTracker {
  private readonly onPointerMove = (event: { globalX: number; globalY: number }) => this.hover(event.globalX, event.globalY);
  private readonly onPointerLeave = () => this.settle(null, null);
  private pending: { arrow: number; pair: number | null; timer: ReturnType<typeof setTimeout> } | null = null;

  /// `viewport` is any container with the maze transform; `stage` receives the pointer events.
  constructor(private readonly viewport: Container, private readonly stage: Container) {
    stage.on("pointermove", this.onPointerMove);
    stage.on("pointerleave", this.onPointerLeave);
  }

  private hover(globalX: number, globalY: number): void {
    const state = useMazeStore.getState();
    if (!seamArrowsShown(state)) {
      this.settle(null, null);
      return;
    }
    const { arrows } = selectSeamArrowData(state);
    if (arrows.length === 0) {
      this.settle(null, null);
      return;
    }
    const local = this.viewport.toLocal({ x: globalX, y: globalY });
    // The pointer reach is a few screen pixels whatever the zoom.
    const slack = 3 / (this.viewport.scale.x || 1);
    const at: [number, number] = [local.x, local.y];
    // Post-edit and presets already highlight a glued face and its copy: no pair focus on top of that. Nor while a
    // glue is added or edited: the existing glues stay out of the way of the runs being picked.
    const cells = !isEdgeHighlightCard(state) && state.topologyGlueEditor === null;
    const reach = (width: number) => Math.max(slack, width * HIT_SLACK_SHARE);
    const index = arrows.findIndex((arrow) => {
      const margin = reach(arrow.width) + arrow.braceWidth;
      const [minX, minY, maxX, maxY] = arrowBounds(arrow);
      if (minX <= maxX && (at[0] < minX - margin || at[0] > maxX + margin || at[1] < minY - margin || at[1] > maxY + margin)) return false;
      return arrowContains(arrow, at, reach(arrow.width), cells);
    });
    if (index < 0) this.settle(null, null);
    else this.settle(index, pairAt(arrows[index], at, reach(arrows[index].width), cells));
  }

  /// Focus on `arrow` / `pair`: at once when another one is focused, else once the pointer has rested on it for
  /// `HOVER_DELAY_MS`. None at once.
  private settle(arrow: number | null, pair: number | null): void {
    if (arrow === null) {
      this.cancel();
      this.set(null, null);
      return;
    }
    const current = useMazeStore.getState().seamHover;
    if (current?.arrow === arrow && current.pair === pair) {
      this.cancel();
      return;
    }
    if (current !== null) {
      this.cancel();
      this.set(arrow, pair);
      return;
    }
    if (this.pending?.arrow === arrow && this.pending.pair === pair) return;
    this.cancel();
    const timer = setTimeout(() => {
      this.pending = null;
      // The card may have been closed meanwhile, with no pointer event to say so.
      if (seamArrowsShown(useMazeStore.getState())) this.set(arrow, pair);
    }, HOVER_DELAY_MS);
    this.pending = { arrow, pair, timer };
  }

  private cancel(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private set(arrow: number | null, pair: number | null): void {
    const state = useMazeStore.getState();
    const current = state.seamHover;
    if (arrow === null ? current === null : current?.arrow === arrow && current.pair === pair) return;
    state.setSeamHover(arrow === null ? null : { arrow, pair });
  }

  destroy(): void {
    this.cancel();
    this.stage.off("pointermove", this.onPointerMove);
    this.stage.off("pointerleave", this.onPointerLeave);
  }
}
