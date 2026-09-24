import { useMazeStore } from "../store/mazeStore";
import type { Container } from "pixi.js";
import { pickEdgeAtPosition, isInEdgeVertexDeadZone } from "./fieldEditUtils";
import { pickPostEditTeleportEndpointAt, pickPostEditVerticalPassageEndpointAt, pickPostEditElevatorEndpointAt } from "./postEditUtils";
import type { PostEditTeleportEndpointHit, PostEditVerticalPassageEndpointHit, PostEditElevatorEndpointHit } from "../store/mazeStore";
import { makeProjection } from "./tessellationProjection";
import type { PostEditRenderer } from "./PostEditRenderer";
import type { NodeDto } from "../wasm/types";
import { BaseController } from "./BaseController";
import {
  type PostEditEndpoint, nodeEndpoint, edgeKey, endpointsEqual, resolveEndpoint, buildSplitNodeResolver, floorScopedEndpoint,
} from "./postEditEndpoint";
import { selectFloorScopedMaze, selectNodeLevelResolver } from "./selectors/mazeSelectors";
import { activeFloorLevel } from "../store/storeHelpers";
import { recordOnLevel } from "./fieldEditUtils";
import { resolveNodeIdToEndpoint } from "../store/slices/postEditSliceHelpers";

const DRAG_EDGE_TOOLS = new Set(["wall", "passage"]);
const TELEPORT_TOOLS = new Set(["teleport_one_way", "teleport_two_way"]);
const VERTICAL_PASSAGE_TOOLS = new Set(["vertical_passage_one_way", "vertical_passage_two_way"]);
const VERTEX_TOOLS = new Set(["set_start", "set_finish", "teleport_one_way", "teleport_two_way", "vertical_passage_one_way", "vertical_passage_two_way", "elevator"]);

/** Whether a point currently has more than one node (a split point) — used by the unified Reset
 * tool (GitHub issue #327) to refuse resetting a split connection via the edge branch; such an
 * edge can only be reset via the cell branch instead (whole-point reset). */
function isSplitCell(point: [number, number], nodeMap: Map<string, number[]>): boolean {
  const ids = nodeMap.get(`${point[0]},${point[1]}`);
  return ids !== undefined && ids.length > 1;
}

/** True while the entity-delete picker (GitHub issue #550) or the reset picker (GitHub issue #549)
 *  is open — pointer input must not keep driving canvas tools underneath it, mirroring
 *  `isPresetModalOpen`'s own guard for the preset side (GitHub issue #540 follow-up bug report:
 *  without this, an in-flight cell drag gesture that opened the dialog on its first cell kept
 *  running as the cursor moved to further cells). */
function isPostEditModalOpen(state: ReturnType<typeof useMazeStore.getState>): boolean {
  return state.postEditEntityDeletePrompt !== null || state.postEditResetPrompt !== null;
}


export class PostEditController extends BaseController {
  private renderer: PostEditRenderer;

