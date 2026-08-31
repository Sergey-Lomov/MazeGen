import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";

import type { FieldEdge } from "./fieldEditUtils";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { TeleportRenderer } from "./renderers/TeleportRenderer";
import { drawTeleportPreview } from "./renderers/teleportPreviewGlyph";
import { GridRenderer } from "./renderers/GridRenderer";
import { EdgeHighlightRenderer } from "./renderers/EdgeHighlightRenderer";
import { NodeEdgeHighlightRenderer } from "./renderers/NodeEdgeHighlightRenderer";
import { SplitJunctionRenderer, collectSplitWallPaths } from "./renderers/SplitJunctionRenderer";
import { VerticalConnectionRenderer, DEFAULT_VERTICAL_STYLE } from "./renderers/VerticalConnectionRenderer";
import { IssueHighlightOverlay } from "./IssueHighlightOverlay";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, buildTeleportBadgeBlockedCells, postEditEdgesToDto, buildClosedCells, buildSplitPassages, buildLinkHoverHighlight, selectFloorScopedMaze, selectNodeLevelResolver, selectVerticalPassagePairSet, buildVerticalConnectionMarkers, type TeleportFloorContext } from "./selectors/mazeSelectors";
import { postEditTeleportsToDto, postEditVerticalToDto, pruneRemovedSplitNodes } from "./postEditUtils";
import { buildHoverEdgeHighlight } from "./selectors/presetSelectors";
import { canvas } from "./colorTokens";
import type { NodeDto } from "../wasm/types";
import type { PostEditEdge, PostEditTeleportEntry } from "../store/mazeStore";
import { BaseFieldRenderer } from "./BaseFieldRenderer";
import { type PostEditEndpoint, resolveEndpoint, buildSplitNodeResolver, floorScopedEndpoint } from "./postEditEndpoint";
import { recordOnLevel } from "./fieldEditUtils";
import { activeFloorLevel } from "../store/storeHelpers";

type MazeState = ReturnType<typeof useMazeStore.getState>;

export class PostEditRenderer extends BaseFieldRenderer {
  private readonly root: Container;

  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly closedCellsContainer: Container;
  private readonly wallsContainer: Container;
  private readonly teleportContainer: Container;
  private readonly verticalContainer: Container;
  private readonly markersContainer: Container;
  private readonly hoverContainer: Container;
  private readonly cellHoverContainer: Container;
  private readonly teleportPreviewContainer: Container;
  private readonly splitJunctionContainer: Container;
  private readonly linkHoverContainer: Container;
  private readonly issueHighlightContainer: Container;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly closedCells: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly teleports: TeleportRenderer;
  private readonly verticalConnections: VerticalConnectionRenderer;
  private readonly markers: WaypointsRenderer;
  private readonly hover: EdgeHighlightRenderer;
  private readonly cellHover: CellFillRenderer;
  private readonly teleportPreview: Graphics;
  private readonly splitJunctions: SplitJunctionRenderer;
  /** Highlights the link a "Manage split nodes" panel bubble is currently hovered (GitHub issue
   *  #237) — driven by `postEditHoveredLink`, a separate layer/container from `hover` (that one
   *  is driven by canvas pointermove instead, via `updateHover`) so the two never fight over the
   *  same `Graphics` object. Same `NodeEdgeHighlightRenderer` primitive `DebugRefHighlightOverlay`
   *  uses for its edge-ref highlight — a straight line + circle markers on each end, node center
   *  to node center, not the shared geometric wall segment (a link bubble names a specific pair of
   *  *nodes*, and a teleport link has no shared face at all to draw on). */
  private readonly linkHover: NodeEdgeHighlightRenderer;
  /** Highlights a hovered `IssueBubble`'s flagged cells/edges/regions in the post-edit canvas —
   *  own instance, not shared with `AnalyticsRenderer`'s (feature-renderer ownership rule,
   *  `maze-web/CLAUDE.md`). `IssuesBlock`/`IssueBubble` drive both from the same store fields
   *  (`hoveredIssueLoopEdges`/`hoveredIssueRegionGroups`), so no post-edit-specific wiring needed
   *  beyond owning this instance and re-rendering it on the same triggers as everything else. */
  private readonly issueHighlight: IssueHighlightOverlay;

