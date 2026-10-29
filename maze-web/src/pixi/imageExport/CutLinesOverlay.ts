import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import type { ViewportListener } from "../sceneTypes";
import { glueColor } from "../renderers/SeamArrowRenderer";
import { selectActiveSeamArrows } from "../selectors/seamHop";
import { selectSeamArrowData } from "../seamArrowSync";
import { activeCutLines, cutEditingActive } from "./CutLineDragController";
import { cutLineColors, cutLineStyleOf } from "./cutLineStyle";
import { clipSpans, cutLineSides, lineInside, type Vec2 } from "./cutLines";
import { drawnSideSpans } from "./cutLineSpans";

const LINE_PX = 2;
const HOVER_LINE_PX = 4;
const DASH_PX = 10;
const GAP_PX = 6;
/** Colour of a cut line whose glue has no arrow to take a colour from. */
const FALLBACK_COLOR = 0x888888;

/** Draws the cut lines of the active floor on the editor canvas (GitHub issue #859): dashed, on both sides of the seam so
 * it reads how the sheet glues. While the export topology panel is open they take the colour of their glue; otherwise they
 * appear as the render mode's cut-line style draws them on the image. Lives in a viewport-synced layer, so it draws in display space. */
export class CutLinesOverlay implements ViewportListener {
  private readonly graphics = new Graphics();
  private view = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private readonly unsubscribe: () => void;

  constructor(container: Container) {
    container.addChild(this.graphics);
    this.unsubscribe = useMazeStore.subscribe(() => this.redraw());
    this.redraw();
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.view = { x, y, w, h, scale };
    this.redraw();
  }

  /** The visible part of the canvas in display space: a dashed line is drawn only over it. */
  private visibleRect(): Vec2[] {
    const { x, y, w, h, scale } = this.view;
    const k = Math.max(scale, 1e-9);
    const [x0, y0, x1, y1] = [-x / k, -y / k, (w - x) / k, (h - y) / k];
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }

  private redraw(): void {
    const g = this.graphics;
    g.clear();
    const st = useMazeStore.getState();
    const editing = cutEditingActive(st);
    const mode = st.activeRenderMode;
    const style = mode ? cutLineStyleOf(st, mode) : null;
    // Out of the topology panel the lines are part of the picture, as the style of the render mode draws them.
    const onImage = !editing && style !== null && style.showCutLines && st.openCard === "image_export" && st.nodes.length > 0;
    if (!editing && !onImage) return;
    const imageColor = onImage ? cutLineColors(style, st.activeFieldConfig, st.floorTopology[st.activeFloorId]) : null;
    const arrows = selectActiveSeamArrows(st);
    // The glue in focus, from the panel or from the pointer over its arrow.
    const focus = selectSeamArrowData(st).focus;
    const focusedGroup = focus ? arrows[focus.arrow]?.group ?? null : null;
    const visible = this.visibleRect();
    const scale = Math.max(this.view.scale, 1e-9);

    for (const handle of activeCutLines(st)) {
      const { group, line } = handle;
      const index = arrows.findIndex((arrow) => arrow.group === group);
      const hovered = editing && group === focusedGroup;
      const color = imageColor ? imageColor(group) : index < 0 ? FALLBACK_COLOR : glueColor(index, arrows.length, hovered);
      // Only over the image: the twin shows the halves that moved over, so it has image where the line cuts a tile.
      const drawn = drawnSideSpans(st, handle);
      cutLineSides(line).forEach((through, side) => {
        const spans = drawn[side];
        for (const [from, to] of clipSpans(spans, lineInside(visible, through, line.cut.direction), line.cut.direction)) {
          dashedLine(g, from, to, through, DASH_PX / scale, GAP_PX / scale);
        }
      });
      g.stroke({ width: (hovered ? HOVER_LINE_PX : LINE_PX) / scale, color });
    }
  }

  destroy(): void {
    this.unsubscribe();
    this.graphics.destroy();
  }
}

/** Dashes are phased from `anchor` (a fixed point of the line), not from the clipped segment's start, so they stay put while the view moves. */
function dashedLine(g: Graphics, from: Vec2, to: Vec2, anchor: Vec2, dash: number, gap: number): void {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (length === 0) return;
  const ux = (to[0] - from[0]) / length;
  const uy = (to[1] - from[1]) / length;
  const period = dash + gap;
  const offset = (from[0] - anchor[0]) * ux + (from[1] - anchor[1]) * uy;
  for (let at = Math.floor(offset / period) * period - offset; at < length; at += period) {
    const start = Math.max(at, 0);
    const end = Math.min(at + dash, length);
    if (end <= start) continue;
    g.moveTo(from[0] + ux * start, from[1] + uy * start);
    g.lineTo(from[0] + ux * end, from[1] + uy * end);
  }
}
