import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import { buildCorridorSegments, buildMazeMarkers } from "../selectors/mazeSelectors";
import { chainSegmentsAtSharedVertices } from "../renderers/WallRenderer";
import { WaypointsRenderer } from "../renderers/WaypointsRenderer";
import { drawMarkerWidenPatches } from "../renderers/markerWidenPatches";
import { resolveEffectiveEndpoints, buildMarkerStyle } from "./VectorByWallsRenderer";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { canvas } from "../colorTokens";
import type { ModeRenderer } from "./modeRendererFactory";
import { computeVectorByCorridorsExportMargin, type ExportMargin } from "./exportMargins";

/** "Vector by corridors" render mode's own renderer (GitHub issue #310) — draws every basic
 * passage between geometrically adjacent cells as a stroked line between their centers
 * (`buildCorridorSegments`), the inverse of "Vector by walls"' "gap in the wall" reading. Per
 * `maze-web/CLAUDE.md`'s feature-renderer ownership rule: its own `Container` and its own
 * `Graphics`, never shared with `VectorByWallsRenderer` or any other feature's renderer. Split
 * points and teleport edges are skipped entirely — their own follow-up sub-issues, same as
 * `VectorByCorridorsSettings`' own doc comment. */
export class VectorByCorridorsRenderer implements ModeRenderer {
  private readonly corridorsContainer: Container;
  private readonly corridors: Graphics;
  private readonly markersContainer: Container;
  private readonly markers: WaypointsRenderer;

  private unsubscribe: (() => void) | null = null;

  private geometryCache: {
    nodes: NodeDto[];
    edges: EdgeDto[];
    cfg: TessellationConfig;
    segments: { v0: { x: number; y: number }; v1: { x: number; y: number } }[];
  } | null = null;

  constructor(container: Container) {
    this.corridorsContainer = new Container();
    container.addChild(this.corridorsContainer);

    this.corridors = new Graphics();
    this.corridorsContainer.addChild(this.corridors);

    this.markersContainer = new Container();
    container.addChild(this.markersContainer);
    this.markers = new WaypointsRenderer(this.markersContainer);

    this.syncVisibility(useMazeStore.getState());
    this.subscribe();
  }

  private subscribe(): void {
    let prev = useMazeStore.getState();
    this.unsubscribe = useMazeStore.subscribe((state) => {
      const visibilityChanged = state.openCard !== prev.openCard;
      if (visibilityChanged) this.syncVisibility(state);

      const dataChanged =
        state.nodes !== prev.nodes ||
        state.edges !== prev.edges ||
        state.start !== prev.start ||
        state.finish !== prev.finish ||
        state.postEditMeta !== prev.postEditMeta ||
        state.postEditDraftSplitPoints !== prev.postEditDraftSplitPoints ||
        state.activeTessellationConfig !== prev.activeTessellationConfig;
      const settingsChanged = state.vectorByCorridorsSettings !== prev.vectorByCorridorsSettings;

      if ((dataChanged || settingsChanged) && state.openCard === "image_export") {
        this.renderAll(state);
      }

      prev = state;
    });
  }

  private syncVisibility(state: ReturnType<typeof useMazeStore.getState>): void {
    const visible = state.openCard === "image_export";
    this.corridorsContainer.visible = visible;
    this.markersContainer.visible = visible;
    if (visible) this.renderAll(state);
  }

  onViewportChanged(_x: number, _y: number, _w: number, _h: number, _scale: number): void {}

  getRequiredExportMargin(): ExportMargin {
    return computeVectorByCorridorsExportMargin(useMazeStore.getState().vectorByCorridorsSettings);
  }

  getRequiredWallExportMargin(): ExportMargin {
    return computeVectorByCorridorsExportMargin(useMazeStore.getState().vectorByCorridorsSettings);
  }

  getBackgroundColor(): number {
    return canvas.stage.background;
  }

  private renderAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const { nodes, edges } = state;
    const cfg = state.activeTessellationConfig;

    if (
      !this.geometryCache ||
      this.geometryCache.nodes !== nodes ||
      this.geometryCache.edges !== edges ||
      this.geometryCache.cfg !== cfg
    ) {
      this.geometryCache = { nodes, edges, cfg, segments: buildCorridorSegments(nodes, edges, cfg) };
    }

    const settings = state.vectorByCorridorsSettings;
    const strokeOpts = {
      width: settings.thickness,
      color: settings.color,
      join: settings.join,
      cap: settings.join === "miter" ? ("square" as const) : ("round" as const),
    };

    this.corridors.clear();
    for (const path of chainSegmentsAtSharedVertices(this.geometryCache.segments)) {
      this.corridors.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) this.corridors.lineTo(path[i].x, path[i].y);
      this.corridors.stroke(strokeOpts);
    }

    const { start, finish } = resolveEffectiveEndpoints(state);
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const markerData = buildMazeMarkers(
      nodeById, start, finish, cfg,
      buildMarkerStyle(settings.startMarker, canvas.stage.background),
      buildMarkerStyle(settings.finishMarker, canvas.stage.background),
    );

    // Widen the corridor stroke under each marker so it doesn't get visually swallowed by/collide
    // with the passage line (GitHub issue #311) — a filled patch matching the marker's own shape,
    // drawn in the corridor's own color, into the same `Graphics` as the stroke and before the
    // markers themselves. Reusable groundwork (`drawMarkerWidenPatches`, not waypoint-specific) so
    // a future marker type on this canvas can call it the same way.
    drawMarkerWidenPatches(this.corridors, markerData, settings.color, settings.thickness, settings.markerWidenPadding);

    this.markers.render({ markers: markerData });
  }

  destroy(): void {
    this.unsubscribe?.();
    this.corridors.destroy();
    this.corridorsContainer.destroy();
    this.markers.destroy();
    this.markersContainer.destroy();
  }
}
