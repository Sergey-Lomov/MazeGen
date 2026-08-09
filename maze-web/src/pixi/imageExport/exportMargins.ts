import { useMazeStore } from "../../store/mazeStore";
import type { VectorByWallsSettings, RenderModeId } from "../../store/storeTypes";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorTokens";

/** World-space required margin around a maze's raw cell-boundary bounding box, per side — how far
 * a mode's own drawn geometry (walls, markers, indicators...) can visually extend past it. Not
 * necessarily symmetric for every mode (e.g. a future mode drawing a legend only on one side). */
export interface ExportMargin {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Exported so mode renderers with a trivially uniform margin (e.g. `VectorByCorridorsRenderer`'s
 * scaffolding zero) don't need to hand-build the `ExportMargin` shape themselves. */
export function uniform(v: number): ExportMargin {
  return { left: v, right: v, top: v, bottom: v };
}

/** Required export margin for the "Vector by walls" render mode — the widest visible stroke/
 * marker half-extent past a cell's raw boundary, across every `VectorByWallsSettings` field that
 * draws in world coordinates. Symmetric on every side for this mode today. Exported as a pure
 * function (not only reachable through a live `VectorByWallsRenderer` instance) so callers that
 * only need the number — e.g. the settings panel's live preview — never have to construct a Pixi
 * renderer just to read it; `VectorByWallsRenderer.getRequiredExportMargin()` delegates to this
 * same function. */
export function computeVectorByWallsExportMargin(settings: VectorByWallsSettings): ExportMargin {
  const wallHalf = settings.wallThickness / 2;
  const oneWayHalf = settings.oneWayGapWidth + settings.oneWaySize * TILE_SIZE + settings.oneWayThickness / 2;
  const startMarkerHalf = (settings.startMarker.size * TILE_SIZE) / 2 + settings.startMarker.borderWidth + settings.startMarker.gapWidth;
  const finishMarkerHalf = (settings.finishMarker.size * TILE_SIZE) / 2 + settings.finishMarker.borderWidth + settings.finishMarker.gapWidth;
  const teleportHalf = (settings.teleportLineSize * TILE_SIZE) / 2 + settings.teleportEdgeBorderWidth + settings.teleportEdgeGapWidth;
  const connectorHalf = settings.teleportConnectorWidth / 2 + settings.teleportConnectorGapWidth;

  return uniform(Math.max(wallHalf, oneWayHalf, startMarkerHalf, finishMarkerHalf, teleportHalf, connectorHalf));
}

/** Wall-only margin — how far a cell's own wall stroke extends past its raw boundary. Used by the
 * digital export's "edge to edge" canvas mode, which is meant to hug the walls tightly rather than
 * reserve room for markers/indicators that may not even be present in a given maze (unlike
 * `computeVectorByWallsExportMargin`, which sizes for whatever could be drawn). */
export function computeVectorByWallsWallMargin(settings: VectorByWallsSettings): ExportMargin {
  return uniform(settings.wallThickness / 2);
}

/** Resolves the export margin for a given render mode directly from store state — the
 * chiefly-functional counterpart to `modeRendererFactory.ts`'s `createModeRenderer`, minus any
 * Pixi/`Container` dependency. Callers needing a live preview (the export settings panel's
 * `useMemo`, re-evaluated on every settings change) use this instead of spinning up a temporary
 * renderer instance. `PngExporter` may use either this or the equivalent instance method — both
 * delegate to the same per-mode pure function, so they can never disagree. */
export function resolveExportMargin(mode: RenderModeId, state: Pick<ReturnType<typeof useMazeStore.getState>, "vectorByWallsSettings">): ExportMargin {
  switch (mode) {
    case "vector_by_walls":
      return computeVectorByWallsExportMargin(state.vectorByWallsSettings);
    case "vector_by_corridors":
      return uniform(0);
  }
}

/** Wall-only counterpart of `resolveExportMargin`, for the digital export's "edge to edge" canvas
 * mode — see `computeVectorByWallsWallMargin`. */
export function resolveWallExportMargin(mode: RenderModeId, state: Pick<ReturnType<typeof useMazeStore.getState>, "vectorByWallsSettings">): ExportMargin {
  switch (mode) {
    case "vector_by_walls":
      return computeVectorByWallsWallMargin(state.vectorByWallsSettings);
    case "vector_by_corridors":
      return uniform(0);
  }
}

/** Resolves the active render mode's own background fill color directly from store state — same
 * chiefly-functional counterpart-to-`createModeRenderer` pattern as `resolveExportMargin`, used by
 * `ExportFrameOverlay` to pick a frame color that stays visible against whatever's actually drawn
 * behind it (which may differ from the app's own dark canvas background — a mode's background is
 * user-editable, e.g. "Vector by walls"' white/light default for print). */
export function resolveBackgroundColor(mode: RenderModeId, state: Pick<ReturnType<typeof useMazeStore.getState>, "vectorByWallsSettings">): number {
  switch (mode) {
    case "vector_by_walls":
      return state.vectorByWallsSettings.background;
    case "vector_by_corridors":
      return canvas.stage.background;
  }
}
