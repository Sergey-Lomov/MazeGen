import type { Container } from "pixi.js";
import type { RenderModeId } from "../../store/storeTypes";
import { useMazeStore } from "../../store/mazeStore";
import type { ContentBoundsBasis } from "./contentBounds";

/** Axis-aligned bbox shape shared by pixi's own `Bounds` and the plain `{minX,minY,maxX,maxY}`
 * objects `exactCellBounds`/`cellCenterBounds` return — `measureContentMargin`'s `cellBounds` param
 * only ever reads these four fields, so it accepts either without needing a full pixi `Bounds`. */
interface AxisAlignedBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** World-space required margin around a maze's raw cell-boundary bounding box, per side — how far
 * a mode's own drawn geometry (walls, markers, indicators...) actually extends past it, on this
 * specific maze. Not necessarily symmetric (e.g. a start marker sitting only on the maze's top
 * edge widens `top` alone). Every `ModeRenderer.getRequiredExportMargin()` (GitHub issue #324
 * follow-up) measures this directly off the mode's own already-rendered content
 * (`Container.getLocalBounds()`) rather than approximating it from settings — see
 * `VectorByWallsRenderer`'s/`VectorByCorridorsRenderer`'s own `getRequiredExportMargin` doc
 * comments for why a single pixel-accurate method now serves every canvas-fit mode
 * (`edge_to_edge`, `margin_px`/`margin_cells`, `fixed_size`, print) with no separate "settings-only
 * worst case" or "wall-only vs. full" variant needed anywhere. */
export interface ExportMargin {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Which raw bbox (`ContentBoundsBasis`) a render mode's own drawn content is measured against
 * before its `ExportMargin` is derived from it — `"cell"` for a mode whose content reaches the
 * cell's own polygon boundary ("Vector by walls"' floor fill/wall stroke sit on the cell face),
 * `"center"` for one whose content stops at the cell center ("Vector by corridors": a line runs
 * cell-center to cell-center, so a border cell's own segment never reaches the tile edge — GitHub
 * issue #324). Purely a choice of reference frame for `contentWorldBounds`'s `basis` param — it
 * does not affect how big the margin itself is, only what it's measured relative to. */
export function resolveContentBoundsBasis(mode: RenderModeId): ContentBoundsBasis {
  switch (mode) {
    case "vector_by_walls":
      return "cell";
    case "vector_by_corridors":
      return "center";
  }
}

/** Resolves the active render mode's own background fill color directly from store state —
 * used by `ExportFrameOverlay` to pick a frame color that stays visible against whatever's
 * actually drawn behind it (which may differ from the app's own dark canvas background — a
 * mode's background is user-editable, e.g. "Vector by walls"' white/light default for print).
 * "Vector by corridors" has its own user-configurable background too (GitHub issue #309), same
 * field/default as "Vector by walls". */
export function resolveBackgroundColor(mode: RenderModeId, state: Pick<ReturnType<typeof useMazeStore.getState>, "vectorByWallsSettings" | "vectorByCorridorsSettings">): number {
  switch (mode) {
    case "vector_by_walls":
      return state.vectorByWallsSettings.background;
    case "vector_by_corridors":
      return state.vectorByCorridorsSettings.background;
  }
}

/** Shared body of every `ModeRenderer.getRequiredExportMargin()` (GitHub issue #324 follow-up):
 * unions the world-space local bounds of a mode's own content containers, then diffs that against
 * the maze's raw cell-boundary bbox (`cellBounds`) to get a per-side pixel-accurate margin. Each
 * mode supplies its own content-container list (which layers count as "drawn content" differs per
 * mode) and its own `cellBounds` basis (`exactCellBounds` vs. `cellCenterBounds`) — see
 * `resolveContentBoundsBasis`'s doc comment for why that basis differs. */
export function measureContentMargin(contentContainers: Container[], cellBounds: AxisAlignedBounds): ExportMargin {
  const [first, ...rest] = contentContainers;
  const contentBounds = first.getLocalBounds().clone();
  for (const container of rest) {
    contentBounds.addBounds(container.getLocalBounds());
  }

  return {
    left: cellBounds.minX - contentBounds.minX,
    top: cellBounds.minY - contentBounds.minY,
    right: contentBounds.maxX - cellBounds.maxX,
    bottom: contentBounds.maxY - cellBounds.maxY,
  };
}
