import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import type { MazeStore } from "../../store/storeTypes";
import type { ViewportListener } from "../sceneTypes";
import { watchStoreInputs } from "../storeWatch";
import { creaseStyleOf, drawExportCreases, selectExportCreases, shiftCreases } from "./creaseExport";
import { drawExportEdgeMarkers, edgeMarkerStyleOf, selectExportEdgeMarkers, shiftEdgeMarkers } from "./edgeMarkerExport";
import { resolveActiveCutPlan } from "./exportContent";
import type { ExportMargin } from "./exportMargins";

/// What the overlay is drawn from: it redraws only when one of these changes.
function creaseOverlayInputs(st: MazeStore): readonly unknown[] {
  const mode = st.activeRenderMode;
  return [
    mode, st.openCard, st.nodes, st.floors, st.activeFloorId, st.activeFieldConfig, st.floorFields[st.activeFloorId],
    st.floorCreases[st.activeFloorId], st.floorTopology, st.pngExportSettings.cuts, mode ? creaseStyleOf(st, mode) : null,
    // The mode's margin, which the cut region keeps around the field, follows its settings.
    st.vectorByWallsSettings, st.vectorByCorridorsSettings,
  ];
}

/// Draws the crease lines of the active floor on the canvas while the Image Export card is open (GitHub issue #900),
/// as the active render mode's crease style shows them on the image: once per cut-plan copy, clipped to the cut region,
/// like the content. Lives in a viewport-synced layer, so it draws in display space.
export class CreaseExportOverlay implements ViewportListener {
  private readonly graphics = new Graphics();
  private readonly mask = new Graphics();
  private readonly unsubscribe: () => void;

  /// `getMargin` is the active mode's export margin, which the cut region keeps around the field.
  constructor(container: Container, private readonly getMargin: () => ExportMargin) {
    container.addChild(this.mask);
    container.addChild(this.graphics);
    this.unsubscribe = watchStoreInputs(creaseOverlayInputs, () => this.redraw());
  }

  onViewportChanged(): void {
    // Drawn in display space: a viewport move is done by the layer's transform.
  }

  private redraw(): void {
    const g = this.graphics;
    g.clear();
    this.mask.clear();
    g.mask = null;
    const st = useMazeStore.getState();
    const mode = st.activeRenderMode;
    if (!mode || st.openCard !== "image_export" || st.nodes.length === 0) return;
    const style = creaseStyleOf(st, mode);
    const creases = selectExportCreases(st, style);
    const markerStyle = edgeMarkerStyleOf(st, mode);
    const markers = selectExportEdgeMarkers(st, markerStyle);
    if (creases.length === 0 && markers.length === 0) return;
    const plan = resolveActiveCutPlan(st, this.getMargin);
    if (!plan) {
      if (creases.length > 0) drawExportCreases(g, creases, style);
      drawExportEdgeMarkers(g, markers, markerStyle);
      return;
    }
    this.mask.poly(plan.region.flat()).fill(0xffffff);
    g.mask = this.mask;
    if (creases.length > 0) drawExportCreases(g, plan.offsets.flatMap((offset) => shiftCreases(creases, offset)), style);
    drawExportEdgeMarkers(g, plan.offsets.flatMap((offset) => shiftEdgeMarkers(markers, offset)), markerStyle);
  }

  destroy(): void {
    this.unsubscribe();
    this.graphics.mask = null;
    this.graphics.destroy();
    this.mask.destroy();
  }
}
