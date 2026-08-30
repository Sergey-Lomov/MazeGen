import { CanvasTextMetrics, Container, Graphics, Text, TextStyle } from "pixi.js";
import type { MarkerIndexSettings } from "../../store/imageExportTypes";
import type { MarkerIndexLabel } from "../selectors/mazeSelectors/markerIndex";
import { TILE_SIZE } from "../constants";
import { LABEL_FONT_WEIGHTS } from "./indexLabel";

/** Fraction of the plate's height the label text occupies (the rest is vertical padding). Chosen
 *  so the tallest glyphs ("VIII", "W") clear the plate edges with a small margin. */
const TEXT_HEIGHT_FRACTION = 0.72;

/** Font size for a marker-index label plate of `plateHeightPx`. Pure function of the plate height
 *  — width is handled separately (the plate is sized to the widest label). */
export function fitMarkerIndexFontSize(plateHeightPx: number): number {
  return Math.max(1, plateHeightPx * TEXT_HEIGHT_FRACTION);
}

export interface MarkerIndexRenderData {
  labels: MarkerIndexLabel[];
  allLabelStrings: string[];
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
 *  The plate width is uniform across the whole project (sized to the widest label in
 *  `allLabelStrings`), so a given index looks identical on every floor. */
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
    const { labels, allLabelStrings, style, floorColor } = data;
    if (!style.enabled || labels.length === 0) return;

    const plateH = style.height * TILE_SIZE;
    const paddingX = style.paddingX * TILE_SIZE;
    const cornerRadius = style.cornerRadius * TILE_SIZE;
    const gap = Math.max(0, style.gap);
    const borderWidth = Math.max(0, Math.round(style.borderWidth));
    const fontSize = fitMarkerIndexFontSize(plateH);
    const fontWeight = LABEL_FONT_WEIGHTS[style.fontWeight];

    const measureStyle = new TextStyle({ fontSize, fontWeight, trim: true });
    let widestText = 0;
    for (const s of allLabelStrings) {
      widestText = Math.max(widestText, CanvasTextMetrics.measureText(s, measureStyle).width);
    }
    const plateW = widestText + 2 * paddingX;

    const boxes: PlateBox[] = labels.map((item) => {
      const [cx, cy] = item.pos;
      // `offset` is the distance from the marker's outer edge to the plate's *center*.
      const plateCenterY = cy + item.markerOuterRadius + style.offset * TILE_SIZE;
      const borderColor = style.borderColorFromMarker ? item.borderMatchColor : style.borderColor;
      return {
        x: cx - plateW / 2,
        y: plateCenterY - plateH / 2,
        w: plateW,
        h: plateH,
        cornerRadius,
        borderColor,
      };
    });

    // Pass 1 — gap rings (below the markers). A single outset rounded-rect fill in the floor
    // color, so the plate reads as a cut-out of the floor exactly like every other marker gap.
    // The ring wraps the plate's *outer* edge — the border stroke is centered on the box edge,
    // so it sticks out `borderWidth / 2` beyond it; the ring starts from there.
    if (gap > 0) {
      const outset = gap + (borderWidth > 0 ? borderWidth / 2 : 0);
      for (const b of boxes) {
        const g = new Graphics();
        g.roundRect(b.x - outset, b.y - outset, b.w + 2 * outset, b.h + 2 * outset, b.cornerRadius + outset)
          .fill(floorColor);
        this.gapLayer.addChild(g);
      }
    }

    // Pass 2 — plate bodies + labels (above the markers).
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const g = new Graphics();
      g.roundRect(b.x, b.y, b.w, b.h, b.cornerRadius).fill(style.fillColor);
      if (borderWidth > 0) g.stroke({ color: b.borderColor, width: borderWidth });
      this.bodyLayer.addChild(g);

      const text = new Text({
        text: labels[i].label,
        style: { fontSize, fill: style.textColor, fontWeight, trim: true },
        resolution: 4,
      });
      text.anchor.set(0.5);
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
