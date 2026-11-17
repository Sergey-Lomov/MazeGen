import { Container, Graphics } from "pixi.js";
import type { GlueTabStyle } from "../../store/imageExportTypes";
import type { GlueTab } from "../imageExport/glueTabExport";

/// Points closer than this (display units) are one point.
const EPS = 1e-6;
/// Dash length and gap, in outline widths.
const DASH_FACTOR = 4;

/// Glue tabs of the export (GitHub issue #901): trapezoids with a fill and an outline (solid, dashed or none), opaque and
/// sized in display units, so they zoom with the field. The geometry comes from `selectExportGlueTabs`.
export class GlueTabRenderer {
  private readonly g = new Graphics();

  constructor(container: Container) {
    container.addChild(this.g);
  }

  render(tabs: readonly GlueTab[], style: GlueTabStyle): void {
    const g = this.g;
    g.clear();
    if (tabs.length === 0) return;
    for (const tab of tabs) g.poly(tab.flat());
    g.fill({ color: style.fillColor });
    if (style.lineWidth <= 0) return;
    // The base lies along the maze's own cell face, so the outline runs over the other three sides only.
    const stroke = { width: style.lineWidth, color: style.lineColor, join: "round" as const };
    const dash = Math.max(style.lineWidth * DASH_FACTOR, 1);
    for (const [a, b, c, d] of tabs) {
      const outline = [b, c, d, a];
      if (style.lineStyle === "solid") {
        g.moveTo(outline[0][0], outline[0][1]);
        for (const p of outline.slice(1)) g.lineTo(p[0], p[1]);
      } else {
        this.dashPath(outline, dash, dash);
      }
    }
    g.stroke(stroke);
  }

  /// Adds the open path through `points` as dashes of `dash` display units with `gap` between them.
  private dashPath(points: readonly (readonly [number, number])[], dash: number, gap: number): void {
    let drawing = true;
    let left = dash;
    for (let i = 0; i + 1 < points.length; i++) {
      const from = points[i];
      const to = points[i + 1];
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      if (length === 0) continue;
      const ux = (to[0] - from[0]) / length;
      const uy = (to[1] - from[1]) / length;
      let at = 0;
      while (at < length) {
        const step = Math.min(left, length - at);
        const x0 = from[0] + ux * at;
        const y0 = from[1] + uy * at;
        if (drawing) this.g.moveTo(x0, y0).lineTo(x0 + ux * step, y0 + uy * step);
        at += step;
        left -= step;
        if (left <= EPS) {
          drawing = !drawing;
          left = drawing ? dash : gap;
        }
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