  constructor(container: Container) {
    super();
    this.root = container;

    this.gridContainer        = new Container();
    this.floorContainer       = new Container();
    this.closedCellsContainer = new Container();
    this.wallsContainer       = new Container();
    this.teleportContainer    = new Container();
    this.verticalContainer    = new Container();
    this.markersContainer     = new Container();
    this.hoverContainer       = new Container();

    this.root.addChild(this.gridContainer);
    this.root.addChild(this.floorContainer);
    this.root.addChild(this.closedCellsContainer);
    this.root.addChild(this.wallsContainer);
    this.splitJunctionContainer = new Container();
    this.root.addChild(this.splitJunctionContainer);
    this.root.addChild(this.teleportContainer);
    this.root.addChild(this.verticalContainer);
    this.root.addChild(this.markersContainer);
    this.root.addChild(this.hoverContainer);
    this.cellHoverContainer = new Container();
    this.root.addChild(this.cellHoverContainer);
    this.teleportPreviewContainer = new Container();
    this.root.addChild(this.teleportPreviewContainer);
    this.linkHoverContainer = new Container();
    this.root.addChild(this.linkHoverContainer);
    this.issueHighlightContainer = new Container();
    this.root.addChild(this.issueHighlightContainer);

    this.grid        = new GridRenderer(this.gridContainer);
    this.floor       = new CellFillRenderer(this.floorContainer);
    this.closedCells = new CellFillRenderer(this.closedCellsContainer);
    this.walls       = new WallRenderer(this.wallsContainer);
    this.splitJunctions = new SplitJunctionRenderer(this.splitJunctionContainer);
    this.teleports   = new TeleportRenderer(this.teleportContainer);
    this.verticalConnections = new VerticalConnectionRenderer(this.verticalContainer);
    this.markers     = new WaypointsRenderer(this.markersContainer);
    this.hover       = new EdgeHighlightRenderer(this.hoverContainer);
    this.cellHover   = new CellFillRenderer(this.cellHoverContainer);
    this.teleportPreview = new Graphics();
    this.teleportPreviewContainer.addChild(this.teleportPreview);
    this.linkHover   = new NodeEdgeHighlightRenderer(this.linkHoverContainer);
    this.issueHighlight = new IssueHighlightOverlay(this.issueHighlightContainer);

    this.root.visible = false;

    this.subscribeToStore();
  }

  protected isCardOpen(state: MazeState): boolean {
    return state.openCard === "post_edit";
  }

  protected getActiveConfig(state: MazeState) {
    return state.activeTessellationConfig;
  }

