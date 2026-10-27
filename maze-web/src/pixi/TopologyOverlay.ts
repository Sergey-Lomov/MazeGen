import { Container, Graphics } from "pixi.js";
import type { FieldConfig } from "../fieldConfig";
import type { WireFoldEnd } from "../wasm/types";
import { useMazeStore } from "../store/mazeStore";
import { floorTopologyInfo, selectionRun } from "../store/topologyInfo";
import { canvas } from "./colorTokens";
import { getCellHighlightInset } from "./cellHighlightGeometry";
import { drawRoundedPolygon } from "./renderers/markerShapes";
import { offsetPolyline, polylineLength, trimPolyline } from "./geometry/polylineOps";
import { WALL_THICKNESS } from "./renderConstants";
import { WALL_HIGHLIGHT_SPAN } from "./renderers/wallUtils";
import { mergedFacePolylines } from "./topologyGeometry";
import type { ViewportListener } from "./sceneTypes";

type StoreState = ReturnType<typeof useMazeStore.getState>;

/** The boundary highlight band the other edge highlights use (`drawCellBoundaryHighlight`: a
 * rounded quad of `WALL_HIGHLIGHT_SPAN`, pulled back from the ends by the cell highlight inset,
 * filled at 0.25 with a `WALL_THICKNESS` border), built on an arbitrary polyline so consecutive
 * faces form one band. A boundary face has no second cell, so the shared-edge helper cannot be
 * used directly. */
function drawPolylineBand(g: Graphics, polyline: [number, number][], color: number): void {
  const length = polylineLength(polyline);
  if (length === 0) return;
  const inset = Math.max(0, Math.min(getCellHighlightInset(), length / 2 - 1));
  const trimmed = trimPolyline(polyline, inset, length - inset);
  if (trimmed.length < 2) return;
  const half = WALL_HIGHLIGHT_SPAN / 2;
  const points = [...offsetPolyline(trimmed, half), ...offsetPolyline(trimmed, -half).reverse()].flat();
  const radius = Math.min(polylineLength(trimmed), WALL_HIGHLIGHT_SPAN) * 0.18;
  drawRoundedPolygon(g, points, radius);
  g.fill({ color, alpha: 0.25 });
  drawRoundedPolygon(g, points, radius);
  g.stroke({ color, alpha: 1, width: WALL_THICKNESS, join: "round" });
}

/** Canvas layer of the topology editor (GitHub issue #839), hosted above the walls it marks: the
 * faces of the glue or pair hovered in the panel, and the runs being picked for a new glue. Both
 * use the ordinary edge highlight band (run A and run B each in their own colour, the same for a hovered glue's
 * two sides). Everything is read from the store and core's contours; nothing is derived from
 * coordinates. */
export class TopologyOverlay implements ViewportListener {
  private readonly graphics = new Graphics();
  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    container.addChild(this.graphics);
    this.unsubscribe = useMazeStore.subscribe((state, prev) => {
      if (state.openCard !== "field_setup") {
        if (prev.openCard === "field_setup") this.graphics.clear();
        return;
      }
      const field = state.floorFields[state.activeFloorId];
      const prevField = prev.floorFields[prev.activeFloorId];
      if (
        state.openCard !== prev.openCard
        || state.activeFloorId !== prev.activeFloorId
        || state.floorTopology !== prev.floorTopology
        || state.topologyRunA !== prev.topologyRunA
        || state.topologyRunB !== prev.topologyRunB
        || state.topologyHover !== prev.topologyHover
        || state.topologyFaceHover !== prev.topologyFaceHover
        || state.topologyFlagged !== prev.topologyFlagged
        || state.topologySideHover !== prev.topologySideHover
        || field?.fieldConfig !== prevField?.fieldConfig
        || field?.fieldPoints !== prevField?.fieldPoints
      ) this.redraw(state);
    });
  }

  onViewportChanged(): void {
    const state = useMazeStore.getState();
    if (state.openCard === "field_setup") this.redraw(state);
  }

  private redraw(state: StoreState): void {
    const g = this.graphics;
    g.clear();
    const floor = state.activeFloorId;
    const field = state.floorFields[floor];
    const result = floorTopologyInfo(state, floor);
    if (!result.ok || !field) return;
    const cfg: FieldConfig = field.fieldConfig;
    const { info } = result;
    const topology = state.floorTopology[floor];

    const band = (ends: readonly WireFoldEnd[], color: number) => {
      for (const polyline of mergedFacePolylines(ends, info.contours, cfg)) drawPolylineBand(g, polyline, color);
    };

    const hover = state.topologyHover;
    if (topology && hover !== null) {
      const indices = hover.fold !== null
        ? [hover.fold]
        : topology.groups.find((candidate) => candidate.id === hover.glue)?.folds ?? [];
      const folds = indices.flatMap((index) => topology.folds[index] ? [topology.folds[index]] : []);
      band(folds.map((fold) => fold.a), canvas.topology.runA);
      band(folds.map((fold) => fold.b), canvas.topology.runB);
    }
    const faceHover = state.topologyFaceHover;
    if (faceHover !== null && state.topologyPick !== null) {
      const face = info.contours[faceHover.contour]?.[faceHover.face];
      if (face) band([face], state.topologyPick === "a" ? canvas.topology.runA : canvas.topology.runB);
    }
    // A hovered side or pair stands alone: the highlight of the whole runs is hidden meanwhile.
    const isolated = state.topologySideHover !== null || (hover !== null && hover.fold !== null);
    if (!isolated) {
      for (const [selection, color] of [[state.topologyRunA, canvas.topology.runA], [state.topologyRunB, canvas.topology.runB]] as const) {
        const run = selectionRun(selection, info.contours);
        if (run) band(run, color);
      }
    }
    const sideHover = state.topologySideHover;
    if (sideHover !== null) {
      band(sideHover.a, canvas.topology.runA);
      band(sideHover.b, canvas.topology.runB);
    }
    // Last, so a flagged side reads red over the highlight of the run it belongs to.
    if (state.topologyFlagged.length > 0) band(state.topologyFlagged, canvas.topology.flagged);
  }

  destroy(): void {
    this.unsubscribe?.();
    this.graphics.destroy();
  }
}
