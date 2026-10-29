import type { Container } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import type { PointerHandler } from "../sceneTypes";
import { toViewportCoordinates } from "../pointerInteraction";
import { distanceToSegment, offsetForPoint } from "./cutLines";
import { drawnSideSpans } from "./cutLineSpans";
import { floorCutLines, type CutLineHandle } from "./exportContent";

type MazeState = ReturnType<typeof useMazeStore.getState>;

/** Screen-pixel distance within which a pointer grabs a cut line. */
const GRAB_PX = 8;

/** Whether the export topology panel is open, i.e. cut lines are shown and editable on the canvas. */
export function cutEditingActive(st: MazeState): boolean {
  return st.openCard === "image_export" && st.exportTopologyOpen && st.nodes.length > 0;
}

/** The cut lines of the active floor, in display space. */
export function activeCutLines(st: MazeState): CutLineHandle[] {
  return floorCutLines({
    cfg: st.activeFieldConfig,
    floorId: st.activeFloorId,
    topology: st.floorTopology[st.activeFloorId],
    cuts: st.pngExportSettings.cuts,
  });
}

/** Whether the export topology panel has a manual cut line that the pointer could grab. */
export function hasManualCutLine(st: MazeState): boolean {
  return cutEditingActive(st) && activeCutLines(st).some((handle) => handle.mode === "manual");
}

/** Drags the manual cut lines of the active floor. A press that misses every manual line pans the
 * canvas, so the controller can stay installed while the export panel is open. */
export class CutLineDragController implements PointerHandler {
  /** The line being dragged and which of its two sides was grabbed (side 1 is the twin, one period over). */
  private dragging: { handle: CutLineHandle; side: 0 | 1 } | null = null;

  constructor(
    private readonly getViewport: () => Container,
    private readonly pan: { start(x: number, y: number): void; move(x: number, y: number): void; end(): void },
  ) {}

  private panning = false;

  onPointerDown(canvasX: number, canvasY: number, button: number): void {
    const hit = button === 0 ? this.hitTest(canvasX, canvasY) : null;
    if (hit) {
      this.dragging = hit;
      return;
    }
    this.panning = true;
    this.pan.start(canvasX, canvasY);
  }

  onPointerMove(canvasX: number, canvasY: number): void {
    if (this.panning) {
      this.pan.move(canvasX, canvasY);
      return;
    }
    if (!this.dragging) return;
    const st = useMazeStore.getState();
    const { handle, side } = this.dragging;
    const current = activeCutLines(st).find((candidate) => candidate.group === handle.group && candidate.mode === "manual");
    if (!current) {
      this.dragging = null;
      return;
    }
    const pointer = toViewportCoordinates(canvasX, canvasY, this.getViewport());
    // Grabbing the twin moves the line the same way: the twin is the line plus one period.
    const period = current.line.cut.period;
    const at: [number, number] = side === 1 ? [pointer.x - period[0], pointer.y - period[1]] : [pointer.x, pointer.y];
    st.setCutLine(st.activeFloorId, current.group, { mode: "manual", offset: offsetForPoint(current.line.cut, at) });
  }

  onPointerUp(): void {
    this.cancelPointerGesture();
  }

  cancelPointerGesture(): void {
    this.dragging = null;
    if (this.panning) {
      this.panning = false;
      this.pan.end();
    }
  }

  private hitTest(canvasX: number, canvasY: number): { handle: CutLineHandle; side: 0 | 1 } | null {
    const viewport = this.getViewport();
    const pointer = toViewportCoordinates(canvasX, canvasY, viewport);
    const tolerance = GRAB_PX / Math.max(viewport.scale.x, 1e-9);
    let best: { handle: CutLineHandle; side: 0 | 1 } | null = null;
    let bestDistance = tolerance;
    const st = useMazeStore.getState();
    for (const handle of activeCutLines(st)) {
      if (handle.mode !== "manual") continue;
      // Only the drawn part of a line can be grabbed: its stretch across the cells, not the infinite line.
      const drawn = drawnSideSpans(st, handle);
      for (const side of [0, 1] as const) {
        const distance = Math.min(Infinity, ...drawn[side].map(([from, to]) => distanceToSegment([pointer.x, pointer.y], from, to)));
        if (distance <= bestDistance) {
          best = { handle, side };
          bestDistance = distance;
        }
      }
    }
    return best;
  }
}
