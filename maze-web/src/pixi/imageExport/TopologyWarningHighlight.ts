import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import type { MazeStore } from "../../store/storeTypes";
import type { ViewportListener } from "../sceneTypes";
import { TopologyBandRenderer } from "../renderers/TopologyBandRenderer";
import { computeTopologyWarnings } from "../selectors/topologyWarnings";
import { watchStoreInputs } from "../storeWatch";
import { pointInPolygonBy } from "../tessellationGeometry";
import { resolveActiveCutPlan } from "./exportContent";
import type { ExportMargin } from "./exportMargins";
import type { CutPlan } from "./cutLines";
import { WARNING_HIGHLIGHT_COLOR } from "../renderConstants";

/// Corner radius (display units) of a highlighted warning polygon.
const POLYGON_HIGHLIGHT_RADIUS = 3;

/// What the highlight is drawn from: it redraws only when one of these changes.
function highlightInputs(st: MazeStore): readonly unknown[] {
  return [
    st.hoveredExportWarningKey, st.activeRenderMode, st.openCard, st.nodes, st.floors, st.activeFloorId, st.activeFieldConfig,
    st.floorTopology, st.floorCreases, st.pngExportSettings, st.vectorByWallsSettings, st.vectorByCorridorsSettings,
  ];
}

export type Shape = [number, number][];

/// Where the shape is drawn on the cut sheet: one copy per cut-plan offset, kept where the element itself shows (its centre
/// lies inside the sheet's region). The copies are whole, never clipped by the region. Without a plan, the shape itself.
export function drawnCopies(shape: Shape, plan: CutPlan | null): Shape[] {
  if (!plan) return [shape];
  return plan.offsets.flatMap(([dx, dy]) => {
    const copy = shape.map(([x, y]): [number, number] => [x + dx, y + dy]);
    const cx = copy.reduce((sum, p) => sum + p[0], 0) / copy.length;
    const cy = copy.reduce((sum, p) => sum + p[1], 0) / copy.length;
    return pointInPolygonBy(cx, cy, plan.region, (p) => p[0], (p) => p[1]) ? [copy] : [];
  });
}

/// Highlights the hovered topology warning (glue tabs, edge alignment marks: `computeTopologyWarnings`) on the canvas while
/// the Image Export card is open. These warnings concern the net itself, not the maze drawn on it, so unlike the maze
/// highlights of the mode renderers it is drawn over the whole canvas and is never clipped to the cut region. It does follow
/// the cut transfer: an element is drawn in every cut-plan copy that shows it (a half mark moved onto its twin line is
/// highlighted there), so the highlight sits on what is drawn, not where it came from. Lives in a viewport-synced layer
/// above the sheet, in display space.
export class TopologyWarningHighlight implements ViewportListener {
  private readonly polygons = new Graphics();
  private readonly bands: TopologyBandRenderer;
  private readonly unsubscribe: () => void;

  /// `getMargin` is the active mode's export margin, which the cut region keeps around the field.
  constructor(container: Container, private readonly getMargin: () => ExportMargin) {
    container.addChild(this.polygons);
    this.bands = new TopologyBandRenderer(container);
    this.unsubscribe = watchStoreInputs(highlightInputs, () => this.redraw());
  }

  onViewportChanged(): void {
    // Drawn in display space: a viewport move is done by the layer's transform.
  }

  private redraw(): void {
    this.polygons.clear();
    this.bands.render([]);
    const st = useMazeStore.getState();
    const mode = st.activeRenderMode;
    if (!mode || !st.hoveredExportWarningKey || st.openCard !== "image_export" || st.nodes.length === 0) return;
    const settings = mode === "vector_by_walls" ? st.vectorByWallsSettings : st.vectorByCorridorsSettings;
    const warning = computeTopologyWarnings(st, settings).find((w) => w.key === st.hoveredExportWarningKey);
    if (!warning) return;
    // Like the cell highlight: translucent fill plus an opaque 3px outline, a closed contour with rounded corners.
    const plan = resolveActiveCutPlan(st, this.getMargin);
    if (warning.polygons?.length) {
      for (const polygon of warning.polygons.flatMap((shape) => drawnCopies(shape, plan))) this.polygons.roundShape(polygon.map(([x, y]) => ({ x, y })), POLYGON_HIGHLIGHT_RADIUS).closePath();
      this.polygons.fill({ color: WARNING_HIGHLIGHT_COLOR, alpha: 0.25 });
      this.polygons.stroke({ width: 3, color: WARNING_HIGHLIGHT_COLOR, join: "round", cap: "round" });
    }
    if (warning.bands?.length) this.bands.render(warning.bands.flatMap((polyline) => drawnCopies(polyline, plan)).map((polyline) => ({ polyline, color: WARNING_HIGHLIGHT_COLOR })));
  }

  destroy(): void {
    this.unsubscribe();
    this.polygons.destroy();
    this.bands.destroy();
  }
}
