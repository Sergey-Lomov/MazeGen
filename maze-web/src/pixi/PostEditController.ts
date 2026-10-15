import { useMazeStore } from "../store/mazeStore";
import type { Container } from "pixi.js";
import { pickEdgeAtPosition, isInEdgeVertexDeadZone } from "./fieldEditUtils";
import { pickPostEditTeleportEndpointAt, pickPostEditVerticalPassageEndpointAt, pickPostEditElevatorEndpointAt } from "./postEditUtils";
import type { PostEditTeleportEndpointHit, PostEditVerticalPassageEndpointHit, PostEditElevatorEndpointHit } from "../store/mazeStore";
import { pointerCellAtConfig } from "./pointerInteraction";
import { makeProjection } from "./tessellationProjection";
import type { PostEditRenderer } from "./PostEditRenderer";
import type { NodeDto } from "../wasm/types";
import { BaseController } from "./BaseController";
import {
  type PostEditEndpoint, nodeEndpoint, edgeKey, endpointsEqual, resolveEndpoint, buildSplitNodeResolver, floorScopedEndpoint,
} from "./postEditEndpoint";
import { createFloorNodesSelector, selectNodeLevelResolver } from "./selectors/mazeSelectors";
import { activeFloorLevel } from "../store/storeHelpers";
import { recordOnLevel } from "./fieldEditUtils";
import { resolveNodeIdToEndpoint, buildMultiFloorPointNodeMap, resolveDragTargets, buildPostEditPointEntitiesAt } from "../store/slices/postEditSliceHelpers";
import { postEditEntitiesForPurpose } from "./entityToolKinds";
import type { PostEditPointEntityDescriptor } from "./postEditPointEntities";
import type { FieldEdge } from "./fieldEditUtils";
import { cancelPendingPointerAction, isPointerModalOpen, resetPointerHover } from "./pointerInteraction";

const DRAG_EDGE_TOOLS = new Set(["wall", "passage"]);
const TELEPORT_TOOLS = new Set(["teleport_one_way", "teleport_two_way"]);
const VERTICAL_PASSAGE_TOOLS = new Set(["vertical_passage_one_way", "vertical_passage_two_way"]);
const VERTEX_TOOLS = new Set(["set_start", "set_finish", "teleport_one_way", "teleport_two_way", "vertical_passage_one_way", "vertical_passage_two_way", "elevator"]);

type State = ReturnType<typeof useMazeStore.getState>;

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
  return isPointerModalOpen(
    state.postEditEntityDeletePrompt !== null,
    state.postEditResetPrompt !== null,
    state.postEditEntityPickPrompt !== null,
    state.postEditConnectionSettingsPrompt !== null,
  );
}


export class PostEditController extends BaseController {
  private renderer: PostEditRenderer;

  private confirmDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Every real node at a point, in snapshot order (index 0 is always the point's original node
  // per Field::nodes_at/all_points's contract — see analytics.rs's node iteration) — replaces the
  // old one-id-per-cell map, since a split point (GitHub issue #221) can have more than one.
  private nodeMap: Map<string, number[]> = new Map();
  private nodeMapNodes: NodeDto[] | null = null;
  private readonly selectFloorNodes = createFloorNodesSelector();
  private floorNodeIds: Set<number> = new Set();
  private floorNodeIdsNodes: NodeDto[] | null = null;
  private dragDidApply = false;

  private draggingTeleportEndpoint: PostEditTeleportEndpointHit | null = null;
  private teleportDragMoved = false;
  private draggingVerticalPassageEndpoint: PostEditVerticalPassageEndpointHit | null = null;
  private verticalPassageDragMoved = false;
  private draggingElevatorEndpoint: PostEditElevatorEndpointHit | null = null;
  private elevatorDragMoved = false;
  // Node of the press that armed an element drag. A placement tool adds its own element there when
  // the press is released without moving (GitHub issue #748): every click adds an element, and a
  // press-drag moves the element under the cursor.
  private pressPlacement: { endpoint: PostEditEndpoint; nodeId: number; cell: [number, number] } | null = null;
  // Move tool (GitHub issue #748): an element picked up by a click (or from the pick dialog) follows
  // the pointer with no button held until the next click drops it.
  private carrying = false;
  // The press of that dropping click — the drop is committed on its release.
  private dropPressed = false;

  // Origin endpoints captured at drag-arm time (GitHub issue #545) — the command log only gets one
  // command on release, so pointermove can't lean on "the store already reflects every intermediate
  // step" the way it did when each move appended its own command. `current`/`other` below are always
  // compared against these fixed origins, not against the live `postEditDragOverride`, so dragging
  // back and forth still resolves "did this end up different from where it started" correctly.
  private markerDragOrigin: PostEditEndpoint | null = null;
  private teleportDragOrigin: { current: PostEditEndpoint; other: PostEditEndpoint } | null = null;
  /** Node of the dragged teleport's other endpoint, resolved on the last pointer move. */
  private teleportDragOtherNodeId: number | undefined = undefined;
  private verticalPassageDragOrigin: { current: PostEditEndpoint; other: PostEditEndpoint } | null = null;
  private elevatorDragOrigin: PostEditEndpoint | null = null;

  // Captured at pointerdown so a cell-drag gesture (which re-requests deletion/reset on every cell
  // it visits, via `continueCellDrag`'s callback) keeps using the shift state the drag started
  // with, not whatever it happens to be on a later pointermove (mirrors
  // `PresetConnectionsController`'s own `bulkDelete` field, GitHub issue #550). Shared by both the
  // `delete` tool and the `reset` tool's cell branch (GitHub issue #549) — one shift-held flag per
  // gesture, whichever picker-backed tool is active.
  private bulkPointAction = false;

  private unsubscribeFloor: () => void;
  private settingsHoverCache: { state: State; key: string; configurable: boolean } | null = null;

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Escape") {
      if (this.hasArmedElement) this.cancelPointerGesture();
      useMazeStore.getState().cancelPostEditEntityPick();
      useMazeStore.getState().cancelPostEditConnectionSettings();
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
    // A carried or dragged element belongs to the floor it was picked up on (GitHub issue #748):
    // switching floors cancels the gesture instead of dropping it on another floor's coordinates.
    this.unsubscribeFloor = useMazeStore.subscribe((state, prev) => {
      if (state.activeFloorId !== prev.activeFloorId && this.hasArmedElement) this.cancelPointerGesture();
    });
  }