  protected setRootVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.updateViewport(x, y, w, h, scale);
    if (useMazeStore.getState().openCard === "post_edit" && this.cfg) {
      this.grid.render({ viewport: this.viewport }, this.cfg);
    }
  }

  /** `danger` (GitHub issue #327's unified Reset tool) swaps the highlight to
   * `canvas.fieldEditor.danger` (red) instead of the ordinary hover color — signals a destructive
   * tool the same way the Management section's red Reset button does. */
  updateHover(edge: FieldEdge | null, danger = false): void {
    if (!this.cfg) return;
    const highlights = buildHoverEdgeHighlight(edge, this.cfg, danger ? canvas.fieldEditor.danger : undefined);
    this.hover.render({ highlights });
  }

  /** Highlights a single cell (not a wall/edge) — used while the `manage_split_nodes` tool is
   * active, since that tool targets a whole point rather than one of its faces (GitHub issue
   * #221's follow-up: highlighting a wall there was misleading about what a click would do).
   * `danger` — see `updateHover`'s doc comment. */
  updateCellHover(cell: [number, number] | null, danger = false): void {
    if (!this.cfg) return;
    this.cellHover.render({ cells: cell ? [cell] : [], color: danger ? canvas.fieldEditor.danger : canvas.fieldEditor.hover, alpha: 0.35 }, this.cfg);
  }

  /** Renders the pending teleport's fixed endpoint marker + a connector line to the cursor, so the
   * two-click placement gesture reads as "one end is already fixed, aim the other". `pendingFrom` is
   * already in viewport coordinates (the caller resolves node → screen). Shared look with the preset
   * card via `drawTeleportPreview`. */
  updateTeleportPreview(pendingFrom: { x: number; y: number } | null, cursorViewportX: number, cursorViewportY: number): void {
    this.teleportPreview.clear();
    if (!pendingFrom) return;

    drawTeleportPreview(this.teleportPreview, pendingFrom.x, pendingFrom.y, cursorViewportX, cursorViewportY);
  }

  protected onStoreChange(state: MazeState, prev: MazeState): void {
    if (
      state.postEditDraftEdges !== prev.postEditDraftEdges ||
      state.postEditDraftTeleports !== prev.postEditDraftTeleports ||
      state.nodes !== prev.nodes ||
      state.edges !== prev.edges ||
      state.postEditDraftMeta !== prev.postEditDraftMeta ||
      state.postEditDraftSplitPoints !== prev.postEditDraftSplitPoints ||
      state.postEditActiveSplitNode !== prev.postEditActiveSplitNode ||
      state.activeFloorId !== prev.activeFloorId ||
      state.postEditTool !== prev.postEditTool
    ) {
      this.redrawAll(state);
    } else if (state.postEditHoveredLink !== prev.postEditHoveredLink) {
      this.redrawLinkHover(state);
    }

    if (
      state.hoveredIssueLoopEdges !== prev.hoveredIssueLoopEdges ||
      state.hoveredIssueRegionGroups !== prev.hoveredIssueRegionGroups ||
      state.nodes !== prev.nodes ||
      state.activeFloorId !== prev.activeFloorId
    ) {
      this.redrawIssueHighlight(state);
    }

    if (state.postEditTool !== prev.postEditTool || state.postEditTeleportPendingFrom !== prev.postEditTeleportPendingFrom) {
      if (state.postEditTeleportPendingFrom === null) this.teleportPreview.clear();
    }
  }

  /** Floor-scopes every post-edit piece of state (GitHub issue #358) — `state.nodes`/`state.edges`
   * and `postEditDraftEdges`/`postEditDraftTeleports`/`postEditDraftSplitPoints`/
   * `postEditActiveSplitNode` are all one flat, maze-wide collection now (mirroring preset
   * connections, GitHub issue #340), but every selector below (`buildMazeWalls`,
   * `buildSplitPassages`, etc.) is still level-agnostic and expects single-floor-shaped data — a
   * same-(x,y) node/split point on another floor would otherwise be drawn on top of the active
   * floor's own. */
  private floorScoped(state: MazeState) {
    const level = activeFloorLevel(state);
    const { nodes: floorNodes, edges, start, finish } = selectFloorScopedMaze(state.nodes, state.edges, state.floors, state.activeFloorId, state.start, state.finish);
    const postEditDraftSplitPoints = recordOnLevel(state.postEditDraftSplitPoints, level);
    const nodes = pruneRemovedSplitNodes(floorNodes, postEditDraftSplitPoints);
    const floorNodeIds = new Set(nodes.map((n) => n.id));
    // `floorScopedEndpoint` (checks on-level, then strips `level`) — `postEditDraftSplitPoints`/
    // `postEditActiveSplitNode` above are already `recordOnLevel`'d down to bare `"x,y"` keys, so
    // an endpoint resolved through them must not still carry its original non-zero `level` (that
    // would send `resolveSplit` looking for a `"x,y@level"` key that no longer exists in the
    // scoped map, silently failing to resolve every split reference on any floor above the first —
    // GitHub issue #425).
    const onLevel = (ep: PostEditEndpoint) => floorScopedEndpoint(ep, level, floorNodeIds);
    const postEditDraftEdges: Record<string, PostEditEdge> | null = state.postEditDraftEdges === null ? null : Object.fromEntries(
      Object.entries(state.postEditDraftEdges)
        .map(([k, e]) => {
          const from = onLevel(e.from);
          const to = onLevel(e.to);
          return from !== undefined && to !== undefined ? [k, { ...e, from, to }] as const : null;
        })
        .filter((entry): entry is readonly [string, PostEditEdge] => entry !== null),
    );
    // Kept whenever *either* endpoint is on the active floor (mirrors `selectFloorScopedMaze`'s own
    // "keeps an edge whenever `from` is on the active floor" convention for cross-floor kinds) — a
    // cross-floor teleport must stay visible/editable from both of its ends, not just the one that
    // happened to be `from` at creation time. Requiring *both* ends on-level (the pre-fix behavior)
    // made a cross-floor teleport vanish from every floor's own draft entirely. Only the on-level
    // endpoint is stripped of its `level` (see above) — an off-floor endpoint is left untouched, so
    // it still fails the scoped resolver and is silently dropped, same as before this fix.
    const postEditDraftTeleports: PostEditTeleportEntry[] = state.postEditDraftTeleports
      .map((t) => {
        const from = onLevel(t.from);
        const to = onLevel(t.to);
        return from !== undefined || to !== undefined ? { ...t, from: from ?? t.from, to: to ?? t.to } : null;
      })
      .filter((t): t is PostEditTeleportEntry => t !== null);
    const postEditActiveSplitNode = recordOnLevel(state.postEditActiveSplitNode, level);
    const postEditDraftMeta = state.postEditDraftMeta === null ? null : {
      start: state.postEditDraftMeta.start !== null ? onLevel(state.postEditDraftMeta.start) ?? null : null,
      finish: state.postEditDraftMeta.finish !== null ? onLevel(state.postEditDraftMeta.finish) ?? null : null,
    };
    return { nodes, edges, start, finish, postEditDraftEdges, postEditDraftTeleports, postEditDraftSplitPoints, postEditActiveSplitNode, postEditDraftMeta };
  }

  private redrawIssueHighlight(state: MazeState): void {
    if (!this.cfg) return;
    const { nodes, edges } = this.floorScoped(state);
    const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
    const unscopedNodeById = new Map(state.nodes.map((n) => [n.id, n]));
    const resolveNodeCell = (id: number): [number, number] | undefined => {
      const n = unscopedNodeById.get(id);
      return n ? [n.x, n.y] : undefined;
    };
    const activeFloorIndex = Math.max(state.floors.findIndex((f) => f.id === state.activeFloorId), 0);
    // Same one-way detection the Analytics overlay uses — built from the *unscoped* confirmed
    // `state.edges` (a two-way connection's reverse edge lives on the other floor, GitHub issue
    // #337/#347). Uncommitted post-edit draft changes to a cross-floor connection aren't reflected
    // here; the hovered-issue highlight is a read-only locator, not a live edit preview.
    const crossFloorEdgeKeys = new Set(
      state.edges.filter((e) => e.kind !== "basic").map((e) => `${e.from}->${e.to}`),
    );
    this.issueHighlight.render({
      nodes,
      edges: state.hoveredIssueLoopEdges,
      allEdges: edges,
      regionGroups: state.hoveredIssueRegionGroups,
      cfg: this.cfg,
      resolveNodeLevel,
      resolveNodeCell,
      activeFloorIndex,
      crossFloorEdgeKeys,
    });
  }

  private redrawLinkHover(state: MazeState): void {
    if (!this.cfg) return;
    const { nodes, postEditDraftSplitPoints } = this.floorScoped(state);
    const pointNodeMap = new Map<string, number[]>();
    for (const nd of nodes) {
      const k = `${nd.x},${nd.y}`;
      const list = pointNodeMap.get(k);
      if (list) list.push(nd.id); else pointNodeMap.set(k, [nd.id]);
    }
    const resolveSplit = buildSplitNodeResolver(pointNodeMap, postEditDraftSplitPoints);
    const highlights = buildLinkHoverHighlight(state.postEditHoveredLink, nodes, resolveSplit, this.cfg);
    this.linkHover.render(highlights);
  }

  protected redrawAll(state: MazeState): void {
    if (!this.cfg) return;
    const cfg = this.cfg;

    this.grid.render({ viewport: this.viewport }, cfg);

    const { nodes, edges, postEditDraftEdges, postEditDraftTeleports, postEditDraftMeta, postEditDraftSplitPoints, postEditActiveSplitNode } = this.floorScoped(state);

    // Resolves `split` endpoints from the latest confirmed node snapshot — a draft reference to
    // a split node not yet confirmed simply doesn't resolve, and is dropped from what's drawn
    // (see postEditEndpoint.ts's doc comment on the unresolved-endpoint contract).
    const pointNodeMap = new Map<string, number[]>();
    for (const nd of nodes) {
      const k = `${nd.x},${nd.y}`;
      const list = pointNodeMap.get(k);
      if (list) list.push(nd.id); else pointNodeMap.set(k, [nd.id]);
    }
    const resolveSplit = buildSplitNodeResolver(pointNodeMap, postEditDraftSplitPoints);

    const start = postEditDraftMeta?.start != null ? resolveEndpoint(postEditDraftMeta.start, resolveSplit) ?? null : null;
    const finish = postEditDraftMeta?.finish != null ? resolveEndpoint(postEditDraftMeta.finish, resolveSplit) ?? null : null;
    const activeEdges = [
      ...postEditEdgesToDto(postEditDraftEdges, resolveSplit),
      ...postEditTeleportsToDto(postEditDraftTeleports, resolveSplit),
    ];

    // A split node carrying a start/finish marker or a teleport endpoint always keeps its hub
    // point (see buildSplitPassages's straightening exception) so the marker/teleport line has a
    // single unambiguous point to sit on, rather than an arbitrary spot on a straightened line.
    const specialNodeIds = new Set<number>();
    if (start !== null) specialNodeIds.add(start);
    if (finish !== null) specialNodeIds.add(finish);
    for (const e of activeEdges) {
      if (e.kind === "teleport") { specialNodeIds.add(e.from); specialNodeIds.add(e.to); }
    }

    const cells: [number, number][] = nodes.map(n => [n.x, n.y]);
    this.floor.render({ cells, color: canvas.floor.default, alpha: 1 }, cfg);

    // Split points (GitHub issue #223) render every node's passages at once, as colored lines
    // from a small per-node point to each face it connects across — see `buildSplitPassages`.
    // `postEditActiveSplitNode` still governs which endpoint edge-tool clicks target, but no
    // longer what's drawn; ordinary `buildMazeWalls` skips a split point's own geometric edges
    // entirely, since those are rendered here instead.
    // `allEdges` (GitHub issue #359 follow-up) is required so a cell whose only connection is a
    // vertical passage/elevator (never part of `activeEdges` — see below, these kinds aren't
    // post-edit-editable) isn't mistaken for having no connection at all and rendered as a wall;
    // must be the *unscoped* `state.edges`, not the floor-scoped `edges` above, for the same reason
    // `buildVerticalConnectionMarkers`'s own call below needs `state.edges` — an arrival-only edge's
    // `from` lives on another floor and is missing from any floor-scoped list.
    const closed = buildClosedCells(nodes, activeEdges, state.edges);
    this.closedCells.render({ cells: closed, color: canvas.wall.default, alpha: 1 }, cfg);

    const { passages: splitPassages, wallFaces, specialShapes } = buildSplitPassages(nodes, activeEdges, cfg, specialNodeIds, postEditActiveSplitNode, postEditDraftSplitPoints);

    const wallEdges = buildMazeWalls(nodes, activeEdges, cfg);
    const { paths: extraWalls, noCapPoints } = collectSplitWallPaths(wallFaces, specialShapes);
    this.walls.render({ edges: wallEdges }, cfg, undefined, undefined, extraWalls, noCapPoints);

    this.splitJunctions.render({ passages: splitPassages, wallFaces, specialShapes });

    const nodeById = new Map<number, NodeDto>(nodes.map(n => [n.id, n]));
    // Cross-floor teleports (badge rendering, mirrors `GenerationRenderer`) — `unscopedActiveEdges`
    // resolves post-edit's own *draft* teleports (not `state.edges`, which may be stale/pre-confirm)
    // without the active-floor filter `postEditDraftTeleports` above applies, so the reverse-
    // direction edge of a bidirectional cross-floor pair (its own `from` on the other floor) is
    // available for `byPair`'s bidirectional check the same way `TeleportFloorContext`'s own doc
    // comment requires.
    const unscopedResolveSplit = buildSplitNodeResolver(buildMultiFloorPointNodeMap(state.nodes), state.postEditDraftSplitPoints);
    const unscopedActiveEdges = [
      ...postEditEdgesToDto(state.postEditDraftEdges ?? {}, unscopedResolveSplit),
      ...postEditTeleportsToDto(state.postEditDraftTeleports, unscopedResolveSplit),
    ];
    const activeFloorIndex = state.floors.findIndex((f) => f.id === state.activeFloorId);
    const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
    const teleportFloorContext: TeleportFloorContext = {
      resolveNodeLevel,
      unscopedNodeById: new Map<number, NodeDto>(state.nodes.map((n) => [n.id, n])),
      unscopedEdges: unscopedActiveEdges,
      activeFloorIndex: Math.max(activeFloorIndex, 0),
    };
    const teleportEdges = buildTeleportEdges(nodeById, activeEdges, cfg, teleportFloorContext, {
      blockedCellsByFloor: buildTeleportBadgeBlockedCells(
        state.nodes,
        [...state.edges, ...unscopedActiveEdges],
        resolveNodeLevel,
        // Post-edit's *draft* start/finish (resolved to node ids above), not `state.start`/`.finish`,
        // which stay pointing at the pre-edit endpoints until the draft is confirmed.
        start,
        finish,
      ),
      allowOutOfField: true,
    });
    this.teleports.render({ edges: teleportEdges, cfg, floorNavigable: state.postEditTool !== "reset" });

    // Vertical passages/elevators — generation-time ones are read from the confirmed
    // `state.nodes`/`state.edges` graph directly, not from `activeEdges` (post-edit's own draft
    // edges/teleports); user-placed ones (GitHub issue #341) come from
    // `postEditDraftVerticalPassages`/`postEditDraftElevators` instead, converted the same way
    // `activeEdges` converts draft teleports. `edges`/`nodeById` here are already floor-scoped
    // (`floorScoped`'s `selectFloorScopedMaze`, which keeps a vertical/elevator edge whenever its
    // `from` is on the active floor); `resolveNodeLevel`/`verticalPairs` must come from the
    // *unscoped* `state.nodes`/(`state.edges` + draft) instead, same reason
    // `selectVerticalPassagePairSet`'s own doc comment gives (a floor-scoped edge list is missing
    // the reverse-direction edge of a bidirectional passage, whose own `from` lives on the other
    // floor).
    const draftVerticalEdges = postEditVerticalToDto(state.postEditDraftVerticalPassages, state.postEditDraftElevators, resolveSplit);
    // Drop a generation-time `elevator`/`vertical_passage` edge once the user has edited that
    // connection (see `postEditSuppressedElevatorPairs`'s/`postEditSuppressedVerticalPassagePairs`'s
    // own doc comments) — draws the same "draft is now authoritative" state confirmPostEdit will
    // send, without waiting for the next confirm.
    const isSuppressedEdge = (e: { from: number; to: number; kind: string }) => {
      if (e.kind !== "elevator" && e.kind !== "vertical_passage") return false;
      const [a, b] = [e.from, e.to].sort((x, y) => x - y);
      return e.kind === "elevator"
        ? state.postEditSuppressedElevatorPairs.has(`${a},${b}`)
        : state.postEditSuppressedVerticalPassagePairs.has(`${a},${b}`);
    };
    const stateEdgesUnsuppressed = state.edges.filter((e) => !isSuppressedEdge(e));
    const edgesUnsuppressed = edges.filter((e) => !isSuppressedEdge(e));
    const allVerticalEdges = [...stateEdgesUnsuppressed, ...draftVerticalEdges];
    const floorScopedVerticalEdges = [...edgesUnsuppressed, ...draftVerticalEdges.filter((e) => {
      const fromNode = nodeById.get(e.from);
      return fromNode !== undefined;
    })];
    const verticalConnectionMarkers = buildVerticalConnectionMarkers(
      nodeById, floorScopedVerticalEdges, cfg, resolveNodeLevel, Math.max(activeFloorIndex, 0),
      selectVerticalPassagePairSet(allVerticalEdges), allVerticalEdges,
    );
    // Click-to-switch-floor (GitHub issue #341 follow-up): withheld while the reset tool is
    // active (its own click means "delete this connection", not "navigate") and, for a one-way
    // passage marker specifically (`filled === false`), while the one-way passage tool is active
    // too (that tool's own click on the marker cycles its direction instead).
    this.verticalConnections.render({
      markers: verticalConnectionMarkers,
      style: DEFAULT_VERTICAL_STYLE,
      interactive: (marker) =>
        state.postEditTool !== "reset" &&
        !(marker.filled === false && state.postEditTool === "vertical_passage_one_way"),
    });

    const markerData = buildMazeMarkers(nodeById, start, finish, cfg, undefined, undefined, activeEdges);
    this.markers.render({ markers: markerData });

    this.hover.render({ highlights: [] });
    this.cellHover.render({ cells: [], color: canvas.fieldEditor.hover, alpha: 0.35 }, cfg);
    this.redrawLinkHover(state);
    this.redrawIssueHighlight(state);
  }

  protected clearAll(): void {
    if (!this.cfg) return;
    const cfg = this.cfg;
    this.grid.render({ viewport: { x: 0, y: 0, w: 0, h: 0, scale: 1 } }, cfg);
    this.floor.render({ cells: [], color: canvas.floor.default, alpha: 1 }, cfg);
    this.closedCells.render({ cells: [], color: canvas.wall.default, alpha: 1 }, cfg);
    this.walls.render({ edges: [] }, cfg);
    this.splitJunctions.render({ passages: [], wallFaces: [] });
    this.teleports.render({ edges: [], cfg });
    this.verticalConnections.render({ markers: [], style: DEFAULT_VERTICAL_STYLE });
    this.markers.render({ markers: [] });
    this.hover.render({ highlights: [] });
    this.cellHover.render({ cells: [], color: canvas.fieldEditor.hover, alpha: 0.35 }, cfg);
    this.linkHover.clear();
    this.issueHighlight.clear();
    this.teleportPreview.clear();
  }

  protected destroyChildren(): void {
    this.grid.destroy();
    this.floor.destroy();
    this.closedCells.destroy();
    this.walls.destroy();
    this.splitJunctions.destroy();
    this.teleports.destroy();
    this.verticalConnections.destroy();
    this.markers.destroy();
    this.hover.destroy();
    this.cellHover.destroy();
    this.linkHover.destroy();
    this.issueHighlight.destroy();
    this.teleportPreview.destroy();
    this.gridContainer.destroy();
    this.floorContainer.destroy();
    this.closedCellsContainer.destroy();
    this.wallsContainer.destroy();
    this.splitJunctionContainer.destroy();
    this.teleportContainer.destroy();
    this.verticalContainer.destroy();
    this.markersContainer.destroy();
    this.hoverContainer.destroy();
    this.cellHoverContainer.destroy();
    this.teleportPreviewContainer.destroy();
    this.linkHoverContainer.destroy();
    this.issueHighlightContainer.destroy();
  }
}

/** Same `(x,y) -> NodeId[]` map as `PostEditController`'s own `buildNodeMap`, but spanning every
 *  floor at once (GitHub issue #358) — keyed `"x,y"` for floor 0, `"x,y@level"` otherwise, matching
 *  `postEditDraftSplitPoints`'s own key convention (mirrors `buildMultiFloorPointNodeMap` in
 *  `postEditSlice.ts`, kept as its own copy here since that one isn't exported). */
function buildMultiFloorPointNodeMap(nodes: NodeDto[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const n of nodes) {
    const level = n.level ?? 0;
    const key = level === 0 ? `${n.x},${n.y}` : `${n.x},${n.y}@${level}`;
    const list = m.get(key);
    if (list) list.push(n.id);
    else m.set(key, [n.id]);
  }
  return m;
}