  private confirmDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Every real node at a point, in snapshot order (index 0 is always the point's original node
  // per Field::nodes_at/all_points's contract — see analytics.rs's node iteration) — replaces the
  // old one-id-per-cell map, since a split point (GitHub issue #221) can have more than one.
  private nodeMap: Map<string, number[]> = new Map();
  private nodeMapNodes: NodeDto[] | null = null;
  private dragDidApply = false;

  private draggingTeleportEndpoint: PostEditTeleportEndpointHit | null = null;
  private teleportDragMoved = false;
  private draggingVerticalPassageEndpoint: PostEditVerticalPassageEndpointHit | null = null;
  private verticalPassageDragMoved = false;
  private draggingElevatorEndpoint: PostEditElevatorEndpointHit | null = null;
  private elevatorDragMoved = false;
  private lastViewportPos = { x: 0, y: 0 };

  // Origin endpoints captured at drag-arm time (GitHub issue #545) — the command log only gets one
  // command on release, so pointermove can't lean on "the store already reflects every intermediate
  // step" the way it did when each move appended its own command. `current`/`other` below are always
  // compared against these fixed origins, not against the live `postEditDragOverride`, so dragging
  // back and forth still resolves "did this end up different from where it started" correctly.
  private markerDragOrigin: PostEditEndpoint | null = null;
  private teleportDragOrigin: { current: PostEditEndpoint; other: PostEditEndpoint } | null = null;
  private verticalPassageDragOrigin: { current: PostEditEndpoint; other: PostEditEndpoint } | null = null;
  private elevatorDragOrigin: PostEditEndpoint | null = null;

  // Captured at pointerdown so a cell-drag gesture (which re-requests deletion/reset on every cell
  // it visits, via `continueCellDrag`'s callback) keeps using the shift state the drag started
  // with, not whatever it happens to be on a later pointermove (mirrors
  // `PresetConnectionsController`'s own `bulkDelete` field, GitHub issue #550). Shared by both the
  // `delete` tool and the `reset` tool's cell branch (GitHub issue #549) — one shift-held flag per
  // gesture, whichever picker-backed tool is active.
  private bulkPointAction = false;

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Escape") {
      this.cancelPendingTeleport();
      useMazeStore.getState().cancelPostEditVerticalPassagePlacement();
      useMazeStore.getState().cancelPostEditElevatorPlacement();
      useMazeStore.getState().cancelPostEditSplitTarget();
      useMazeStore.getState().cancelPostEditEntityDelete();
      useMazeStore.getState().cancelPostEditReset();
    }
  };

  constructor(
    getViewport: () => Container,
    renderer: PostEditRenderer,
    onViewportPan: (dx: number, dy: number) => void,
  ) {
    super(getViewport, onViewportPan);
    this.renderer = renderer;
    window.addEventListener("keydown", this.onKeyDown);
  }

  /** Floor-scoped node list (GitHub issue #358) — post-edit's own `state.nodes` can span every
   * floor (generation is multi-level-aware, GitHub issue #337; post-edit's confirm no longer
   * restricts to floor 0 either), so every hit-test/nodeMap below narrows to the active floor
   * first via `selectFloorScopedMaze`, same helper `GenerationRenderer` uses. */
  private getFloorNodes(state: ReturnType<typeof useMazeStore.getState>): NodeDto[] {
    return selectFloorScopedMaze(state.nodes, state.edges, state.floors, state.activeFloorId).nodes;
  }

  private getNodeMap(nodes: NodeDto[]): Map<string, number[]> {
    if (nodes !== this.nodeMapNodes) {
      this.nodeMap = buildNodeMap(nodes);
      this.nodeMapNodes = nodes;
    }
    return this.nodeMap;
  }

  /** Resolves the active endpoint for a point (which of its nodes edge-tool clicks currently
   * target) — `activeMap[key]` if the store has one, else the point's original node. `null` if
   * the point isn't in the field at all (shouldn't happen for a cell actually clicked, but a
   * stale/desynced state is cheaper to guard against than to assume away). `level` is the active
   * floor's index (GitHub issue #358) — folded into the `activeMap` lookup key the same way every
   * other `postEditActiveSplitNode` reader does. */
  private resolveActiveEndpointAt(
    point: [number, number],
    nodeMap: Map<string, number[]>,
    activeMap: Record<string, PostEditEndpoint>,
    level?: number,
  ): PostEditEndpoint | null {
    const key = `${point[0]},${point[1]}`;
    const ids = nodeMap.get(key);
    if (ids === undefined || ids.length === 0) return null;
    const activeKey = level === undefined ? key : `${key}@${level}`;
    return activeMap[activeKey] ?? nodeEndpoint(ids[0]);
  }

  private getNodeById(nodes: NodeDto[]): Map<number, NodeDto> {
    return new Map(nodes.map(n => [n.id, n]));
  }

  onPointerMove(canvasX: number, canvasY: number): void {
    if (this.handlePanMove(canvasX, canvasY)) return;

    const state = useMazeStore.getState();
    if (state.openCard !== "post_edit") return;
    if (isPostEditModalOpen(state)) {
      this.renderer.updateHover(null);
      this.renderer.updateCellHover(null);
      return;
    }

    const { x: vpX, y: vpY } = this.toViewport(canvasX, canvasY);
    this.lastViewportPos = { x: vpX, y: vpY };
    const floorNodes = this.getFloorNodes(state);
    const level = activeFloorLevel(state);

    if (this.draggingMarker) {
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const nodeMap = this.getNodeMap(floorNodes);
      const endpoint = this.resolveActiveEndpointAt([cell.x, cell.y], nodeMap, state.postEditActiveSplitNode, level);
      // Live preview only (GitHub issue #545) — no command appended per move, so a drag that never
      // ends on a different node costs nothing to have started. Origin comparison lives in
      // `onPointerUp`, which is the sole place that appends the command.
      if (endpoint !== null) {
        useMazeStore.getState().setPostEditDragOverride({
          kind: "marker", marker: this.draggingMarker === "set_start" ? "start" : "finish", endpoint,
        });
      }
      return;
    }

    if (this.draggingTeleportEndpoint && this.teleportDragOrigin) {
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const nodeMap = this.getNodeMap(floorNodes);
      const endpoint = this.resolveActiveEndpointAt([cell.x, cell.y], nodeMap, state.postEditActiveSplitNode, level);
      if (endpoint === null) return;
      const floorNodeIds = new Set(floorNodes.map((n) => n.id));
      const resolveSplit = buildSplitNodeResolver(nodeMap, recordOnLevel(state.postEditDraftSplitPoints, level));
      // `current`/`other` are the FIXED origin captured on pointerdown (GitHub issue #545) — no
      // command is appended per move any more, so the store's own `postEditDraftTeleports` no
      // longer advances with the cursor and can't be used as "where the drag currently is".
      // `resolveSplit` above is built from a bare-keyed, floor-scoped `nodeMap`/`splitPoints`, so
      // resolving a level-tagged split endpoint against it silently returns `undefined` on any
      // floor above the first (GitHub issue #425) — `floorScopedEndpoint` strips `level` after
      // confirming the endpoint belongs to this floor; an off-floor endpoint resolves to
      // `undefined` here same as before.
      const { current, other } = this.teleportDragOrigin;
      const currentId = resolveEndpoint(floorScopedEndpoint(current, level, floorNodeIds) ?? current, resolveSplit);
      const otherId = resolveEndpoint(floorScopedEndpoint(other, level, floorNodeIds) ?? other, resolveSplit);
      const endpointId = resolveEndpoint(endpoint, resolveSplit);
      const movedToOther = otherId !== undefined && endpointId !== undefined && otherId === endpointId;
      if (currentId !== endpointId) {
        // Cursor left the original node — this is a drag gesture even if landing on the other
        // endpoint's node is rejected below, so pointerup must not reinterpret it as a click.
        this.teleportDragMoved = true;
        if (!movedToOther) {
          useMazeStore.getState().setPostEditDragOverride({
            kind: "teleportEndpoint", id: this.draggingTeleportEndpoint.id, end: this.draggingTeleportEndpoint.end, endpoint,
          });
        }
      } else {
        useMazeStore.getState().setPostEditDragOverride(null);
      }
      return;
    }

    if (this.draggingVerticalPassageEndpoint && this.verticalPassageDragOrigin) {
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const nodeMap = this.getNodeMap(floorNodes);
      const endpoint = this.resolveActiveEndpointAt([cell.x, cell.y], nodeMap, state.postEditActiveSplitNode, level);
      if (endpoint === null || endpoint.kind !== "node") return;
      const hit = this.draggingVerticalPassageEndpoint;
      const { current, other } = this.verticalPassageDragOrigin;
      const currentId = current.kind === "node" ? current.id : undefined;
      const otherId = other.kind === "node" ? other.id : undefined;
      const movedToOther = otherId !== undefined && otherId === endpoint.id;
      if (currentId !== endpoint.id) {
        this.verticalPassageDragMoved = true;
        if (!movedToOther) {
          useMazeStore.getState().setPostEditDragOverride({
            kind: "verticalPassageEndpoint", id: hit.id, end: hit.end, endpoint,
          });
        }
      } else {
        useMazeStore.getState().setPostEditDragOverride(null);
      }
      return;
    }

    if (this.draggingElevatorEndpoint && this.elevatorDragOrigin) {
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const nodeMap = this.getNodeMap(floorNodes);
      const endpoint = this.resolveActiveEndpointAt([cell.x, cell.y], nodeMap, state.postEditActiveSplitNode, level);
      if (endpoint === null || endpoint.kind !== "node") return;
      const hit = this.draggingElevatorEndpoint;
      const currentId = this.elevatorDragOrigin.kind === "node" ? this.elevatorDragOrigin.id : undefined;
      if (currentId !== endpoint.id) {
        this.elevatorDragMoved = true;
        useMazeStore.getState().setPostEditDragOverride({
          kind: "elevatorEndpoint", id: hit.id, level: hit.level, endpoint,
        });
      } else {
        useMazeStore.getState().setPostEditDragOverride(null);
      }
      return;
    }

    if (TELEPORT_TOOLS.has(state.postEditTool)) {
      if (state.postEditTeleportPendingFrom !== null) {
        // Unscoped lookup — the pending origin's node can live on a floor other than the one
        // currently active (a cross-floor teleport placement in progress), so the floor-scoped
        // `floorNodes`/`nodeById` would silently drop the preview once the user switches floors.
        const fromNode = state.nodes.find((n) => n.id === state.postEditTeleportPendingFrom);
        if (fromNode) {
          const proj = makeProjection(state.activeTessellationConfig);
          const { x: px, y: py } = proj.gridToScreen(fromNode.x, fromNode.y);
          this.renderer.updateTeleportPreview({ x: px, y: py }, vpX, vpY);
        }
      } else {
        this.renderer.updateTeleportPreview(null, 0, 0);
      }
    } else {
      this.renderer.updateTeleportPreview(null, 0, 0);
    }

    if (state.postEditTool === "manage_split_nodes" || state.postEditTool === "delete" || VERTEX_TOOLS.has(state.postEditTool)) {
      // Vertex tools (set start/finish, teleports) and manage_split_nodes all target a whole
      // point, not one of its faces — highlight the cell under the cursor, not a wall/edge (see
      // GitHub issue #221's follow-up for manage_split_nodes; issue #326 extends this to every
      // vertex tool, replacing the wall-highlight reuse / missing highlight they had before).
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const nodeMap = this.getNodeMap(floorNodes);
      const inField = nodeMap.has(`${cell.x},${cell.y}`);
      this.renderer.updateCellHover(inField ? [cell.x, cell.y] : null, state.postEditTool === "delete");
      this.renderer.updateHover(null);
      if (state.postEditTool === "delete") {
        this.continueCellDrag(inField ? [cell.x, cell.y] : null, (p) => {
          useMazeStore.getState().requestPostEditEntityDelete(p, level, this.bulkPointAction);
          this.dragDidApply = true;
          // A count>1 request opens `postEditEntityDeletePrompt` synchronously — the drag gesture
          // must end right here, or it silently keeps running (as "button still held") once the
          // dialog closes, since no further pointerdown/pointerup pair will come to end it
          // normally (mirrors `PresetConnectionsController`'s own `reset`-tool guard, GitHub issue
          // #540 follow-up bug report).
          if (useMazeStore.getState().postEditEntityDeletePrompt) this.endEdgeDrag();
        });
      }
      return;
    }
    const nodeMap = this.getNodeMap(floorNodes);

    if (state.postEditTool === "reset") {
      // Once a reset gesture has started, keep dispatching through the branch selected at
      // pointerdown. The cursor may cross an edge hit zone, but that must not switch a cell reset
      // stroke to edge mutations (or make the cell stroke stop being processed).
      if (this.isCellDrag) {
        const proj = makeProjection(state.activeTessellationConfig);
        const cell = proj.screenToGrid(vpX, vpY);
        const inField = nodeMap.has(`${cell.x},${cell.y}`);
        this.renderer.updateHover(null);
        this.renderer.updateCellHover(inField ? [cell.x, cell.y] : null, true);
        this.continueCellDrag(inField ? [cell.x, cell.y] : null, (p) => {
          useMazeStore.getState().requestPostEditReset(p, level, this.bulkPointAction);
          this.dragDidApply = true;
          if (useMazeStore.getState().postEditResetPrompt) this.endEdgeDrag();
        });
        return;
      }
      if (this.isEdgeDrag) {
        const edge = pickEdgeAtPosition(vpX, vpY, state.activeTessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
        this.renderer.updateCellHover(null);
        this.renderer.updateHover(edge, true);
        this.continueEdgeDrag(edge, (e) => {
          const nodeKey = this.cellEdgeToNodeKey(e.from, e.to, nodeMap, state.postEditActiveSplitNode, level);
          if (nodeKey) {
            useMazeStore.getState().applyPostEditTool(nodeKey.key, nodeKey.from, nodeKey.to);
            this.dragDidApply = true;
          }
        });
        return;
      }
      const edge = pickEdgeAtPosition(vpX, vpY, state.activeTessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
      // Split connections can't be reset via the edge branch (GitHub issue #327) — outside the
      // near-edge zone, or when the near-edge hit touches a split point, fall back to cell hover.
      if (edge && !isSplitCell(edge.from, nodeMap) && !isSplitCell(edge.to, nodeMap)) {
        this.renderer.updateCellHover(null);
        this.renderer.updateHover(edge, true);
        this.continueEdgeDrag(edge, (e) => {
          const nodeKey = this.cellEdgeToNodeKey(e.from, e.to, nodeMap, state.postEditActiveSplitNode, level);
          if (nodeKey) {
            useMazeStore.getState().applyPostEditTool(nodeKey.key, nodeKey.from, nodeKey.to);
            this.dragDidApply = true;
          }
        });
        return;
      }
      // Near a shared vertex (edge dead zone, #188) — withhold the cell fallback too, or the
      // vertex dead zone silently becomes "picks the cell instead" (GitHub issue #340 follow-up).
      if (isInEdgeVertexDeadZone(vpX, vpY, state.activeTessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet())) {
        this.renderer.updateHover(null);
        this.renderer.updateCellHover(null);
        return;
      }
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const inField = nodeMap.has(`${cell.x},${cell.y}`);
      this.renderer.updateHover(null);
      this.renderer.updateCellHover(inField ? [cell.x, cell.y] : null, true);
      this.continueCellDrag(inField ? [cell.x, cell.y] : null, (p) => {
        useMazeStore.getState().requestPostEditReset(p, level, this.bulkPointAction);
        this.dragDidApply = true;
        // A count>1 request opens `postEditResetPrompt` synchronously — the drag gesture must end
        // right here, same reasoning as the `delete` tool's own guard above (GitHub issue #549).
        if (useMazeStore.getState().postEditResetPrompt) this.endEdgeDrag();
      });
      return;
    }
    this.renderer.updateCellHover(null);

    const edge = pickEdgeAtPosition(vpX, vpY, state.activeTessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
    this.renderer.updateHover(edge);

    this.continueEdgeDrag(edge, (e) => {
      const nodeKey = this.cellEdgeToNodeKey(e.from, e.to, nodeMap, state.postEditActiveSplitNode, level);
      if (nodeKey) {
        useMazeStore.getState().applyPostEditTool(nodeKey.key, nodeKey.from, nodeKey.to);
        this.dragDidApply = true;
      }
    });
  }

  onPointerDown(canvasX: number, canvasY: number, button: number, shiftKey?: boolean): void {
    const state = useMazeStore.getState();
    if (state.openCard !== "post_edit") return;
    if (isPostEditModalOpen(state)) return;

    if (this.tryStartPan(canvasX, canvasY, button)) return;
    // Held shift bypasses the entity picker dialog for this gesture — captured here (not read
    // fresh at request time) so a drag started with shift held stays bulk-delete for every cell
    // it visits, even if shift happens to be released mid-drag.
    this.bulkPointAction = shiftKey === true;

    const { x: vpX, y: vpY } = this.toViewport(canvasX, canvasY);
    const tool = state.postEditTool;
    const floorNodes = this.getFloorNodes(state);
    const level = activeFloorLevel(state);
    const nodeMap = this.getNodeMap(floorNodes);

    if (tool === "manage_split_nodes") {
      if (button !== 0) return;
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const key = `${cell.x},${cell.y}`;
      useMazeStore.getState().setPostEditFocusedPoint(nodeMap.has(key) ? [cell.x, cell.y] : null);
      return;
    }

    if (tool === "delete") {
      if (button !== 0) return;
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const key = `${cell.x},${cell.y}`;
      if (nodeMap.has(key)) {
        useMazeStore.getState().requestPostEditEntityDelete([cell.x, cell.y], level, this.bulkPointAction);
        // A count>1 request opens `postEditEntityDeletePrompt` synchronously — don't arm a drag
        // gesture in that case, or it's stuck "held" once the dialog closes (no further
        // pointerdown/pointerup pair reaches the canvas to end it normally; mirrors
        // `PresetConnectionsController`'s own `clear`-tool guard, GitHub issue #540 follow-up).
        if (!useMazeStore.getState().postEditEntityDeletePrompt) {
          this.beginCellDrag([cell.x, cell.y]);
          this.dragDidApply = true;
        }
      }
      return;
    }

    if (VERTEX_TOOLS.has(tool)) {
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);

      // On a split point the active-node concept must not decide anything for a vertex tool
      // (GitHub issue #474). A left click there defers to the node picker *before* any
      // marker/teleport/vertical-passage hit-test below — those all resolve through the active
      // node and would otherwise silently drag/cycle/complete on it without the dialog. Right
      // click (remove) still falls through to the hit-tests below.
      if (button === 0) {
        const cellNodeIds = nodeMap.get(`${cell.x},${cell.y}`) ?? [];
        if (cellNodeIds.length > 1) {
          if (tool === "set_start" || tool === "set_finish") {
            useMazeStore.getState().requestPostEditSplitTarget({ point: [cell.x, cell.y], level, nodeIds: cellNodeIds, action: { tool } });
          } else if (VERTICAL_PASSAGE_TOOLS.has(tool)) {
            useMazeStore.getState().requestPostEditSplitTarget({ point: [cell.x, cell.y], level, nodeIds: cellNodeIds, action: { tool: tool as "vertical_passage_one_way" | "vertical_passage_two_way" } });
          } else if (tool === "elevator") {
            useMazeStore.getState().requestPostEditSplitTarget({ point: [cell.x, cell.y], level, nodeIds: cellNodeIds, action: { tool: "elevator" } });
          } else if (TELEPORT_TOOLS.has(tool)) {
            useMazeStore.getState().requestPostEditSplitTarget({ point: [cell.x, cell.y], level, nodeIds: cellNodeIds, action: { tool: tool as "teleport_one_way" | "teleport_two_way" } });
          }
          return;
        }
      }

      const endpoint = this.resolveActiveEndpointAt([cell.x, cell.y], nodeMap, state.postEditActiveSplitNode, level);
      const resolveSplit = buildSplitNodeResolver(nodeMap, recordOnLevel(state.postEditDraftSplitPoints, level));
      const nodeId = endpoint !== null ? resolveEndpoint(endpoint, resolveSplit) : undefined;
      const meta = state.postEditDraftMeta ?? {
        start: state.start !== null ? nodeEndpoint(state.start) : null,
        finish: state.finish !== null ? nodeEndpoint(state.finish) : null,
      };
      const markerUnderCursor: "start" | "finish" | null =
        endpoint !== null && meta.start !== null && endpointsEqual(meta.start, endpoint) ? "start" :
        endpoint !== null && meta.finish !== null && endpointsEqual(meta.finish, endpoint) ? "finish" : null;
      const nodeById = this.getNodeById(floorNodes);
      // `state.postEditDraftTeleports` is maze-wide and its endpoints can carry their original
      // non-zero `level`, but `resolveSplit` above is built from a bare-keyed, floor-scoped
      // `nodeMap`/`splitPoints` — resolving a level-tagged endpoint against it silently returns
      // `undefined` on any floor above the first (GitHub issue #425). Scope each teleport's
      // endpoints to the active floor first, same as `PostEditRenderer.floorScoped` does for
      // rendering; an off-floor endpoint stays untouched and correctly fails to resolve below.
      const floorNodeIds = new Set(floorNodes.map((n) => n.id));
      const scopedTeleports = state.postEditDraftTeleports.map((t) => ({
        ...t,
        from: floorScopedEndpoint(t.from, level, floorNodeIds) ?? t.from,
        to: floorScopedEndpoint(t.to, level, floorNodeIds) ?? t.to,
      }));
      const teleportHit = pickPostEditTeleportEndpointAt(vpX, vpY, state.activeTessellationConfig, scopedTeleports, nodeById, resolveSplit);
      // Vertical-passage endpoints can live on either floor of the pair, so hit-testing needs the
      // *unscoped* node map/level resolver — `floorNodes`/`nodeById` above only cover the active
      // floor's own nodes.
      const allNodeById = this.getNodeById(state.nodes);
      const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
      const verticalPassageHit = pickPostEditVerticalPassageEndpointAt(vpX, vpY, state.activeTessellationConfig, state.postEditDraftVerticalPassages, allNodeById, resolveNodeLevel, level);
      const elevatorMarkerHit = pickPostEditElevatorEndpointAt(vpX, vpY, state.activeTessellationConfig, state.postEditDraftElevators, allNodeById, resolveNodeLevel, level);
      const elevatorHit = state.postEditDraftElevators.find((e) => e.floors.some((f) => {
        if (f.kind !== "node") return false;
        if ((resolveNodeLevel(f.id) ?? 0) !== (level ?? 0)) return false;
        const node = allNodeById.get(f.id);
        return node !== undefined && endpoint !== null && endpoint.kind === "node" && node.id === endpoint.id;
      }));

      if (button === 2) {
        if (markerUnderCursor) {
          useMazeStore.getState().clearPostEditEndpoint(markerUnderCursor);
        } else if (teleportHit) {
          useMazeStore.getState().removePostEditTeleport(teleportHit.id);
        } else if (verticalPassageHit) {
          useMazeStore.getState().removePostEditVerticalPassage(verticalPassageHit.id);
        } else if (elevatorHit) {
          useMazeStore.getState().removePostEditElevator(elevatorHit.id);
        } else if (state.postEditTeleportPendingFrom !== null) {
          this.cancelPendingTeleport();
        }
        return;
      }
      if (button !== 0) return;

      if (markerUnderCursor) {
        this.armMarkerDrag(markerUnderCursor === "start" ? "set_start" : "set_finish");
        this.markerDragOrigin = markerUnderCursor === "start" ? meta.start : meta.finish;
        return;
      }
      if (teleportHit) {
        // Arm as a drag candidate — resolved on pointerup: if the cursor never moved to a
        // different node, treat it as a plain click (start/complete a new teleport, or cycle
        // direction) instead of a drag.
        this.draggingTeleportEndpoint = teleportHit;
        this.teleportDragMoved = false;
        const originTeleport = scopedTeleports.find((t) => t.id === teleportHit.id);
        this.teleportDragOrigin = originTeleport ? {
          current: teleportHit.end === "from" ? originTeleport.from : originTeleport.to,
          other: teleportHit.end === "from" ? originTeleport.to : originTeleport.from,
        } : null;
        return;
      }
      if (verticalPassageHit) {
        this.draggingVerticalPassageEndpoint = verticalPassageHit;
        this.verticalPassageDragMoved = false;
        const originPassage = state.postEditDraftVerticalPassages.find((p) => p.id === verticalPassageHit.id);
        this.verticalPassageDragOrigin = originPassage ? {
          current: verticalPassageHit.end === "from" ? originPassage.from : originPassage.to,
          other: verticalPassageHit.end === "from" ? originPassage.to : originPassage.from,
        } : null;
        return;
      }
      if (elevatorMarkerHit) {
        this.draggingElevatorEndpoint = elevatorMarkerHit;
        this.elevatorDragMoved = false;
        const originElevator = state.postEditDraftElevators.find((e) => e.id === elevatorMarkerHit.id);
        const originFloor = originElevator?.floors.find((f) => f.kind === "node" && (resolveNodeLevel(f.id) ?? 0) === elevatorMarkerHit.level);
        this.elevatorDragOrigin = originFloor ?? null;
        return;
      }

      // A split node not yet confirmed (`nodeId` undefined) can't be set as start/finish or
      // teleport-clicked yet — no-op, not an error (see postEditEndpoint.ts's doc comment; the
      // same click works once the node is confirmed).
      if (endpoint === null || nodeId === undefined) return;

      // Split points were already handled at the top of this branch (GitHub issue #474) — every
      // path from here targets a plain single-node point.
      if (tool === "set_start") useMazeStore.getState().setPostEditEndpoint("start", endpoint);
      else if (tool === "set_finish") useMazeStore.getState().setPostEditEndpoint("finish", endpoint);
      else if (tool === "elevator") useMazeStore.getState().startPostEditElevatorPlacement(endpoint);
      else if (VERTICAL_PASSAGE_TOOLS.has(tool)) useMazeStore.getState().startPostEditVerticalPassagePlacement(endpoint, tool as "vertical_passage_one_way" | "vertical_passage_two_way");
      else this.tryTeleportClick(nodeId, tool);
      return;
    }

    if (tool === "reset" && button === 0) {
      const edge = pickEdgeAtPosition(vpX, vpY, state.activeTessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
      if (edge && !isSplitCell(edge.from, nodeMap) && !isSplitCell(edge.to, nodeMap)) {
        const nodeKey = this.cellEdgeToNodeKey(edge.from, edge.to, nodeMap, state.postEditActiveSplitNode);
        if (nodeKey) {
          useMazeStore.getState().applyPostEditTool(nodeKey.key, nodeKey.from, nodeKey.to);
          this.beginEdgeDrag(edge.key);
          this.dragDidApply = true;
        }
        this.renderer.updateHover(edge, true);
        return;
      }
      if (isInEdgeVertexDeadZone(vpX, vpY, state.activeTessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet())) return;
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const key = `${cell.x},${cell.y}`;
      if (nodeMap.has(key)) {
        useMazeStore.getState().requestPostEditReset([cell.x, cell.y], level, this.bulkPointAction);
        // A count>1 request opens `postEditResetPrompt` synchronously — don't arm a drag gesture in
        // that case, or it's stuck "held" once the dialog closes (mirrors the `delete` tool's own
        // guard below, GitHub issue #549).
        if (!useMazeStore.getState().postEditResetPrompt) {
          this.beginCellDrag([cell.x, cell.y]);
          this.dragDidApply = true;
        }
      }
      return;
    }
    if (tool === "reset") return; // right/middle click has no reset-tool meaning outside pan

    const edge = pickEdgeAtPosition(vpX, vpY, state.activeTessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet());
    if (!edge) return;

    const nodeKey = this.cellEdgeToNodeKey(edge.from, edge.to, nodeMap, state.postEditActiveSplitNode, level);
    if (nodeKey) {
      if (button === 2) {
        // Right click resets the edge to its generation-time state (GitHub issue #459), mirroring
        // PresetConnectionsController's own right-click reset — regardless of which edge tool is active.
        // A split connection can't be reset via the edge branch (GitHub issue #327), same as the
        // dedicated Reset tool: fall through to a no-op there (whole-point reset stays Reset-tool-only).
        if (!isSplitCell(edge.from, nodeMap) && !isSplitCell(edge.to, nodeMap)) {
          useMazeStore.getState().applyPostEditToolAt("reset", nodeKey.key, nodeKey.from, nodeKey.to);
        }
      } else if (button === 0) {
        useMazeStore.getState().applyPostEditTool(nodeKey.key, nodeKey.from, nodeKey.to);
        if (DRAG_EDGE_TOOLS.has(tool)) {
          this.beginEdgeDrag(edge.key);
          this.dragDidApply = true;
        } else if (state.postEditAutoConfirm) {
          this.scheduleConfirm();
        }
      }
    }
    this.renderer.updateHover(edge);
  }

  onPointerUp(button: number): void {
    if (button === 0 && this.isDragActive) {
      if (this.dragDidApply && useMazeStore.getState().postEditAutoConfirm) {
        this.scheduleConfirm();
      }
      this.dragDidApply = false;
    }
    // Marker drag commits here, before `super.onPointerUp` clears `draggingMarker` (GitHub issue
    // #545) — only one `setMeta` for the whole gesture, and only if the drag actually landed on a
    // different endpoint than it started from (a plain click that never moved must stay a no-op,
    // same as before this change — it simply never got a pointermove to react to).
    if (button === 0 && this.draggingMarker) {
      const override = useMazeStore.getState().postEditDragOverride;
      if (override?.kind === "marker" && (this.markerDragOrigin === null || !endpointsEqual(override.endpoint, this.markerDragOrigin))) {
        useMazeStore.getState().setPostEditEndpoint(this.draggingMarker === "set_start" ? "start" : "finish", override.endpoint);
      }
      useMazeStore.getState().setPostEditDragOverride(null);
      this.markerDragOrigin = null;
    }
    super.onPointerUp(button);
    if (button === 0) {
      this.endEdgeDrag();

      if (this.draggingTeleportEndpoint) {
        if (this.teleportDragMoved) {
          // Commits the whole gesture as a single `moveTeleportEndpoint` command (GitHub issue
          // #545) — the override built up during the drag is exactly the final position.
          const override = useMazeStore.getState().postEditDragOverride;
          if (override?.kind === "teleportEndpoint" && override.id === this.draggingTeleportEndpoint.id) {
            useMazeStore.getState().movePostEditTeleportEndpoint(override.id, override.end, override.endpoint);
          }
        } else {
          const state = useMazeStore.getState();
          if (TELEPORT_TOOLS.has(state.postEditTool)) {
            const level = activeFloorLevel(state);
            const nodeMap = this.getNodeMap(this.getFloorNodes(state));
            const proj = makeProjection(state.activeTessellationConfig);
            const cell = proj.screenToGrid(this.lastViewportPos.x, this.lastViewportPos.y);
            const endpoint = this.resolveActiveEndpointAt([cell.x, cell.y], nodeMap, state.postEditActiveSplitNode, level);
            const resolveSplit = buildSplitNodeResolver(nodeMap, recordOnLevel(state.postEditDraftSplitPoints, level));
            const nodeId = endpoint !== null ? resolveEndpoint(endpoint, resolveSplit) : undefined;
            if (state.postEditTeleportPendingFrom !== null) {
              // A placement is already in progress — clicking an existing endpoint's node
              // completes the new link there rather than cycling that endpoint's direction.
              if (nodeId !== undefined) this.tryTeleportClick(nodeId, state.postEditTool);
            } else {
              state.cyclePostEditTeleportDirection(this.draggingTeleportEndpoint.id);
            }
          }
        }
        useMazeStore.getState().setPostEditDragOverride(null);
        this.draggingTeleportEndpoint = null;
        this.teleportDragMoved = false;
        this.teleportDragOrigin = null;
      }

      if (this.draggingVerticalPassageEndpoint) {
        if (this.verticalPassageDragMoved) {
          // Commits the whole gesture as a single `moveVerticalPassageEndpoint` command plus its
          // suppression pairs (GitHub issue #545) — mirrors `movePostEditVerticalPassageEndpoint`'s
          // own per-move suppression, now issued once on release instead of once per move.
          const override = useMazeStore.getState().postEditDragOverride;
          if (override?.kind === "verticalPassageEndpoint" && override.id === this.draggingVerticalPassageEndpoint.id) {
            useMazeStore.getState().movePostEditVerticalPassageEndpoint(override.id, override.end, override.endpoint);
          }
        } else {
          const state = useMazeStore.getState();
          if (VERTICAL_PASSAGE_TOOLS.has(state.postEditTool)) {
            state.cyclePostEditVerticalPassageDirection(this.draggingVerticalPassageEndpoint.id);
          }
        }
        useMazeStore.getState().setPostEditDragOverride(null);
        this.draggingVerticalPassageEndpoint = null;
        this.verticalPassageDragMoved = false;
        this.verticalPassageDragOrigin = null;
      }

      if (this.draggingElevatorEndpoint) {
        if (this.elevatorDragMoved) {
          // Commits the whole gesture as a single `updateElevatorFloors` command (GitHub issue
          // #566) — dragging any one floor's marker moves every other floor's own endpoint too,
          // resolved by `movePostEditElevatorEndpoint`/`resolveElevatorMove` at dispatch time.
          const override = useMazeStore.getState().postEditDragOverride;
          if (override?.kind === "elevatorEndpoint" && override.id === this.draggingElevatorEndpoint.id) {
            useMazeStore.getState().movePostEditElevatorEndpoint(override.id, override.level, override.endpoint);
          }
        } else {
          // Plain click on an elevator's own marker reopens the floor-picker dialog to edit it,
          // mirroring `startPostEditElevatorPlacement`'s existing-entry edit path.
          const state = useMazeStore.getState();
          const hit = this.draggingElevatorEndpoint;
          const entry = state.postEditDraftElevators.find((e) => e.id === hit.id);
          const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
          const own = entry?.floors.find((f) => f.kind === "node" && (resolveNodeLevel(f.id) ?? 0) === hit.level);
          if (own) state.startPostEditElevatorPlacement(own);
        }
        useMazeStore.getState().setPostEditDragOverride(null);
        this.draggingElevatorEndpoint = null;
        this.elevatorDragMoved = false;
        this.elevatorDragOrigin = null;
      }
    }
  }

  /** Starts or completes a two-click teleport placement at the given node. No-op on completion
   * if the node equals the pending origin node. `nodeId` is always an already-resolved real
   * node — a split node not yet confirmed can't be teleport-clicked yet (see the VERTEX_TOOLS
   * no-op guard in `onPointerDown`). Both `nodeId` and the stored `postEditTeleportPendingFrom`
   * are bare resolved ids (not `PostEditEndpoint`s), so completion re-resolves each one through
   * `resolveNodeIdToEndpoint` before recording the teleport — a bare `nodeEndpoint(id)` here silently
   * dropped every teleport anchored on a split point's numbered slot (id belongs to a slot, not
   * the point's original node), since `buildPostEditPointEntities` never matches a `node`-kind
   * endpoint against `nodesHere`'s own `splitEndpoint(...)` entry for that slot. */
  private tryTeleportClick(nodeId: number, tool: string): void {
    const state = useMazeStore.getState();
    const pendingFrom = state.postEditTeleportPendingFrom;
    if (pendingFrom !== null) {
      if (pendingFrom === nodeId) return;
      const direction = tool === "teleport_two_way" ? "two_way" : "forward";
      const from = resolveNodeIdToEndpoint(state.nodes, state.postEditDraftSplitPoints, pendingFrom);
      const to = resolveNodeIdToEndpoint(state.nodes, state.postEditDraftSplitPoints, nodeId);
      state.addPostEditTeleport(from, to, direction);
      this.renderer.updateTeleportPreview(null, 0, 0);
    } else {
      state.setPostEditTeleportPendingFrom(nodeId);
    }
  }

  private cancelPendingTeleport(): void {
    const state = useMazeStore.getState();
    if (state.postEditTeleportPendingFrom === null) return;
    state.setPostEditTeleportPendingFrom(null);
    this.renderer.updateTeleportPreview(null, 0, 0);
  }

  clearHover(): void {
    this.renderer.updateHover(null);
    this.renderer.updateTeleportPreview(null, 0, 0);
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    if (this.confirmDebounceTimer !== null) {
      clearTimeout(this.confirmDebounceTimer);
    }
  }

  private scheduleConfirm(): void {
    if (this.confirmDebounceTimer !== null) {
      clearTimeout(this.confirmDebounceTimer);
    }
    this.confirmDebounceTimer = setTimeout(() => {
      this.confirmDebounceTimer = null;
      void useMazeStore.getState().confirmPostEdit();
    }, 300);
  }

  /** Resolves both cells of a clicked/dragged edge to their currently active endpoint
   * (`resolveActiveEndpointAt`) and builds the edge key — replaces the old bare-number
   * `${from}-${to}` construction now that a point can have more than one node (GitHub issue
   * #221). `null` if either cell isn't in the field. */
  private cellEdgeToNodeKey(
    fromCell: [number, number],
    toCell: [number, number],
    nodeMap: Map<string, number[]>,
    activeMap: Record<string, PostEditEndpoint>,
    level?: number,
  ): { key: string; from: PostEditEndpoint; to: PostEditEndpoint } | null {
    const from = this.resolveActiveEndpointAt(fromCell, nodeMap, activeMap, level);
    const to = this.resolveActiveEndpointAt(toCell, nodeMap, activeMap, level);
    if (from === null || to === null) return null;
    return { key: edgeKey(from, to), from, to };
  }
}

/** All real nodes at each point, in snapshot order (see `Field::nodes_at`/`all_points`'s
 * determinism contract, mirrored by `maze-wasm/src/analytics.rs`'s node iteration) — index 0 is
 * always the point's original node, guaranteed by that contract, not an observation of `Graph`'s
 * incidental insertion order. */
function buildNodeMap(nodes: NodeDto[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    const list = m.get(key);
    if (list) list.push(n.id); else m.set(key, [n.id]);
  }
  return m;
}
