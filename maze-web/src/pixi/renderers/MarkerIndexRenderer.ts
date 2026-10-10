import { Container, Graphics } from "pixi.js";
import type { MarkerIndexSettings } from "../../store/imageExportTypes";
import type { MarkerIndexLabel } from "../selectors/mazeSelectors/markerIndex";
import { makeCenteredLabel, msdfFontFamily } from "./msdfFont";
import { drawRoundedRect } from "./markerShapes";

export interface MarkerIndexRenderData {
  labels: MarkerIndexLabel[];
  style: MarkerIndexSettings;
  /** Floor color — the plate's gap ring (`style.gap`, whole pixels) is drawn in it, same
   *  convention as every other marker gap ring: it reads as a cut-out of the floor. */
  floorColor: number;
}

/** Geometry of one plate, shared between the gap pass and the body pass. */
interface PlateBox {
  x: number;
  y: number;
  w: number;
  h: number;
  cornerRadius: number;
  borderColor: number;
  borderWidth: number;
}

/** "Marker indices" layer (GitHub issue #471) — draws a rectangular framed plate carrying a
 *  shared index under each cross-floor connection marker, so a player matching per-floor export
 *  images can tell where every staircase, elevator and teleport leads.
 *
 *  Draws into **two** caller-supplied containers so the draw order is: every plate's gap ring,
 *  then (by the caller) the connection markers, then every plate body. The plate's gap ring thus
 *  ends up *under* the marker it hangs off and never occludes it, even when `offset` is small
 *  enough that the plate overlaps the marker.
 *
 *  The plate is a fixed `style.width` x `style.height` rectangle (GitHub issue #725), so a given
 *  index looks identical on every floor; the label uses `style.textSize` and may overflow the
 *  plate (reported by the `marker_index_text_overflow` export warning). */
export class MarkerIndexRenderer {
  private readonly gapLayer: Container;
  private readonly bodyLayer: Container;

  /** @param gapContainer  a layer the caller places *below* the connection markers.
   *  @param bodyContainer a layer the caller places *above* the connection markers. */
  constructor(gapContainer: Container, bodyContainer: Container) {
    this.gapLayer = new Container();
    gapContainer.addChild(this.gapLayer);
    this.bodyLayer = new Container();
    bodyContainer.addChild(this.bodyLayer);
  }

  /** Removes every drawn plate without rebuilding — used when the feature is toggled off. */
  clear(): void {
    this.gapLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.bodyLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
  }

  render(data: MarkerIndexRenderData): void {
    this.clear();
    const { labels, style, floorColor } = data;
    if (!style.enabled || labels.length === 0) return;

    const plateW = style.width;
    const plateH = style.height;
    const cornerRadius = style.cornerRadius;
    const gap = Math.max(0, style.gap);
    const fontSize = style.textSize;
    const fontFamily = msdfFontFamily(style.textFontWeight);

    const boxes: PlateBox[] = labels.map((item) => {
      const [cx, cy] = item.pos;
      // `offset` is the distance from the marker's outer edge to the plate's *center*.
      const plateCenterY = cy + item.markerOuterRadius + style.offset;
      const borderColor = style.borderColorFromMarker ? item.borderMatchColor : style.borderColor;
      return {
        x: cx - plateW / 2,
        y: plateCenterY - plateH / 2,
        w: plateW,
        h: plateH,
        cornerRadius,
        borderColor,
        borderWidth: Math.max(0, Math.round(style.borderWidthFromMarker ? item.markerBorderWidth : style.borderWidth)),
      };
    });

    // Pass 1 — gap rings (below the markers). A single outset rounded-rect fill in the floor
    // color, so the plate reads as a cut-out of the floor exactly like every other marker gap.
    // The ring wraps the plate's *outer* edge. Marker borders use a geometric outward offset,
    // so the plate uses the same full-width offset convention.
    if (gap > 0) {
      for (const b of boxes) {
        const outset = gap + b.borderWidth;
        const g = new Graphics();
        drawRoundedRect(g, b.x - outset, b.y - outset, b.w + 2 * outset, b.h + 2 * outset, b.cornerRadius + outset);
        g.fill(floorColor);
        this.gapLayer.addChild(g);
      }
    }

    // Pass 2 — plate bodies + labels (above the markers).
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const g = new Graphics();
      if (b.borderWidth > 0) {
        drawRoundedRect(g, b.x - b.borderWidth, b.y - b.borderWidth, b.w + 2 * b.borderWidth, b.h + 2 * b.borderWidth, b.cornerRadius + b.borderWidth);
        g.fill(b.borderColor);
      }
      drawRoundedRect(g, b.x, b.y, b.w, b.h, b.cornerRadius);
      g.fill(style.fillColor);
      this.bodyLayer.addChild(g);

      const text = makeCenteredLabel(labels[i].label, fontFamily, fontSize, style.textColor);
      text.x = b.x + b.w / 2;
      text.y = b.y + b.h / 2;
      this.bodyLayer.addChild(text);
    }
  }

  destroy(): void {
    this.clear();
    this.gapLayer.destroy({ children: true });
    this.bodyLayer.destroy({ children: true });
  }
}
