import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import { buildCorridorSegments, buildMazeMarkers, buildTeleportEdges } from "../selectors/mazeSelectors";
import { chainSegmentsAtSharedVertices } from "../renderers/WallRenderer";
import { WaypointsRenderer } from "../renderers/WaypointsRenderer";
import { TeleportRenderer } from "../renderers/TeleportRenderer";
import { drawMarkerWidenPatches } from "../renderers/markerWidenPatches";
import { buildTeleportGroups, type TeleportGroup } from "../selectors/teleportGroups";
import { resolveEffectiveEndpoints, buildMarkerStyle, buildTeleportLineStyle, ExportWarningHighlight } from "./VectorByWallsRenderer";
import { computeVectorByCorridorsWarnings } from "../selectors/exportWarnings";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { TeleportEdge, MarkerData } from "../renderers/types";
import type { VectorByCorridorsSettings } from "../../store/storeTypes";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorTokens";
import type { ModeRenderer } from "./modeRendererFactory";
import { computeVectorByCorridorsExportMargin, type ExportMargin } from "./exportMargins";

/** Builds one `MarkerData` per unique teleport point (GitHub issue #313 follow-up: teleport markers
 *  also need their corridor-line widen patch, same `markerWidenPadding` waypoints use — no separate
 *  teleport-specific padding setting) so `drawMarkerWidenPatches` can widen the corridor stroke
 *  under them exactly like it does for start/finish markers. Each point's own shape/corner style
 *  come from its group's `TeleportGroupOverride` when `teleportGroupCustomization` is on and that
 *  group has one, else the base `teleportLineShape`/`teleportLineCornerStyle` — the widen patch must
 *  match what `TeleportRenderer` actually draws there, not always the base shape, so it doesn't leave
 *  a mismatched corner poking out from under a group-customized marker. Only `shape`/`cornerStyle`/
 *  `radius` matter here (widen patches are drawn in the corridor's own color, not the marker's), so
 *  `color`/`borderWidth`/`gapWidth` are omitted (`color: 0` is an unused placeholder — `MarkerData`
 *  requires it, `drawMarkerWidenPatches` never reads it). Exported as a pure function, same
 *  testability rationale as `VectorByWallsRenderer`'s `buildWallStyle`/`buildTeleportLineStyle`/
 *  `buildMarkerStyle` — a point-dedup + per-group-override resolution is worth unit-testing directly
 *  rather than only indirectly through mocked `Graphics` draw calls. `groups` is precomputed by the
 *  caller (`renderAll`) rather than recomputed here via `buildTeleportGroups` — `TeleportRenderer`'s
 *  own `render()` already computes the exact same grouping internally for the same `teleportEdges`,
 *  so a second call here would repeat that union-find work for no reason every render. */
