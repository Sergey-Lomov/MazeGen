import { useMazeStore } from "../../store/mazeStore";
import type { VectorByWallsSettings, VectorByCorridorsSettings, TeleportSettingsFields, RenderModeId, MarkerSettings } from "../../store/storeTypes";
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
 * corridor-stroke-half-width margin) don't need to hand-build the `ExportMargin` shape themselves. */
export function uniform(v: number): ExportMargin {
  return { left: v, right: v, top: v, bottom: v };
}

/** A marker's own visible half-extent past its center — `size` (fraction of `TILE_SIZE`) plus
 * border/gap width, optionally with extra padding on top (e.g. `VectorByCorridorsSettings`'
 * `markerWidenPadding`, whose widen-patch geometry extends past the marker's own footprint).
 * Shared by both modes' export-margin calculations so the footprint formula can't drift between
 * them. */
function markerFootprintHalf(marker: MarkerSettings, extraPadding = 0): number {
  return (marker.size * TILE_SIZE) / 2 + marker.borderWidth + marker.gapWidth + extraPadding;
}

/** A teleport marker/connector's own widest visible half-extent past its center, from a
 * `TeleportSettingsFields` slice — shared by both modes' export-margin calculations (GitHub issue
 * #313) since `VectorByWallsSettings` and `VectorByCorridorsSettings` both `extends` the same
 * teleport field set and now both actually draw teleports via `TeleportRenderer`. */
function teleportFootprintHalf(settings: TeleportSettingsFields): number {
  const markerHalf = (settings.teleportLineSize * TILE_SIZE) / 2 + settings.teleportEdgeBorderWidth + settings.teleportEdgeGapWidth;
  const connectorHalf = settings.teleportConnectorWidth / 2 + settings.teleportConnectorGapWidth;
  return Math.max(markerHalf, connectorHalf);
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
  const startMarkerHalf = markerFootprintHalf(settings.startMarker);
  const finishMarkerHalf = markerFootprintHalf(settings.finishMarker);

  return uniform(Math.max(wallHalf, oneWayHalf, startMarkerHalf, finishMarkerHalf, teleportFootprintHalf(settings)));
}

/** Wall-only margin — how far a cell's own wall stroke extends past its raw boundary. Used by the
 * digital export's "edge to edge" canvas mode, which is meant to hug the walls tightly rather than
 * reserve room for markers/indicators that may not even be present in a given maze (unlike
 * `computeVectorByWallsExportMargin`, which sizes for whatever could be drawn). */
export function computeVectorByWallsWallMargin(settings: VectorByWallsSettings): ExportMargin {
  return uniform(settings.wallThickness / 2);
}

/** Required export margin for "Vector by corridors" — the widest of half the corridor stroke's own
 * width, a start/finish marker's own widen-patch footprint (`markerWidenPadding` included, since
 * that's the actual geometry drawn — see `drawMarkerWidenPatches`) (GitHub issue #310, markers
 * added in #311) and a teleport marker/connector's own footprint (GitHub issue #313). Same
 * "always pure function" rationale as `computeVectorByWallsExportMargin`. */
export function computeVectorByCorridorsExportMargin(settings: VectorByCorridorsSettings): ExportMargin {
  const corridorHalf = settings.thickness / 2;
  const startMarkerHalf = markerFootprintHalf(settings.startMarker, settings.markerWidenPadding);
  const finishMarkerHalf = markerFootprintHalf(settings.finishMarker, settings.markerWidenPadding);
  return uniform(Math.max(corridorHalf, startMarkerHalf, finishMarkerHalf, teleportFootprintHalf(settings)));
}

/** Resolves the export margin for a given render mode directly from store state — the
 * chiefly-functional counterpart to `modeRendererFactory.ts`'s `createModeRenderer`, minus any
 * Pixi/`Container` dependency. Callers needing a live preview (the export settings panel's
 * `useMemo`, re-evaluated on every settings change) use this instead of spinning up a temporary
 * renderer instance. `PngExporter` may use either this or the equivalent instance method — both
 * delegate to the same per-mode pure function, so they can never disagree. */
export function resolveExportMargin(mode: RenderModeId, state: Pick<ReturnType<typeof useMazeStore.getState>, "vectorByWallsSettings" | "vectorByCorridorsSettings">): ExportMargin {
  switch (mode) {
    case "vector_by_walls":
      return computeVectorByWallsExportMargin(state.vectorByWallsSettings);
    case "vector_by_corridors":
      return computeVectorByCorridorsExportMargin(state.vectorByCorridorsSettings);
  }
}

/** Wall-only counterpart of `resolveExportMargin`, for the digital export's "edge to edge" canvas
 * mode — see `computeVectorByWallsWallMargin`. "Vector by corridors" has no separate wall stroke
 * (the corridor stroke itself is the only line-work), so its wall-only margin is the same as its
 * full margin. */
export function resolveWallExportMargin(mode: RenderModeId, state: Pick<ReturnType<typeof useMazeStore.getState>, "vectorByWallsSettings" | "vectorByCorridorsSettings">): ExportMargin {
  switch (mode) {
    case "vector_by_walls":
      return computeVectorByWallsWallMargin(state.vectorByWallsSettings);
    case "vector_by_corridors":
      return computeVectorByCorridorsExportMargin(state.vectorByCorridorsSettings);
  }
}

/** Resolves the active render mode's own background fill color directly from store state — same
 * chiefly-functional counterpart-to-`createModeRenderer` pattern as `resolveExportMargin`, used by
 * `ExportFrameOverlay` to pick a frame color that stays visible against whatever's actually drawn
 * behind it (which may differ from the app's own dark canvas background — a mode's background is
 * user-editable, e.g. "Vector by walls"' white/light default for print). "Vector by corridors" has
 * no user-configurable background yet (a follow-up sub-issue's concern), so it always resolves to
 * the fixed editor canvas background. */
export function resolveBackgroundColor(mode: RenderModeId, state: Pick<ReturnType<typeof useMazeStore.getState>, "vectorByWallsSettings" | "vectorByCorridorsSettings">): number {
  switch (mode) {
    case "vector_by_walls":
      return state.vectorByWallsSettings.background;
    case "vector_by_corridors":
      return canvas.stage.background;
  }
}