  /** Floor-scoped node list (GitHub issue #358) — post-edit's own `state.nodes` can span every
   * floor (generation is multi-level-aware, GitHub issue #337; post-edit's confirm no longer
   * restricts to floor 0 either), so every hit-test/nodeMap below narrows to the active floor
   * first via `selectFloorScopedMaze`, same helper `GenerationRenderer` uses. */
  private getFloorNodes(state: ReturnType<typeof useMazeStore.getState>): NodeDto[] {
    // Memoized (GitHub issue #739) — called on every pointermove, and a fresh array each time would
    // also defeat `getNodeMap`'s identity cache, rebuilding the node map per move.
    return this.selectFloorNodes(state.nodes, state.floors, state.activeFloorId);
  }

  private getFloorNodeIds(floorNodes: NodeDto[]): Set<number> {
    if (floorNodes !== this.floorNodeIdsNodes) {
      this.floorNodeIds = new Set(floorNodes.map((n) => n.id));
      this.floorNodeIdsNodes = floorNodes;
    }
    return this.floorNodeIds;
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

  private get hasArmedElement(): boolean {
    return this.draggingMarker !== null
      || this.draggingTeleportEndpoint !== null
      || this.draggingVerticalPassageEndpoint !== null
      || this.draggingElevatorEndpoint !== null;
  }

  private get armedElementMoved(): boolean {
    if (this.draggingMarker !== null) {
      const override = useMazeStore.getState().postEditDragOverride;
      return override?.kind === "marker" && (this.markerDragOrigin === null || !endpointsEqual(override.endpoint, this.markerDragOrigin));
    }
    return this.teleportDragMoved || this.verticalPassageDragMoved || this.elevatorDragMoved;
  }

  /** Arms a drag of exactly the element `descriptor` names — the move tool's counterpart of the
   *  placement tools' hit-test priority, so any element of a cell (on any split node) is movable. */
  private armElement(descriptor: PostEditPointEntityDescriptor, state: State): void {
    switch (descriptor.kind) {
      case "start":
      case "finish":
        this.armMarkerDrag(descriptor.kind === "start" ? "set_start" : "set_finish");
        this.markerDragOrigin = descriptor.endpoint;
        break;
      case "teleport": {
        const entry = state.postEditDraftTeleports.find((t) => t.id === descriptor.id);
        if (!entry) return;
        const end = endpointsEqual(entry.from, descriptor.endpoint) ? "from" : "to";
        this.draggingTeleportEndpoint = { id: entry.id, end };
        this.teleportDragOrigin = { current: entry[end], other: end === "from" ? entry.to : entry.from };
        this.teleportDragMoved = false;
        break;
      }
      case "vertical_passage": {
        const entry = state.postEditDraftVerticalPassages.find((p) => p.id === descriptor.id);
        if (!entry) return;
        const end = endpointsEqual(entry.from, descriptor.endpoint) ? "from" : "to";
        this.draggingVerticalPassageEndpoint = { id: entry.id, end };
        this.verticalPassageDragOrigin = { current: entry[end], other: end === "from" ? entry.to : entry.from };
        this.verticalPassageDragMoved = false;
        break;
      }
      case "elevator": {
        const endpoint = descriptor.endpoint;
        const level = endpoint.kind === "node" ? (state.nodes.find((n) => n.id === endpoint.id)?.level ?? 0) : (endpoint.level ?? 0);
        this.draggingElevatorEndpoint = { id: descriptor.id, level };
        this.elevatorDragOrigin = endpoint;
        this.elevatorDragMoved = false;
        break;
      }
      default:
        return;
    }
    this.renderer.updateCellHover(null);
  }

  /** An element picked in the move tool's dialog starts being carried right away. */
  private takeMoveRequest(state: State): void {
    const request = state.postEditMoveRequest === null ? null : state.takePostEditMoveRequest();
    if (!request) return;
    if (this.hasArmedElement) this.cancelPointerGesture();
    this.armElement(request, state);
    this.carrying = this.hasArmedElement;
    this.pressPlacement = null;
  }

  /** Whether the settings tool can configure anything in the cell at `point`. Cached per store
   *  snapshot and cell: hover calls it on every pointer move, and building the descriptors is not
   *  free. */
  private isConfigurableCell(state: State, point: [number, number], level: number | undefined): boolean {
    const key = `${point[0]},${point[1]}@${level ?? 0}`;
    const cached = this.settingsHoverCache;
    if (cached && cached.state === state && cached.key === key) return cached.configurable;
    const configurable = postEditEntitiesForPurpose("settings", buildPostEditPointEntitiesAt(state, point, level)).length > 0;
    this.settingsHoverCache = { state, key, configurable };
    return configurable;
  }

  /** The settings tool targets an edge only when it is a one-way edge between unsplit cells. */
  private settingsEdgeAt(state: State, vpX: number, vpY: number, nodeMap: Map<string, number[]>, level: number | undefined): { edge: FieldEdge; from: PostEditEndpoint; to: PostEditEndpoint; key: string } | null {
    const edge = pickEdgeAtPosition(vpX, vpY, state.floorFields[state.activeFloorId].fieldConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
    if (!edge || isSplitCell(edge.from, nodeMap) || isSplitCell(edge.to, nodeMap)) return null;
    const nodeKey = this.cellEdgeToNodeKey(edge.from, edge.to, nodeMap, state.postEditActiveSplitNode, level);
    if (!nodeKey) return null;
    const edges = state.postEditDraftEdges ?? {};
    const kinds = [edges[edgeKey(nodeKey.from, nodeKey.to)]?.kind, edges[edgeKey(nodeKey.to, nodeKey.from)]?.kind];
    const isOneWay = kinds.some((kind) => kind === "one_way_forward" || kind === "one_way_backward");
    return isOneWay ? { edge, ...nodeKey } : null;
  }

  /** Adds the active vertex tool's own element at `endpoint` — a click always adds, even on a node
   *  that already holds elements (GitHub issue #748). */
  private placeVertexAt(endpoint: PostEditEndpoint, nodeId: number, tool: string): void {
    const store = useMazeStore.getState();
    if (tool === "set_start") store.setPostEditEndpoint("start", endpoint);
    else if (tool === "set_finish") store.setPostEditEndpoint("finish", endpoint);
    else if (tool === "elevator") store.startPostEditElevatorPlacement(endpoint);
    else if (VERTICAL_PASSAGE_TOOLS.has(tool)) store.startPostEditVerticalPassagePlacement(endpoint, tool as "vertical_passage_one_way" | "vertical_passage_two_way");
    else if (TELEPORT_TOOLS.has(tool)) this.tryTeleportClick(nodeId, tool);
  }

  /** Clears `postEditDragOverride`, unless a split-target prompt is currently open — leaving it
   * set in that case is what keeps the drag preview showing the dropped position while the dialog
   * asks which node to use, instead of snapping back to the pre-drag position for as long as the
   * dialog stays up. `applyPostEditSplitTargetPick`/`cancelPostEditSplitTarget` clear it once the
   * gesture is actually settled (committed or abandoned). Shared by all 4 drag-commit branches in
   * `onPointerUp` (marker, teleport, vertical-passage, elevator endpoints). */
  private clearDragOverrideUnlessPromptOpen(): void {
    if (useMazeStore.getState().postEditSplitTargetPrompt === null) {
      useMazeStore.getState().setPostEditDragOverride(null);
    }
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
    const floorNodes = this.getFloorNodes(state);
    const level = activeFloorLevel(state);
    this.takeMoveRequest(state);
    if (this.carrying && state.postEditTool !== "move") this.cancelPointerGesture();
    if (this.pressPlacement) {
      // A press that leaves its cell (even off the field) is a drag, never a placement click.
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].fieldConfig, vpX, vpY);
      if (x !== this.pressPlacement.cell[0] || y !== this.pressPlacement.cell[1]) this.pressPlacement = null;
    }

    if (this.draggingMarker) {
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].fieldConfig, vpX, vpY);
      const cell = { x, y };
      const nodeMap = this.getNodeMap(floorNodes);
      const endpoint = this.resolveActiveEndpointAt([cell.x, cell.y], nodeMap, state.postEditActiveSplitNode, level);
      // Cursor highlight follows the drag (GitHub issue #612) instead of staying on the origin
      // cell or vanishing for the whole gesture. `endpoint === null` already means "not in field"
      // (`resolveActiveEndpointAt`'s own doc comment), so no separate membership check is needed.
      this.renderer.updateCellHover(endpoint !== null ? [cell.x, cell.y] : null);
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
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].fieldConfig, vpX, vpY);
      const cell = { x, y };
      const nodeMap = this.getNodeMap(floorNodes);
      const endpoint = this.resolveActiveEndpointAt([cell.x, cell.y], nodeMap, state.postEditActiveSplitNode, level);
      // Cursor highlight follows the drag (GitHub issue #612) instead of staying on the origin
      // cell for the whole gesture. `endpoint === null` already means "not in field".
      this.renderer.updateCellHover(endpoint !== null ? [cell.x, cell.y] : null);
      if (endpoint === null) return;
      const floorNodeIds = this.getFloorNodeIds(floorNodes);
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
      // A split tile is never "the other endpoint" here: the drop asks for a node, and the other
      // endpoint's own node is left out of that choice (see the pointerup commit).
      this.teleportDragOtherNodeId = otherId;
      const movedToOther = otherId !== undefined && endpointId !== undefined && otherId === endpointId
        && !isSplitCell([cell.x, cell.y], nodeMap);
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
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].fieldConfig, vpX, vpY);
      const cell = { x, y };
      const nodeMap = this.getNodeMap(floorNodes);
      const endpoint = this.resolveActiveEndpointAt([cell.x, cell.y], nodeMap, state.postEditActiveSplitNode, level);
      // Cursor highlight follows the drag (GitHub issue #612) instead of staying on the origin
      // cell for the whole gesture. A vertical-passage endpoint only accepts a plain node, same
      // condition as the early-return below.
      this.renderer.updateCellHover(endpoint !== null && endpoint.kind === "node" ? [cell.x, cell.y] : null);
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
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].fieldConfig, vpX, vpY);
      const cell = { x, y };
      const nodeMap = this.getNodeMap(floorNodes);
      const endpoint = this.resolveActiveEndpointAt([cell.x, cell.y], nodeMap, state.postEditActiveSplitNode, level);
      // Cursor highlight follows the drag (GitHub issue #612) instead of staying on the origin
      // cell for the whole gesture. An elevator endpoint only accepts a plain node, same condition
      // as the early-return below.
      this.renderer.updateCellHover(endpoint !== null && endpoint.kind === "node" ? [cell.x, cell.y] : null);
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
          const proj = makeProjection(state.floorFields[state.activeFloorId].fieldConfig);
          const { x: px, y: py } = proj.gridToScreen(fromNode.x, fromNode.y);
          this.renderer.updateTeleportPreview({ x: px, y: py }, vpX, vpY);
        }
      } else {
        this.renderer.updateTeleportPreview(null, 0, 0);
      }
    } else {
      this.renderer.updateTeleportPreview(null, 0, 0);
    }

    if (state.postEditTool === "settings") {
      // Highlights only what the settings tool can configure: a one-way edge near the cursor, else
      // the cell when it holds a configurable element (GitHub issue #748).
      const nodeMap = this.getNodeMap(floorNodes);
      const target = this.settingsEdgeAt(state, vpX, vpY, nodeMap, level);
      if (target) {
        this.renderer.updateCellHover(null);
        this.renderer.updateHover(target.edge);
        return;
      }
      this.renderer.updateHover(null);
      const cfg = state.floorFields[state.activeFloorId].fieldConfig;
      if (isInEdgeVertexDeadZone(vpX, vpY, cfg, this.renderer.getCachedCells(), this.renderer.getCachedCellSet())) {
        this.renderer.updateCellHover(null);
        return;
      }
      const [x, y] = pointerCellAtConfig(cfg, vpX, vpY);
      this.renderer.updateCellHover(this.isConfigurableCell(state, [x, y], level) ? [x, y] : null);
      return;
    }

    if (state.postEditTool === "manage_split_nodes" || state.postEditTool === "delete" || state.postEditTool === "move" || VERTEX_TOOLS.has(state.postEditTool)) {
      // Vertex tools (set start/finish, teleports) and manage_split_nodes all target a whole
      // point, not one of its faces — highlight the cell under the cursor, not a wall/edge (see
      // GitHub issue #221's follow-up for manage_split_nodes; issue #326 extends this to every
      // vertex tool, replacing the wall-highlight reuse / missing highlight they had before).
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].fieldConfig, vpX, vpY);
      const cell = { x, y };
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
        const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].fieldConfig, vpX, vpY);
        const cell = { x, y };
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
        const edge = pickEdgeAtPosition(vpX, vpY, state.floorFields[state.activeFloorId].fieldConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
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
      const edge = pickEdgeAtPosition(vpX, vpY, state.floorFields[state.activeFloorId].fieldConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
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
      if (isInEdgeVertexDeadZone(vpX, vpY, state.floorFields[state.activeFloorId].fieldConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet())) {
        this.renderer.updateHover(null);
        this.renderer.updateCellHover(null);
        return;
      }
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].fieldConfig, vpX, vpY);
      const cell = { x, y };
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

    const edge = pickEdgeAtPosition(vpX, vpY, state.floorFields[state.activeFloorId].fieldConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
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
    this.takeMoveRequest(state);

    if (this.carrying) {
      // A carried element is dropped by the release of the next left click; a right click cancels.
      if (button === 0) this.dropPressed = true;
      else if (button === 2) this.cancelPointerGesture();
      return;
    }

    if (tool === "move") {
      if (button !== 0) return;
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].fieldConfig, vpX, vpY);
      if (!nodeMap.has(`${x},${y}`)) return;
      // A single element is picked up by this press (drag it, or release to carry it); several
      // open the pick dialog, whose choice is carried (`takeMoveRequest`).
      state.requestPostEditEntityPick([x, y], level, "move");
      const request = useMazeStore.getState().takePostEditMoveRequest();
      if (request) {
        this.armElement(request, useMazeStore.getState());
        this.pressPlacement = null;
      }
      return;
    }

    if (tool === "settings") {
      if (button !== 0) return;
      const target = this.settingsEdgeAt(state, vpX, vpY, nodeMap, level);
      if (target) {
        state.applyPostEditToolAt("one_way_flip", target.key, target.from, target.to);
        if (state.postEditAutoConfirm) this.scheduleConfirm();
        return;
      }
      const cfg = state.floorFields[state.activeFloorId].fieldConfig;
      if (isInEdgeVertexDeadZone(vpX, vpY, cfg, this.renderer.getCachedCells(), this.renderer.getCachedCellSet())) return;
      const [x, y] = pointerCellAtConfig(cfg, vpX, vpY);
      state.requestPostEditEntityPick([x, y], level, "settings");
      return;
    }

    if (tool === "manage_split_nodes") {
      if (button !== 0) return;
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].fieldConfig, vpX, vpY);
      const cell = { x, y };
      const key = `${cell.x},${cell.y}`;
      useMazeStore.getState().setPostEditFocusedPoint(nodeMap.has(key) ? [cell.x, cell.y] : null);
      return;
    }

    if (tool === "delete") {
      if (button !== 0) return;
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].fieldConfig, vpX, vpY);
      const cell = { x, y };
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
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].fieldConfig, vpX, vpY);
      const cell = { x, y };

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
      // endpoints to the active floor first, same as `PostEditRenderer.sceneBase`'s `onLevel` does
      // for rendering; an off-floor endpoint stays untouched and correctly fails to resolve below.
      const floorNodeIds = this.getFloorNodeIds(floorNodes);
      const scopedTeleports = state.postEditDraftTeleports.map((t) => ({
        ...t,
        from: floorScopedEndpoint(t.from, level, floorNodeIds) ?? t.from,
        to: floorScopedEndpoint(t.to, level, floorNodeIds) ?? t.to,
      }));
      const teleportHit = pickPostEditTeleportEndpointAt(vpX, vpY, state.floorFields[state.activeFloorId].fieldConfig, scopedTeleports, nodeById, resolveSplit);
      // Vertical-passage endpoints can live on either floor of the pair, so hit-testing needs the
      // *unscoped* node map/level resolver — `floorNodes`/`nodeById` above only cover the active
      // floor's own nodes.
      const allNodeById = this.getNodeById(state.nodes);
      const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
      const verticalPassageHit = pickPostEditVerticalPassageEndpointAt(vpX, vpY, state.floorFields[state.activeFloorId].fieldConfig, state.postEditDraftVerticalPassages, allNodeById, resolveNodeLevel, level);
      const elevatorMarkerHit = pickPostEditElevatorEndpointAt(vpX, vpY, state.floorFields[state.activeFloorId].fieldConfig, state.postEditDraftElevators, allNodeById, resolveNodeLevel, level);
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

      // A press on an existing element arms a drag candidate for it, resolved on pointerup: moved
      // to another node — the element moves; released in place — this tool adds its own new
      // element at the pressed node (GitHub issue #748), whatever already occupies it. A split node
      // not yet confirmed (`nodeId` undefined) can't host a new element yet.
      const placement = endpoint !== null && nodeId !== undefined ? { endpoint, nodeId, cell: [cell.x, cell.y] as [number, number] } : null;
      if (markerUnderCursor) {
        this.armMarkerDrag(markerUnderCursor === "start" ? "set_start" : "set_finish");
        this.markerDragOrigin = markerUnderCursor === "start" ? meta.start : meta.finish;
        this.pressPlacement = placement;
        this.renderer.updateCellHover(null);
        return;
      }
      if (teleportHit) {
        this.pressPlacement = placement;
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
        this.pressPlacement = placement;
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
        this.pressPlacement = placement;
        this.draggingElevatorEndpoint = elevatorMarkerHit;
        this.elevatorDragMoved = false;
        const originElevator = state.postEditDraftElevators.find((e) => e.id === elevatorMarkerHit.id);
        const originFloor = originElevator?.floors.find((f) => f.kind === "node" && (resolveNodeLevel(f.id) ?? 0) === elevatorMarkerHit.level);
        this.elevatorDragOrigin = originFloor ?? null;
        return;
      }

      // A split node not yet confirmed (`nodeId` undefined) can't be set as start/finish or
      // teleport-clicked yet — no-op, not an error (see postEditEndpoint.ts's doc comment; the
      // same click works once the node is confirmed). Split points were already handled at the top
      // of this branch (GitHub issue #474) — every path from here targets a plain single-node point.
      if (placement) this.placeVertexAt(placement.endpoint, placement.nodeId, tool);
      return;
    }

    if (tool === "reset" && button === 0) {
      const edge = pickEdgeAtPosition(vpX, vpY, state.floorFields[state.activeFloorId].fieldConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
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
      if (isInEdgeVertexDeadZone(vpX, vpY, state.floorFields[state.activeFloorId].fieldConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet())) return;
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].fieldConfig, vpX, vpY);
      const cell = { x, y };
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

    const edge = pickEdgeAtPosition(vpX, vpY, state.floorFields[state.activeFloorId].fieldConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet());
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
    if (button === 0 && this.hasArmedElement) {
      // Move tool (GitHub issue #748): a release that did not move the element starts carrying it;
      // while carrying, only the release of the dropping click commits.
      if (this.carrying && !this.dropPressed) return;
      if (!this.carrying && !this.armedElementMoved && useMazeStore.getState().postEditTool === "move") {
        this.carrying = true;
        return;
      }
    }
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
      const marker = this.draggingMarker;
      const override = useMazeStore.getState().postEditDragOverride;
      if (override?.kind === "marker" && (this.markerDragOrigin === null || !endpointsEqual(override.endpoint, this.markerDragOrigin))) {
        // GitHub issue #567 follow-up: the override's endpoint was already silently resolved to a
        // single node during the drag preview (`resolveActiveEndpointAt`'s active/first-node
        // fallback), same as the teleport/vertical-passage/elevator drag-commit branches below —
        // re-derive the landing POINT from that resolved node and check it for split-ness before
        // committing, so a drop on a split tile prompts for which node instead of silently
        // attaching to whichever node the preview happened to pick.
        const state = useMazeStore.getState();
        const overrideEndpoint = override.endpoint;
        const droppedNode = overrideEndpoint.kind === "node" ? state.nodes.find((n) => n.id === overrideEndpoint.id) : undefined;
        const pointNodeMap = buildMultiFloorPointNodeMap(state.nodes);
        const { picks, queue } = droppedNode
          ? resolveDragTargets([{ point: [droppedNode.x, droppedNode.y], level: droppedNode.level }], pointNodeMap)
          : { picks: [], queue: [] };
        if (queue.length > 0) {
          // Same "which node?" prompt a fresh click already gets on a split cell (see the
          // `VERTEX_TOOLS`/`requestPostEditSplitTarget` branch above) — `set_start`/`set_finish` is
          // a plain single-target action (no `queue`/`picks` needed, see `postEditSplitTargetPrompt`'s
          // own doc comment), so `queue`/`picks` here are only used to detect split-ness; the prompt
          // itself is opened without them, same as that click branch.
          const first = queue[0];
          state.requestPostEditSplitTarget({
            point: first.point, level: first.level, nodeIds: first.nodeIds,
            action: { tool: marker === "set_start" ? "set_start" : "set_finish" },
          });
        } else {
          const target = picks[0] ?? overrideEndpoint;
          useMazeStore.getState().setPostEditEndpoint(marker === "set_start" ? "start" : "finish", target);
        }
      } else if (this.pressPlacement) {
        this.placeVertexAt(this.pressPlacement.endpoint, this.pressPlacement.nodeId, useMazeStore.getState().postEditTool);
      }
      // Leave `postEditDragOverride` alone while a split-target prompt is open (queued above) — see
      // `clearDragOverrideUnlessPromptOpen`'s own doc comment for why.
      this.clearDragOverrideUnlessPromptOpen();
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
            const state = useMazeStore.getState();
            const hit = this.draggingTeleportEndpoint;
            // GitHub issue #567: the override's endpoint was already silently resolved to a single
            // node during the drag preview (`resolveActiveEndpointAt`'s active/first-node fallback)
            // — re-derive the landing POINT from that resolved node and check it for split-ness
            // before committing, so a drop on a split tile prompts instead of silently attaching to
            // whichever node the preview happened to pick.
            const overrideEndpoint = override.endpoint;
            const node = overrideEndpoint.kind === "node" ? state.nodes.find((n) => n.id === overrideEndpoint.id) : undefined;
            const pointNodeMap = buildMultiFloorPointNodeMap(state.nodes);
            const { picks, queue } = node
              ? resolveDragTargets([{ point: [node.x, node.y], level: node.level }], pointNodeMap)
              : { picks: [], queue: [] };
            // The endpoint may land on any node of a split tile except the other endpoint's own.
            const otherNodeId = this.teleportDragOtherNodeId;
            const candidates = queue.length > 0 ? queue[0].nodeIds.filter((id) => id !== otherNodeId) : [];
            if (queue.length > 0 && candidates.length === 1) {
              state.movePostEditTeleportEndpoint(
                override.id, override.end, resolveNodeIdToEndpoint(state.nodes, state.postEditDraftSplitPoints, candidates[0]),
              );
            } else if (queue.length > 0) {
              // `queue[0]` is ALSO the point about to be shown — `requestPostEditSplitTarget`'s
              // `point`/`level`/`nodeIds` always mirror `queue[0]`, `queue` itself stays un-shifted
              // (current entry included) so `applyPostEditSplitTargetPick` can read `queue[0]`'s own
              // `targetIndex` for whichever point is currently on screen.
              const first = queue[0];
              state.requestPostEditSplitTarget({
                point: first.point, level: first.level, nodeIds: first.nodeIds,
                action: { tool: "move_teleport_endpoint", id: hit.id, end: hit.end },
                queue, picks,
                ...(otherNodeId !== undefined && first.nodeIds.includes(otherNodeId) ? { excludedNodeId: otherNodeId } : {}),
              });
            } else {
              state.movePostEditTeleportEndpoint(override.id, override.end, override.endpoint);
            }
          }
        } else if (this.pressPlacement) {
          this.placeVertexAt(this.pressPlacement.endpoint, this.pressPlacement.nodeId, useMazeStore.getState().postEditTool);
        }
        // Leave `postEditDragOverride` alone while a split-target prompt is open (queued above) —
        // see `clearDragOverrideUnlessPromptOpen`'s own doc comment for why.
        this.clearDragOverrideUnlessPromptOpen();
        this.draggingTeleportEndpoint = null;
        this.teleportDragMoved = false;
        this.teleportDragOrigin = null;
        this.teleportDragOtherNodeId = undefined;
      }

      if (this.draggingVerticalPassageEndpoint) {
        if (this.verticalPassageDragMoved) {
          // Commits the whole gesture as a single `moveVerticalPassageEndpoint` command (GitHub
          // issue #545), issued once on release instead of once per move.
          const override = useMazeStore.getState().postEditDragOverride;
          if (override?.kind === "verticalPassageEndpoint" && override.id === this.draggingVerticalPassageEndpoint.id) {
            const state = useMazeStore.getState();
            const hit = this.draggingVerticalPassageEndpoint;
            const overrideEndpoint = override.endpoint;
            const draggedNode = overrideEndpoint.kind === "node" ? state.nodes.find((n) => n.id === overrideEndpoint.id) : undefined;
            // GitHub issue #567/#566: dragging one end also re-targets the OTHER end to the same
            // (x, y) on its own floor — that other point can independently be split too, so it must
            // be queued for its own pick alongside the dragged end's own point, not silently
            // resolved to its first node via `resolveVerticalPassageMove`'s plain `findNodeAt`.
            const entry = state.postEditDraftVerticalPassages.find((p) => p.id === hit.id);
            const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
            const otherEp = entry ? (hit.end === "from" ? entry.to : entry.from) : undefined;
            const otherLevel = otherEp?.kind === "node" ? resolveNodeLevel(otherEp.id) : otherEp?.level;
            const pointNodeMap = buildMultiFloorPointNodeMap(state.nodes);
            const { picks, queue } = draggedNode
              ? resolveDragTargets(
                  [{ point: [draggedNode.x, draggedNode.y], level: draggedNode.level }, { point: [draggedNode.x, draggedNode.y], level: otherLevel }],
                  pointNodeMap,
                )
              : { picks: [], queue: [] };
            if (queue.length > 0) {
              const first = queue[0];
              state.requestPostEditSplitTarget({
                point: first.point, level: first.level, nodeIds: first.nodeIds,
                action: { tool: "move_vertical_passage_endpoint", id: hit.id, end: hit.end },
                queue, picks,
              });
            } else {
              state.movePostEditVerticalPassageEndpoint(override.id, override.end, override.endpoint);
            }
          }
        } else if (this.pressPlacement) {
          this.placeVertexAt(this.pressPlacement.endpoint, this.pressPlacement.nodeId, useMazeStore.getState().postEditTool);
        }
        // See `clearDragOverrideUnlessPromptOpen`'s own doc comment for why this is conditional.
        this.clearDragOverrideUnlessPromptOpen();
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
            const state = useMazeStore.getState();
            const hit = this.draggingElevatorEndpoint;
            const overrideEndpoint = override.endpoint;
            const draggedNode = overrideEndpoint.kind === "node" ? state.nodes.find((n) => n.id === overrideEndpoint.id) : undefined;
            // GitHub issue #567/#566: the drag re-targets EVERY other floor's own endpoint to the
            // same (x, y) too — each of those floors' own point can independently be split, and the
            // drop can land on more than one split floor at once, so every affected floor is queued
            // for its own pick (ascending level order, dragged floor first — mirrors
            // `resolveElevatorMove`'s own `others` ordering) instead of each silently resolving to
            // its first node via `findNodeAt`.
            const entry = state.postEditDraftElevators.find((e) => e.id === hit.id);
            const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
            const otherLevels = entry
              ? entry.floors
                  .map((f) => (f.kind === "node" ? (resolveNodeLevel(f.id) ?? 0) : (f.level ?? 0)))
                  .filter((lvl) => lvl !== hit.level)
                  .sort((a, b) => a - b)
              : [];
            const pointNodeMap = buildMultiFloorPointNodeMap(state.nodes);
            const targets = draggedNode
              ? [{ point: [draggedNode.x, draggedNode.y] as [number, number], level: hit.level }, ...otherLevels.map((lvl) => ({ point: [draggedNode.x, draggedNode.y] as [number, number], level: lvl }))]
              : [];
            const { picks, queue } = draggedNode ? resolveDragTargets(targets, pointNodeMap) : { picks: [], queue: [] };
            if (queue.length > 0) {
              const first = queue[0];
              state.requestPostEditSplitTarget({
                point: first.point, level: first.level, nodeIds: first.nodeIds,
                action: { tool: "move_elevator_endpoint", id: hit.id, levels: [hit.level, ...otherLevels] },
                queue, picks,
              });
            } else {
              state.movePostEditElevatorEndpoint(override.id, override.level, override.endpoint);
            }
          }
        } else if (this.pressPlacement) {
          this.placeVertexAt(this.pressPlacement.endpoint, this.pressPlacement.nodeId, useMazeStore.getState().postEditTool);
        }
        // See `clearDragOverrideUnlessPromptOpen`'s own doc comment for why this is conditional.
        this.clearDragOverrideUnlessPromptOpen();
        this.draggingElevatorEndpoint = null;
        this.elevatorDragMoved = false;
        this.elevatorDragOrigin = null;
      }
      this.pressPlacement = null;
      this.carrying = false;
      this.dropPressed = false;
    }
  }

  cancelPointerGesture(): void {
    const state = useMazeStore.getState();
    const gestureActive = this.isDragActive
      || this.draggingMarker !== null
      || this.draggingTeleportEndpoint !== null
      || this.draggingVerticalPassageEndpoint !== null
      || this.draggingElevatorEndpoint !== null;
    if (this.dragDidApply && state.postEditAutoConfirm) {
      this.scheduleConfirm();
    }
    this.dragDidApply = false;

    super.cancelPointerGesture();
    this.markerDragOrigin = null;
    this.teleportDragOrigin = null;
    this.verticalPassageDragOrigin = null;
    this.elevatorDragOrigin = null;
    this.draggingTeleportEndpoint = null;
    this.teleportDragMoved = false;
    this.draggingVerticalPassageEndpoint = null;
    this.verticalPassageDragMoved = false;
    this.draggingElevatorEndpoint = null;
    this.elevatorDragMoved = false;
    this.pressPlacement = null;
    this.carrying = false;
    this.dropPressed = false;
    this.bulkPointAction = false;
    if (gestureActive) {
      useMazeStore.getState().setPostEditDragOverride(null);
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
    cancelPendingPointerAction(
      state.postEditTeleportPendingFrom,
      () => state.setPostEditTeleportPendingFrom(null),
      () => this.renderer.updateTeleportPreview(null, 0, 0),
    );
  }

  clearHover(): void {
    resetPointerHover({
      updateHover: (edge) => this.renderer.updateHover(edge),
      updateTeleportPreview: (point, x, y) => this.renderer.updateTeleportPreview(point, x, y),
    });
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    this.unsubscribeFloor();
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