export function buildTeleportWidenMarkers(teleportEdges: TeleportEdge[], settings: VectorByCorridorsSettings, groups: TeleportGroup[]): MarkerData[] {
  const overrideByPoint = new Map<string, VectorByCorridorsSettings["teleportGroupOverrides"][string]>();
  for (const group of groups) {
    const override = settings.teleportGroupOverrides[group.key];
    if (!override) continue;
    for (const [px, py] of group.points) overrideByPoint.set(`${px},${py}`, override);
  }

  const radius = settings.teleportLineSize * TILE_SIZE;
  const seen = new Set<string>();
  const markers: MarkerData[] = [];
  for (const e of teleportEdges) {
    for (const pos of [e.from, e.to]) {
      const key = `${pos[0]},${pos[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const override = overrideByPoint.get(key);
      markers.push({
        pos,
        color: 0,
        radius,
        shape: override?.shape ?? settings.teleportLineShape,
        cornerStyle: settings.teleportLineCornerStyle,
        borderWidth: settings.teleportEdgeBorderWidth,
        gapWidth: settings.teleportEdgeGapWidth,
      });
    }
  }
  return markers;
}

/** "Vector by corridors" render mode's own renderer (GitHub issue #310) — draws every basic
 * passage between geometrically adjacent cells as a stroked line between their centers
 * (`buildCorridorSegments`), the inverse of "Vector by walls"' "gap in the wall" reading. Per
 * `maze-web/CLAUDE.md`'s feature-renderer ownership rule: its own `Container` and its own
 * `Graphics`, never shared with `VectorByWallsRenderer` or any other feature's renderer — its own
 * `TeleportRenderer` instance (GitHub issue #313) follows the same rule, even though teleports
 * aren't tied to the corridor-vs-wall visual model and render identically to "Vector by walls"'
 * own. Split points are skipped entirely — their own follow-up sub-issue, same as
 * `VectorByCorridorsSettings`' own doc comment. */
export class VectorByCorridorsRenderer implements ModeRenderer {
  private readonly corridorsContainer: Container;
  private readonly corridors: Graphics;
  private readonly teleportContainer: Container;
  private readonly teleports: TeleportRenderer;
  private readonly markersContainer: Container;
  private readonly markers: WaypointsRenderer;
  private readonly warningHighlightContainer: Container;
  /** Own instance, not shared with `VectorByWallsRenderer`'s own — per
   *  `maze-web/CLAUDE.md`'s feature-renderer ownership rule. Highlights the currently hovered
   *  export warning's cells (GitHub issue #313 follow-up: this mode's warnings section had no
   *  hover-highlight wiring at all), see `computeVectorByCorridorsWarnings`. Memoize+draw mechanics
   *  shared with `VectorByWallsRenderer`'s own via `ExportWarningHighlight`. */
  private readonly warningHighlight: ExportWarningHighlight<VectorByCorridorsSettings>;

  private unsubscribe: (() => void) | null = null;

  private geometryCache: {
    nodes: NodeDto[];
    edges: EdgeDto[];
    cfg: TessellationConfig;
    segments: { v0: { x: number; y: number }; v1: { x: number; y: number } }[];
    teleportEdges: TeleportEdge[];
  } | null = null;

  constructor(container: Container) {
    this.corridorsContainer = new Container();
    container.addChild(this.corridorsContainer);

    this.corridors = new Graphics();
    this.corridorsContainer.addChild(this.corridors);

    this.teleportContainer = new Container();
    container.addChild(this.teleportContainer);
    this.teleports = new TeleportRenderer(this.teleportContainer);

    this.markersContainer = new Container();
    container.addChild(this.markersContainer);
    this.markers = new WaypointsRenderer(this.markersContainer);

    this.warningHighlightContainer = new Container();
    container.addChild(this.warningHighlightContainer);
    this.warningHighlight = new ExportWarningHighlight(this.warningHighlightContainer, computeVectorByCorridorsWarnings);

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
      // Teleports section's own expand/collapse flips canvas interactivity for group customization
      // (GitHub issue #293/#313), same rationale as `VectorByWallsRenderer`'s own
      // `teleportsSectionChanged` check.
      const teleportsSectionChanged =
        (state.vectorByCorridorsSectionsExpanded["teleports"] ?? false) !== (prev.vectorByCorridorsSectionsExpanded["teleports"] ?? false);

      if ((dataChanged || settingsChanged || teleportsSectionChanged) && state.openCard === "image_export") {
        this.renderAll(state);
      } else if (state.hoveredExportWarningKey !== prev.hoveredExportWarningKey && state.openCard === "image_export") {
        this.renderWarningHighlight(state);
      }

      prev = state;
    });
  }

  private syncVisibility(state: ReturnType<typeof useMazeStore.getState>): void {
    const visible = state.openCard === "image_export";
    this.corridorsContainer.visible = visible;
    this.teleportContainer.visible = visible;
    this.markersContainer.visible = visible;
    this.warningHighlightContainer.visible = visible;
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
      const nodeById = new Map(nodes.map((n) => [n.id, n]));
      this.geometryCache = {
        nodes, edges, cfg,
        segments: buildCorridorSegments(nodes, edges, cfg),
        teleportEdges: buildTeleportEdges(nodeById, edges, cfg),
      };
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
    // with the passage line (GitHub issue #311) — a filled patch matching the marker's own shape
    // (or a fixed circle/square, `markerWidenShape`, GitHub issue #313 follow-up), drawn in the
    // corridor's own color, into the same `Graphics` as the stroke and before the markers
    // themselves. Reusable groundwork (`drawMarkerWidenPatches`, not waypoint-specific) so a future
    // marker type on this canvas can call it the same way. A fixed square's own corners follow
    // `join`, same corner convention the corridor stroke's own join/cap already uses.
    const squareCornerStyle = settings.join === "round" ? "round" : "sharp";
    drawMarkerWidenPatches(this.corridors, markerData, settings.color, settings.thickness, settings.markerWidenPadding, settings.markerWidenShape, squareCornerStyle);

    // Teleport markers get the same widen patch, reusing the one `markerWidenPadding`/
    // `markerWidenShape` settings (GitHub issue #313 follow-up) — no separate teleport-only setting.
    // Groups computed once here and handed to `buildTeleportWidenMarkers`, rather than it calling
    // `buildTeleportGroups` again itself — `TeleportRenderer.render` below already recomputes the
    // same grouping internally for the same `teleportEdges`, so this avoids a third redundant pass.
    const teleportGroups = settings.teleportGroupCustomization ? buildTeleportGroups(this.geometryCache.teleportEdges) : [];
    drawMarkerWidenPatches(
      this.corridors,
      buildTeleportWidenMarkers(this.geometryCache.teleportEdges, settings, teleportGroups),
      settings.color,
      settings.thickness,
      settings.markerWidenPadding,
      settings.markerWidenShape,
      squareCornerStyle,
    );

    // Same `TeleportRenderer` "Vector by walls" uses (GitHub issue #313) — teleports aren't tied to
    // the corridor-vs-wall visual model, so the settings and rendering transfer as-is.
    this.teleports.render({
      edges: this.geometryCache.teleportEdges,
      // `floorColor` occludes an outline (exit-only) teleport point's own line pass-through and
      // fills its gap rings — on this canvas that's the corridor's own color, not the canvas
      // background, since a teleport point sits directly on the passage line, not on an empty
      // floor tile the way "Vector by walls"' floor does.
      lineStyle: buildTeleportLineStyle(settings, settings.color),
      groupCustomization: settings.teleportGroupCustomization,
      groupOverrides: settings.teleportGroupOverrides,
      interactive: state.vectorByCorridorsSectionsExpanded["teleports"] ?? false,
      cfg,
      waypoints: markerData.map((m) => m.pos),
      avoidFieldExit: settings.teleportAvoidFieldExit,
      fieldCells: nodes.map((n): [number, number] => [n.x, n.y]),
    });

    this.markers.render({ markers: markerData });

    this.renderWarningHighlight(state);
  }

  /** Highlights the currently hovered export warning's flagged cell(s) — see
   *  `ExportWarningHighlight`'s own doc comment for the memoize-then-draw mechanics, shared with
   *  `VectorByWallsRenderer`'s own copy of this method. */
  private renderWarningHighlight(state: ReturnType<typeof useMazeStore.getState>): void {
    const { hoveredExportWarningKey, nodes, edges } = state;
    const { start, finish } = resolveEffectiveEndpoints(state);
    this.warningHighlight.render(hoveredExportWarningKey, nodes, edges, state.activeTessellationConfig, state.vectorByCorridorsSettings, start, finish);
  }

  destroy(): void {
    this.unsubscribe?.();
    this.corridors.destroy();
    this.corridorsContainer.destroy();
    this.teleports.destroy();
    this.teleportContainer.destroy();
    this.markers.destroy();
    this.markersContainer.destroy();
    this.warningHighlight.destroy();
    this.warningHighlightContainer.destroy();
  }
}
