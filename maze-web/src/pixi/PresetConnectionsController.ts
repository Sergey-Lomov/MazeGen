import { useMazeStore } from "../store/mazeStore";
import type { NodeLockKind } from "../wasm/types";
import type { Container } from "pixi.js";
import { pickEdgeAtPosition, pickTeleportEndpointAt, pickVerticalPassageEndpointAt, pickElevatorEndpointAt, isInEdgeVertexDeadZone, presetEdgeStateAt, type FieldEdge, type PresetTeleportEndpointHit, type PresetVerticalPassageEndpointHit, type PresetElevatorEndpointHit } from "./fieldEditUtils";
import { presetEndpoint, presetEndpointKey, presetEndpointsEqual, type PresetEndpoint } from "./presetEndpoint";
import { presetPurposeEntitiesAt } from "./entityToolKinds";
import type { PresetPointEntityDescriptor } from "./pointEntities";
import { encodePoint } from "./tessellationProjection";
import type { PresetConnectionsRenderer } from "./PresetConnectionsRenderer";
import { BaseController } from "./BaseController";
import { activeFloorLevel } from "../store/storeHelpers";
import { cancelPendingPointerAction, pointerCellAtConfig, resetPointerHover } from "./pointerInteraction";
import { isPresetConnectionsModalOpen, teleportsOnLevel } from "./presetConnectionsInteraction";
import { notifyEditRefusal, TELEPORT_OUTSIDE_FIELD } from "../notifications/editRefusalNotifications";

const DRAG_EDGE_TOOLS = new Set(["wall", "passage", "reset"]);
const TELEPORT_TOOLS = new Set(["teleport_one_way", "teleport_two_way"]);
const VERTICAL_PASSAGE_TOOLS = new Set(["vertical_passage_one_way", "vertical_passage_two_way"]);
const VERTEX_TOOLS = new Set(["set_start", "set_finish", "teleport_one_way", "teleport_two_way", "vertical_passage_one_way", "vertical_passage_two_way", "elevator"]);
// Node-locking and generation-source tools target a whole cell/point, not an edge — they hover
// the cell under the cursor (GitHub issue #456), same as `VERTEX_TOOLS` / `manage_split_nodes`.
const CELL_HOVER_TOOLS = new Set(["lock_in", "lock_out", "full_lock", "gen_source", "move"]);

type State = ReturnType<typeof useMazeStore.getState>;

function splitKeyOf(point: [number, number], level: number | undefined): string {
  return level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
}

export class PresetConnectionsController extends BaseController {
  private renderer: PresetConnectionsRenderer;
  private draggingTeleportEndpoint: PresetTeleportEndpointHit | null = null;
  private teleportDragMoved = false;
  private draggingVerticalPassageEndpoint: PresetVerticalPassageEndpointHit | null = null;
  private verticalPassageDragMoved = false;
  private draggingElevatorEndpoint: PresetElevatorEndpointHit | null = null;
  private elevatorDragMoved = false;
  // User lock being dragged (GitHub issue #748): by a lock tool's press, or by the move tool.
  private draggingLock: PresetEndpoint | null = null;
  private lockDragMoved = false;
  // The generation source is only movable by the move tool (GitHub issue #748), so it has no
  // `BaseController.draggingMarker` value of its own.
  private draggingGenSource = false;
  // Whether a start/finish/gen-source marker drag (GitHub issue #613) actually moved to a different
  // cell — mirrors `teleportDragMoved`/`verticalPassageDragMoved`/`elevatorDragMoved` above.
  private markerDragMoved = false;
  // Cell of the press that armed an element drag. A placement tool adds its own element there when
  // the press is released without moving (GitHub issue #748): every click adds an element, and a
  // press-drag moves the element under the cursor.
  private pressCell: [number, number] | null = null;
  // Move tool (GitHub issue #748): an element picked up by a click (or from the pick dialog) follows
  // the pointer with no button held until the next click drops it.
  private carrying = false;
  // The press of that dropping click — the drop is committed on its release.
  private dropPressed = false;
  // Captured at pointerdown so a cell-drag gesture (which re-requests deletion on every cell it
  // visits, via `continueCellDrag`'s callback) keeps using the shift state the drag started with,
  // not whatever it happens to be on a later pointermove.
  private bulkDelete = false;

  private unsubscribeFloor: () => void;
  private settingsHoverCache: { state: State; key: string; configurable: boolean } | null = null;

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Escape") {
      if (this.hasArmedElement) this.cancelPointerGesture();
      this.cancelPendingTeleport();
      const state = useMazeStore.getState();
      state.cancelPresetVerticalPassagePlacement();
      state.cancelPresetElevatorPlacement();
      state.cancelPresetSplitTarget();
      state.cancelPresetEntityDelete();
      state.cancelPresetEntityPick();
      state.cancelPresetConnectionSettings();
      state.cancelPresetLockSettings();
    }
  };

  constructor(
    getViewport: () => Container,
    renderer: PresetConnectionsRenderer,
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

  private get draggedMarker(): "start" | "finish" | "gen_source" | null {
    if (this.draggingMarker === "set_start") return "start";
    if (this.draggingMarker === "set_finish") return "finish";
    return this.draggingGenSource ? "gen_source" : null;
  }

  private get hasArmedElement(): boolean {
    return this.draggedMarker !== null
      || this.draggingTeleportEndpoint !== null
      || this.draggingVerticalPassageEndpoint !== null
      || this.draggingElevatorEndpoint !== null
      || this.draggingLock !== null;
  }

  private get armedElementMoved(): boolean {
    return this.markerDragMoved || this.teleportDragMoved || this.verticalPassageDragMoved || this.elevatorDragMoved || this.lockDragMoved;
  }

  /** Arms a drag of exactly the element `descriptor` names — the move tool's counterpart of the
   *  placement tools' hit-test priority, so any element of a cell (on any split node) is movable. */
  private armElement(descriptor: PresetPointEntityDescriptor, state: State): void {
    switch (descriptor.kind) {
      case "start":
        this.armMarkerDrag("set_start");
        break;
      case "finish":
        this.armMarkerDrag("set_finish");
        break;
      case "gen_source":
        this.draggingGenSource = true;
        break;
      case "teleport": {
        const entry = state.presetTeleports.find((t) => t.id === Number(descriptor.id));
        if (!entry) return;
        this.draggingTeleportEndpoint = { id: entry.id, end: presetEndpointsEqual(entry.from, descriptor.endpoint) ? "from" : "to" };
        break;
      }
      case "vertical_passage": {
        const entry = state.presetVerticalPassages.find((v) => v.id === Number(descriptor.id));
        if (!entry) return;
        this.draggingVerticalPassageEndpoint = { id: entry.id, end: presetEndpointsEqual(entry.from, descriptor.endpoint) ? "from" : "to" };
        break;
      }
      case "elevator":
        this.draggingElevatorEndpoint = { id: Number(descriptor.id), level: descriptor.endpoint.level ?? 0 };
        break;
      case "lock":
        this.draggingLock = descriptor.endpoint;
        break;
      default:
        return;
    }
    this.markerDragMoved = false;
    this.teleportDragMoved = false;
    this.verticalPassageDragMoved = false;
    this.elevatorDragMoved = false;
    this.lockDragMoved = false;
    this.renderer.updateCellHover(null);
  }

  /** An element picked in the move tool's dialog starts being carried right away. */
  private takeMoveRequest(state: State): void {
    const request = state.presetMoveRequest === null ? null : state.takePresetMoveRequest();
    if (!request) return;
    if (this.hasArmedElement) this.cancelPointerGesture();
    this.armElement(request, state);
    this.carrying = this.hasArmedElement;
    this.pressCell = null;
  }

  private isSplitAt(state: State, point: [number, number], level: number | undefined): boolean {
    return (state.presetSplitPoints[splitKeyOf(point, level)]?.length ?? 0) > 0;
  }

  /** Whether the settings tool can configure anything in the cell at `point`. Cached per store
   *  snapshot and cell: hover calls it on every pointer move, and building the descriptors is not
   *  free. */
  private isConfigurableCell(state: State, point: [number, number], level: number | undefined): boolean {
    const key = splitKeyOf(point, level);
    const cached = this.settingsHoverCache;
    if (cached && cached.state === state && cached.key === key) return cached.configurable;
    const configurable = presetPurposeEntitiesAt(state, point, level, "settings").length > 0;
    this.settingsHoverCache = { state, key, configurable };
    return configurable;
  }

  /** The settings tool targets an edge only when it is a one-way edge between unsplit cells. */
  private settingsEdgeAt(state: State, vpX: number, vpY: number): FieldEdge | null {
    const cfg = state.floorFields[state.activeFloorId].tessellationConfig;
    const edge = pickEdgeAtPosition(vpX, vpY, cfg, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
    if (!edge) return null;
    const level = activeFloorLevel(state);
    if (this.isSplitAt(state, edge.from, level) || this.isSplitAt(state, edge.to, level)) return null;
    const edgeState = presetEdgeStateAt(state.presetConnections, edge, state.presetActiveSplitNode, level);
    return edgeState === "one_way_forward" || edgeState === "one_way_backward" ? edge : null;
  }

  onPointerMove(canvasX: number, canvasY: number): void {
    if (this.handlePanMove(canvasX, canvasY)) return;

    const state = useMazeStore.getState();
    if (state.openCard !== "preset_connections") return;
    if (isPresetConnectionsModalOpen(state)) {
      this.renderer.updateHover(null);
      this.renderer.updateCellHover(null);
      return;
    }

    const { x: vpX, y: vpY } = this.toViewport(canvasX, canvasY);
    this.takeMoveRequest(state);
    if (this.carrying && state.presetConnectionsTool !== "move") this.cancelPointerGesture();
    if (this.pressCell) {
      // A press that leaves its cell (even off the field) is a drag, never a placement click.
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      if (x !== this.pressCell[0] || y !== this.pressCell[1]) this.pressCell = null;
    }

    const marker = this.draggedMarker;
    if (marker) {
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      const cell = { x, y };
      // Cursor highlight follows the drag (GitHub issue #612) instead of staying on the origin
      // cell or vanishing for the whole gesture.
      const inField = this.renderer.getCachedCellSet().has(encodePoint(cell.x, cell.y));
      this.renderer.updateCellHover(inField ? [cell.x, cell.y] : null);
      if (!inField) return;
      const coords: [number, number] = [cell.x, cell.y];
      const origin = marker === "start" ? state.presetStart : marker === "finish" ? state.presetFinish : state.presetGenSource;
      const originLevel = activeFloorLevel(state);
      const onOrigin = origin !== null && (origin.level ?? 0) === (originLevel ?? 0)
        && origin.point[0] === coords[0] && origin.point[1] === coords[1];
      // Live preview only (GitHub issue #613) — nothing is committed to the marker until
      // pointerup, and only if the cursor actually left the origin cell.
      if (!onOrigin) {
        this.markerDragMoved = true;
        useMazeStore.getState().setPresetDragOverride({ kind: "marker", marker, point: coords });
      } else if (useMazeStore.getState().presetDragOverride?.kind === "marker") {
        // Returning to the drag origin restores the committed marker position in the live preview.
        // Keep the gesture armed so a later move can create a new override again (GitHub issue
        // #695).
        useMazeStore.getState().setPresetDragOverride(null);
      }
      return;
    }

    if (this.draggingLock) {
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      const inField = this.renderer.getCachedCellSet().has(encodePoint(x, y));
      this.renderer.updateCellHover(inField ? [x, y] : null);
      if (!inField) return;
      const from = this.draggingLock;
      // Live preview only: the move is committed on release, so a cancelled carry leaves no trace.
      if (from.point[0] !== x || from.point[1] !== y) {
        this.lockDragMoved = true;
        useMazeStore.getState().setPresetDragOverride({ kind: "lock", from, point: [x, y] });
      } else {
        useMazeStore.getState().setPresetDragOverride(null);
      }
      return;
    }

    if (this.draggingTeleportEndpoint) {
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      const cell = { x, y };
      // Cursor highlight follows the drag (GitHub issue #612) instead of staying on the origin
      // cell for the whole gesture.
      const inField = this.renderer.getCachedCellSet().has(encodePoint(cell.x, cell.y));
      this.renderer.updateCellHover(inField ? [cell.x, cell.y] : null);
      if (!inField) return;
      const hit = this.draggingTeleportEndpoint;
      const teleport = state.presetTeleports.find(t => t.id === hit.id);
      if (!teleport) return;
      const current = hit.end === "from" ? teleport.from : teleport.to;
      const other = hit.end === "from" ? teleport.to : teleport.from;
      // A split tile is never "the other endpoint" here: the drop asks for a node, and the other
      // endpoint's own node is left out of that choice (`movePresetTeleportEndpointTo`).
      const movedToOther = other.point[0] === cell.x && other.point[1] === cell.y && (other.level ?? 0) === (current.level ?? 0)
        && !this.isSplitAt(state, [cell.x, cell.y], current.level);
      if (current.point[0] !== cell.x || current.point[1] !== cell.y) {
        // Cursor left the original cell — this is a drag gesture even if landing on the other
        // endpoint's cell is rejected below, so pointerup must not reinterpret it as a click. Live
        // preview only: the move is committed on release, so a cancelled carry leaves no trace.
        this.teleportDragMoved = true;
        if (!movedToOther) {
          useMazeStore.getState().setPresetDragOverride({ kind: "teleportEndpoint", id: hit.id, end: hit.end, point: [cell.x, cell.y] });
        }
      } else {
        useMazeStore.getState().setPresetDragOverride(null);
      }
      return;
    }

    if (this.draggingVerticalPassageEndpoint) {
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      const cell = { x, y };
      // Cursor highlight follows the drag (GitHub issue #612) instead of staying on the origin
      // cell for the whole gesture.
      const inField = this.renderer.getCachedCellSet().has(encodePoint(cell.x, cell.y));
      this.renderer.updateCellHover(inField ? [cell.x, cell.y] : null);
      if (!inField) return;
      const passage = state.presetVerticalPassages.find(p => p.id === this.draggingVerticalPassageEndpoint!.id);
      if (!passage) return;
      const hit = this.draggingVerticalPassageEndpoint;
      const current = hit.end === "from" ? passage.from : passage.to;
      const other = hit.end === "from" ? passage.to : passage.from;
      // A split tile is never "the other endpoint" here: the drop asks for a node, and the other
      // endpoint's own node is left out of that choice (`movePresetTeleportEndpointTo`).
      const movedToOther = other.point[0] === cell.x && other.point[1] === cell.y && (other.level ?? 0) === (current.level ?? 0)
        && !this.isSplitAt(state, [cell.x, cell.y], current.level);
      if (current.point[0] !== cell.x || current.point[1] !== cell.y) {
        // Live preview only (GitHub issue #566) — nothing is committed to `presetVerticalPassages`
        // until release, so an intermediate cell the cursor passes over never desyncs the passage's
        // own coordinates even transiently. Origin comparison lives in `onPointerUp`.
        this.verticalPassageDragMoved = true;
        if (!movedToOther) {
          useMazeStore.getState().setPresetDragOverride({ kind: "verticalPassageEndpoint", id: hit.id, end: hit.end, point: [cell.x, cell.y] });
        }
      } else {
        useMazeStore.getState().setPresetDragOverride(null);
      }
      return;
    }

    if (this.draggingElevatorEndpoint) {
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      const cell = { x, y };
      // Cursor highlight follows the drag (GitHub issue #612) instead of staying on the origin
      // cell for the whole gesture.
      const inField = this.renderer.getCachedCellSet().has(encodePoint(cell.x, cell.y));
      this.renderer.updateCellHover(inField ? [cell.x, cell.y] : null);
      if (!inField) return;
      const hit = this.draggingElevatorEndpoint;
      const elevator = state.presetElevators.find(e => e.id === hit.id);
      if (!elevator) return;
      const own = elevator.floors.find((f) => (f.level ?? 0) === hit.level);
      if (!own) return;
      if (own.point[0] !== cell.x || own.point[1] !== cell.y) {
        this.elevatorDragMoved = true;
        useMazeStore.getState().setPresetDragOverride({ kind: "elevatorEndpoint", id: hit.id, level: hit.level, point: [cell.x, cell.y] });
      } else {
        useMazeStore.getState().setPresetDragOverride(null);
      }
      return;
    }

    if (TELEPORT_TOOLS.has(state.presetConnectionsTool)) {
      if (state.presetTeleportPendingFrom) {
        this.renderer.updateTeleportPreview(state.presetTeleportPendingFrom.point, vpX, vpY);
      } else {
        this.renderer.updateTeleportPreview(null, 0, 0);
      }
    } else {
      this.renderer.updateTeleportPreview(null, 0, 0);
    }

    if (state.presetConnectionsTool === "settings") {
      // Highlights only what the settings tool can configure: a one-way edge near the cursor, else
      // the cell when it holds a configurable element (GitHub issue #748).
      const edge = this.settingsEdgeAt(state, vpX, vpY);
      if (edge) {
        this.renderer.updateCellHover(null);
        this.renderer.updateHover(edge);
        return;
      }
      this.renderer.updateHover(null);
      const cfg = state.floorFields[state.activeFloorId].tessellationConfig;
      if (isInEdgeVertexDeadZone(vpX, vpY, cfg, this.renderer.getCachedCells(), this.renderer.getCachedCellSet())) {
        this.renderer.updateCellHover(null);
        return;
      }
      const [x, y] = pointerCellAtConfig(cfg, vpX, vpY);
      this.renderer.updateCellHover(this.isConfigurableCell(state, [x, y], activeFloorLevel(state)) ? [x, y] : null);
      return;
    }

    if (state.presetConnectionsTool === "manage_split_nodes" || VERTEX_TOOLS.has(state.presetConnectionsTool) || CELL_HOVER_TOOLS.has(state.presetConnectionsTool)) {
      // Vertex tools (set start/finish, teleports) and manage_split_nodes all target a whole
      // point, not one of its faces — highlight the cell under the cursor, not an edge (mirrors
      // manage_split_nodes's original fix, GitHub issue #231; issue #326 extends this to every
      // vertex tool, replacing the wall-highlight reuse / missing highlight they had before).
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      const cell = { x, y };
      const inField = this.renderer.getCachedCellSet().has(encodePoint(cell.x, cell.y));
      this.renderer.updateCellHover(inField ? [cell.x, cell.y] : null);
      this.renderer.updateHover(null);
      return;
    }

    if (state.presetConnectionsTool === "clear") {
      // Same dual targeting as post-edit's own "reset" tool: near an edge → highlight that edge
      // (grain-level clear), otherwise → highlight the whole cell under the cursor (point-level
      // clear). Split cells are excluded from the edge branch — a split point's own faces are
      // rendered by SplitJunctionRenderer, not the plain wall layer, so there is no single "this
      // edge" to point-hover there; the point branch (delete everything at the point) covers it.
      // Both branches are drag-capable (GitHub issue #489) — edge via `beginEdgeDrag`, cell via
      // `beginCellDrag` (BaseController, shared bookkeeping).
      const cfg = state.floorFields[state.activeFloorId].tessellationConfig;
      // Once a clear gesture has started, keep dispatching through the branch selected at
      // pointerdown. Crossing an edge hit zone must not switch a cell clear to edge mutations,
      // and a cell clear must continue while the cursor is over an edge.
      if (this.isCellDrag) {
        const [x, y] = pointerCellAtConfig(cfg, vpX, vpY);
        const cell = { x, y };
        const inField = this.renderer.getCachedCellSet().has(encodePoint(cell.x, cell.y));
        this.renderer.updateHover(null);
        this.renderer.updateCellHover(inField ? [cell.x, cell.y] : null, true);
        this.continueCellDrag(inField ? [cell.x, cell.y] : null, (p) => {
          const l = activeFloorLevel(useMazeStore.getState());
          useMazeStore.getState().requestPresetEntityDelete(p, l, { kind: "point_all" }, this.bulkDelete);
          if (useMazeStore.getState().presetEntityDeletePrompt) this.endEdgeDrag();
        });
        return;
      }
      if (this.isEdgeDrag) {
        const edge = pickEdgeAtPosition(vpX, vpY, cfg, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
        this.renderer.updateCellHover(null);
        this.renderer.updateHover(edge, true);
        this.continueEdgeDrag(edge, (e) => {
          useMazeStore.getState().applyPresetConnectionsToolAt("reset", e.key, e.from, e.to);
        });
        return;
      }
      const edge = pickEdgeAtPosition(vpX, vpY, cfg, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
      const level = activeFloorLevel(state);
      const isSplit = (p: [number, number]) => {
        const key = level === undefined ? `${p[0]},${p[1]}` : `${p[0]},${p[1]}@${level}`;
        return (state.presetSplitPoints[key]?.length ?? 0) > 0;
      };
      if (edge && !isSplit(edge.from) && !isSplit(edge.to)) {
        this.renderer.updateCellHover(null);
        this.renderer.updateHover(edge, true);
        this.continueEdgeDrag(edge, (e) => {
          useMazeStore.getState().applyPresetConnectionsToolAt("reset", e.key, e.from, e.to);
        });
        return;
      }
      // Near a shared vertex (edge dead zone, #188) — withhold the cell fallback too, or the
      // vertex dead zone silently becomes "picks the cell instead" (GitHub issue #340 follow-up).
      if (isInEdgeVertexDeadZone(vpX, vpY, cfg, this.renderer.getCachedCells(), this.renderer.getCachedCellSet())) {
        this.renderer.updateHover(null);
        this.renderer.updateCellHover(null);
        return;
      }
      const [x, y] = pointerCellAtConfig(cfg, vpX, vpY);
      const cell = { x, y };
      const inField = this.renderer.getCachedCellSet().has(encodePoint(cell.x, cell.y));
      this.renderer.updateHover(null);
      this.renderer.updateCellHover(inField ? [cell.x, cell.y] : null, true);
      this.continueCellDrag(inField ? [cell.x, cell.y] : null, (p) => {
        const l = activeFloorLevel(useMazeStore.getState());
        useMazeStore.getState().requestPresetEntityDelete(p, l, { kind: "point_all" }, this.bulkDelete);
        // A count>1 request opens `presetEntityDeletePrompt` synchronously — the drag gesture
        // must end right here, or it silently keeps running (as "button still held") once the
        // dialog closes, since no further pointerdown/pointerup pair will come to end it normally
        // (GitHub issue #540 follow-up bug report).
        if (useMazeStore.getState().presetEntityDeletePrompt) this.endEdgeDrag();
      });
      return;
    }
    this.renderer.updateCellHover(null);

    const edge = pickEdgeAtPosition(vpX, vpY, state.floorFields[state.activeFloorId].tessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
    this.renderer.updateHover(edge);

    this.continueEdgeDrag(edge, (e) => {
      useMazeStore.getState().applyPresetConnectionsTool(e.key, e.from, e.to);
    });
  }

  onPointerDown(canvasX: number, canvasY: number, button: number, shiftKey?: boolean): void {
    const state = useMazeStore.getState();
    if (state.openCard !== "preset_connections") return;
    if (isPresetConnectionsModalOpen(state)) return;

    if (this.tryStartPan(canvasX, canvasY, button)) return;
    // Held shift bypasses the entity picker dialog for this gesture — captured here (not read
    // fresh at request time) so a drag started with shift held stays bulk-delete for every cell
    // it visits, even if shift happens to be released mid-drag.
    this.bulkDelete = shiftKey === true;

    const { x: vpX, y: vpY } = this.toViewport(canvasX, canvasY);
    const tool = state.presetConnectionsTool;
    this.takeMoveRequest(state);

    if (this.carrying) {
      // A carried element is dropped by the release of the next left click; a right click cancels.
      if (button === 0) this.dropPressed = true;
      else if (button === 2) this.cancelPointerGesture();
      return;
    }

    if (tool === "move") {
      if (button !== 0) return;
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      if (!this.renderer.getCachedCellSet().has(encodePoint(x, y))) return;
      // A single element is picked up by this press (drag it, or release to carry it); several
      // open the pick dialog, whose choice is carried (`takeMoveRequest`).
      state.requestPresetEntityPick([x, y], activeFloorLevel(state), "move");
      const request = useMazeStore.getState().takePresetMoveRequest();
      if (request) {
        this.armElement(request, useMazeStore.getState());
        this.pressCell = null;
      }
      return;
    }

    if (tool === "settings") {
      if (button !== 0) return;
      const edge = this.settingsEdgeAt(state, vpX, vpY);
      if (edge) {
        state.applyPresetConnectionsToolAt("one_way_flip", edge.key, edge.from, edge.to);
        return;
      }
      const cfg = state.floorFields[state.activeFloorId].tessellationConfig;
      if (isInEdgeVertexDeadZone(vpX, vpY, cfg, this.renderer.getCachedCells(), this.renderer.getCachedCellSet())) return;
      const [x, y] = pointerCellAtConfig(cfg, vpX, vpY);
      state.requestPresetEntityPick([x, y], activeFloorLevel(state), "settings");
      return;
    }

    // Locks are cell tools (not VERTEX_TOOLS), but a split cell still needs an explicit node
    // target. Defer the click to the same picker used by other split-node vertex actions.
    if (button === 0 && (tool === "lock_in" || tool === "lock_out" || tool === "full_lock")) {
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      const cell = { x, y };
      const point: [number, number] = [cell.x, cell.y];
      const level = activeFloorLevel(state);
      if (!this.renderer.getCachedCellSet().has(encodePoint(cell.x, cell.y))) return;
      const slotIds = state.presetSplitPoints[splitKeyOf(point, level)];
      if (slotIds && slotIds.length > 0) {
        state.requestPresetSplitTarget({ point, level, slotIds: [...slotIds].sort((a, b) => a - b), action: { tool } });
        return;
      }
    }

    if (VERTEX_TOOLS.has(tool)) {
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      const cell = { x, y };
      const coords: [number, number] = [cell.x, cell.y];
      const store = useMazeStore.getState();
      const level = activeFloorLevel(store);
      const inField = this.renderer.getCachedCellSet().has(encodePoint(coords[0], coords[1]));

      // On a split point the active-node concept (`presetActiveSplitNode`) must not decide which
      // node a vertex-tool placement attaches to (GitHub issue #474). A left click there defers
      // to the node picker *before* any marker/teleport/vertical-passage hit-test below — those
      // resolve through the active node and would otherwise silently drag/cycle/complete on it
      // without the dialog. Right click (remove) still falls through to the hit-tests.
      if (button === 0) {
        if (!inField) {
          if (TELEPORT_TOOLS.has(tool)) notifyEditRefusal("preset_connections", TELEPORT_OUTSIDE_FIELD);
          return;
        }
        const slotIds = store.presetSplitPoints[splitKeyOf(coords, level)];
        if (slotIds && slotIds.length > 0) {
          const sortedSlotIds = [...slotIds].sort((a, b) => a - b);
          if (tool === "set_start" || tool === "set_finish") {
            store.requestPresetSplitTarget({ point: coords, level, slotIds: sortedSlotIds, action: { tool } });
          } else if (VERTICAL_PASSAGE_TOOLS.has(tool)) {
            store.requestPresetSplitTarget({ point: coords, level, slotIds: sortedSlotIds, action: { tool: tool as "vertical_passage_one_way" | "vertical_passage_two_way" } });
          } else if (tool === "elevator") {
            store.requestPresetSplitTarget({ point: coords, level, slotIds: sortedSlotIds, action: { tool: "elevator" } });
          } else if (TELEPORT_TOOLS.has(tool)) {
            store.requestPresetSplitTarget({ point: coords, level, slotIds: sortedSlotIds, action: { tool: tool as "teleport_one_way" | "teleport_two_way" } });
          }
          return;
        }
      }

      // All vertex elements (start, finish, teleport/vertical-passage/elevator endpoints) share
      // one editing mode: whichever vertex tool is active, drag/RMB-delete applies to any of them
      // — but only among elements on the active floor (GitHub issue #340); a marker on another
      // floor is edited from that floor instead.
      const onStart =
        store.presetStart !== null && (store.presetStart.level ?? 0) === (level ?? 0) && store.presetStart.point[0] === coords[0] && store.presetStart.point[1] === coords[1];
      const onFinish =
        store.presetFinish !== null && (store.presetFinish.level ?? 0) === (level ?? 0) && store.presetFinish.point[0] === coords[0] && store.presetFinish.point[1] === coords[1];
      const teleportHit = pickTeleportEndpointAt(vpX, vpY, state.floorFields[state.activeFloorId].tessellationConfig, teleportsOnLevel(store.presetTeleports, level));
      const verticalPassageHit = pickVerticalPassageEndpointAt(vpX, vpY, state.floorFields[state.activeFloorId].tessellationConfig, store.presetVerticalPassages, level);
      const elevatorMarkerHit = pickElevatorEndpointAt(vpX, vpY, state.floorFields[state.activeFloorId].tessellationConfig, store.presetElevators, level);
      const elevatorHit = store.presetElevators.find((e) => e.floors.some((f) => (f.level ?? 0) === (level ?? 0) && f.point[0] === coords[0] && f.point[1] === coords[1]));

      if (button === 2) {
        const endpoints: PresetEndpoint[] = [];
        if (onStart && store.presetStart) endpoints.push(store.presetStart);
        if (onFinish && store.presetFinish) endpoints.push(store.presetFinish);
        if (teleportHit) {
          const entry = store.presetTeleports.find((t) => t.id === teleportHit.id);
          if (entry) endpoints.push(entry[teleportHit.end]);
        }
        if (verticalPassageHit) {
          const entry = store.presetVerticalPassages.find((v) => v.id === verticalPassageHit.id);
          if (entry) endpoints.push(entry[verticalPassageHit.end]);
        }
        if (elevatorHit) {
          const floorEndpoint = elevatorHit.floors.find(
            (f) => (f.level ?? 0) === (level ?? 0) && f.point[0] === coords[0] && f.point[1] === coords[1],
          );
          if (floorEndpoint) endpoints.push(floorEndpoint);
        }

        if (endpoints.length === 0) {
          if (store.presetTeleportPendingFrom) this.cancelPendingTeleport();
        } else if (endpoints.length === 1) {
          if (onStart) store.setPresetStart(null);
          else if (onFinish) store.setPresetFinish(null);
          else if (teleportHit) store.removePresetTeleport(teleportHit.id);
          else if (verticalPassageHit) store.removePresetVerticalPassage(verticalPassageHit.id);
          else if (elevatorHit) store.removePresetElevator(elevatorHit.id);
        } else {
          store.requestPresetEntityDelete(coords, level, { kind: "vertex_markers", endpoints }, shiftKey);
        }
        return;
      }
      if (button !== 0) return;

      // A press on an existing element arms a drag candidate for it, resolved on pointerup: moved
      // to another cell — the element moves; released in place — this tool adds its own new
      // element at `pressCell` (GitHub issue #748), whatever already occupies the cell.
      if (onStart) this.armMarkerDrag("set_start");
      else if (onFinish) this.armMarkerDrag("set_finish");
      else if (teleportHit) this.draggingTeleportEndpoint = teleportHit;
      else if (verticalPassageHit) this.draggingVerticalPassageEndpoint = verticalPassageHit;
      else if (elevatorMarkerHit) this.draggingElevatorEndpoint = elevatorMarkerHit;
      if (this.hasArmedElement) {
        this.markerDragMoved = false;
        this.teleportDragMoved = false;
        this.verticalPassageDragMoved = false;
        this.elevatorDragMoved = false;
        this.pressCell = coords;
        this.renderer.updateCellHover(null);
        return;
      }
      this.placeVertexAt(coords, tool);
      return;
    }

    if (tool === "gen_source") {
      if (button !== 0 && button !== 2) return;
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      const cell = { x, y };
      const coords: [number, number] = [cell.x, cell.y];
      const store = useMazeStore.getState();
      const level = activeFloorLevel(store);
      const inField = this.renderer.getCachedCellSet().has(encodePoint(coords[0], coords[1]));

      // Right-click clears the generation source when it sits on the clicked cell (any of a split
      // point's nodes). Mirrors `set_start`/`set_finish`'s own right-click clear.
      if (button === 2) {
        const cur = store.presetGenSource;
        if (cur && (cur.level ?? 0) === (level ?? 0) && cur.point[0] === coords[0] && cur.point[1] === coords[1]) {
          store.setPresetGenSource(null);
        }
        return;
      }
      if (!inField) return;

      // On a declared split point the generation source must be attachable to a specific node, not
      // silently pinned to the point's original one (GitHub issue #494) — defer to the same node
      // picker every other vertex-tool placement uses (GitHub issue #474).
      const slotIds = store.presetSplitPoints[splitKeyOf(coords, level)];
      if (slotIds && slotIds.length > 0) {
        store.requestPresetSplitTarget({ point: coords, level, slotIds: [...slotIds].sort((a, b) => a - b), action: { tool: "gen_source" } });
        return;
      }
      // A click always places the source; clearing is right-click only (GitHub issue #748).
      store.setPresetGenSource(coords);
      return;
    }

    if (tool === "manage_split_nodes") {
      if (button !== 0) return;
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      const cell = { x, y };
      const key = encodePoint(cell.x, cell.y);
      useMazeStore.getState().setPresetFocusedPoint(this.renderer.getCachedCellSet().has(key) ? [cell.x, cell.y] : null);
      return;
    }

    if (tool === "clear") {
      if (button !== 0) return;
      const cfg = state.floorFields[state.activeFloorId].tessellationConfig;
      const edge = pickEdgeAtPosition(vpX, vpY, cfg, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
      const level = activeFloorLevel(state);
      const isSplit = (p: [number, number]) => {
        const k = level === undefined ? `${p[0]},${p[1]}` : `${p[0]},${p[1]}@${level}`;
        return (state.presetSplitPoints[k]?.length ?? 0) > 0;
      };
      if (edge && !isSplit(edge.from) && !isSplit(edge.to)) {
        useMazeStore.getState().applyPresetConnectionsToolAt("reset", edge.key, edge.from, edge.to);
        this.beginEdgeDrag(edge.key);
        this.renderer.updateHover(edge, true);
        return;
      }
      if (isInEdgeVertexDeadZone(vpX, vpY, cfg, this.renderer.getCachedCells(), this.renderer.getCachedCellSet())) return;
      const [x, y] = pointerCellAtConfig(cfg, vpX, vpY);
      const cell = { x, y };
      const key = encodePoint(cell.x, cell.y);
      // Invalid preset entities remain addressable by their projected coordinates, even when
      // their point is outside the current field.
      useMazeStore.getState().requestPresetEntityDelete([cell.x, cell.y], level, { kind: "point_all" }, this.bulkDelete);
      // A count>1 request opens `presetEntityDeletePrompt` synchronously — don't arm a drag
      // gesture in that case, or it's stuck "held" once the dialog closes (no further
      // pointerdown/pointerup pair reaches the canvas to end it normally; GitHub issue #540
      // follow-up bug report).
      if (this.renderer.getCachedCellSet().has(key) && !useMazeStore.getState().presetEntityDeletePrompt) {
        this.beginCellDrag([cell.x, cell.y]);
      }
      return;
    }

    if (tool === "lock_in" || tool === "lock_out" || tool === "full_lock") {
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      const store = useMazeStore.getState();
      if (button === 2) {
        store.removeLockedNode(x, y);
      } else if (button === 0) {
        if (!this.renderer.getCachedCellSet().has(encodePoint(x, y))) return;
        // A press on an existing lock arms its drag; released in place it is a click, which sets
        // this tool's kind (GitHub issue #748).
        const lock = presetEndpoint([x, y], undefined, activeFloorLevel(store));
        if (store.lockedNodes.has(presetEndpointKey(lock))) {
          this.draggingLock = lock;
          this.lockDragMoved = false;
          this.pressCell = [x, y];
          this.renderer.updateCellHover(null);
          return;
        }
        this.placeLockAt([x, y], tool);
      }
      return;
    }

    const edge = pickEdgeAtPosition(vpX, vpY, state.floorFields[state.activeFloorId].tessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet());
    if (!edge) return;

    if (button === 2) {
      useMazeStore.getState().applyPresetConnectionsToolAt("reset", edge.key, edge.from, edge.to);
    } else if (button === 0) {
      useMazeStore.getState().applyPresetConnectionsTool(edge.key, edge.from, edge.to);
      if (DRAG_EDGE_TOOLS.has(tool)) {
        this.beginEdgeDrag(edge.key);
      }
    }
    this.renderer.updateHover(edge);
  }

  onPointerUp(button: number): void {
    if (button === 0 && this.hasArmedElement) {
      // Move tool (GitHub issue #748): a release that did not move the element starts carrying it;
      // while carrying, only the release of the dropping click commits.
      if (this.carrying && !this.dropPressed) return;
      if (!this.carrying && !this.armedElementMoved && useMazeStore.getState().presetConnectionsTool === "move") {
        this.carrying = true;
        return;
      }
    }
    // Marker drag commits here, before `super.onPointerUp` clears `draggingMarker` (GitHub issue
    // #613) — only one store write for the whole gesture, and only if the drag actually moved to a
    // different cell.
    const marker = button === 0 ? this.draggedMarker : null;
    if (marker) {
      if (this.markerDragMoved) {
        const override = useMazeStore.getState().presetDragOverride;
        if (override?.kind === "marker") useMazeStore.getState().movePresetMarker(marker, override.point);
      } else if (this.pressCell) {
        this.placeVertexAt(this.pressCell, useMazeStore.getState().presetConnectionsTool);
      }
      this.markerDragMoved = false;
      this.draggingGenSource = false;
    }
    super.onPointerUp(button);
    if (button === 0) {
      this.endEdgeDrag();

      if (this.draggingTeleportEndpoint) {
        if (this.teleportDragMoved) {
          const override = useMazeStore.getState().presetDragOverride;
          if (override?.kind === "teleportEndpoint" && override.id === this.draggingTeleportEndpoint.id) {
            useMazeStore.getState().movePresetTeleportEndpointTo(override.id, override.end, override.point);
          }
        } else if (this.pressCell) {
          this.placeVertexAt(this.pressCell, useMazeStore.getState().presetConnectionsTool);
        }
        this.draggingTeleportEndpoint = null;
        this.teleportDragMoved = false;
      }

      if (this.draggingVerticalPassageEndpoint) {
        if (this.verticalPassageDragMoved) {
          // Commits the whole gesture as a single `movePresetVerticalPassageEndpoint` call (GitHub
          // issue #566) — the override built up during the drag is exactly the final position.
          const override = useMazeStore.getState().presetDragOverride;
          if (override?.kind === "verticalPassageEndpoint" && override.id === this.draggingVerticalPassageEndpoint.id) {
            useMazeStore.getState().movePresetVerticalPassageEndpoint(override.id, override.end, override.point);
          }
        } else if (this.pressCell) {
          this.placeVertexAt(this.pressCell, useMazeStore.getState().presetConnectionsTool);
        }
        this.draggingVerticalPassageEndpoint = null;
        this.verticalPassageDragMoved = false;
      }

      if (this.draggingLock) {
        if (this.lockDragMoved) {
          const override = useMazeStore.getState().presetDragOverride;
          if (override?.kind === "lock") useMazeStore.getState().movePresetLockTo(override.from, override.point);
        } else if (this.pressCell) {
          this.placeLockAt(this.pressCell, useMazeStore.getState().presetConnectionsTool);
        }
        this.draggingLock = null;
        this.lockDragMoved = false;
      }

      if (this.draggingElevatorEndpoint) {
        if (this.elevatorDragMoved) {
          const override = useMazeStore.getState().presetDragOverride;
          if (override?.kind === "elevatorEndpoint" && override.id === this.draggingElevatorEndpoint.id) {
            useMazeStore.getState().movePresetElevatorEndpoint(override.id, override.level, override.point);
          }
        } else if (this.pressCell) {
          this.placeVertexAt(this.pressCell, useMazeStore.getState().presetConnectionsTool);
        }
        this.draggingElevatorEndpoint = null;
        this.elevatorDragMoved = false;
      }

      // A drop on a split tile keeps its preview while the node picker is open; the pick or its
      // cancellation clears it.
      if (useMazeStore.getState().presetSplitTargetPrompt === null && useMazeStore.getState().presetDragOverride !== null) {
        useMazeStore.getState().setPresetDragOverride(null);
      }
      this.pressCell = null;
      this.carrying = false;
      this.dropPressed = false;
    }
  }

  cancelPointerGesture(): void {
    const gestureActive = this.isDragActive || this.hasArmedElement;
    super.cancelPointerGesture();
    this.draggingTeleportEndpoint = null;
    this.teleportDragMoved = false;
    this.draggingVerticalPassageEndpoint = null;
    this.verticalPassageDragMoved = false;
    this.draggingElevatorEndpoint = null;
    this.elevatorDragMoved = false;
    this.draggingLock = null;
    this.lockDragMoved = false;
    this.draggingGenSource = false;
    this.markerDragMoved = false;
    this.pressCell = null;
    this.carrying = false;
    this.dropPressed = false;
    this.bulkDelete = false;
    if (gestureActive) {
      useMazeStore.getState().setPresetDragOverride(null);
    }
  }

  /** Adds the active vertex tool's own element at `coords` — a click always adds, even on a cell
   *  that already holds elements (GitHub issue #748). */
  private placeVertexAt(coords: [number, number], tool: string): void {
    const store = useMazeStore.getState();
    const level = activeFloorLevel(store);
    if (tool === "set_start") store.setPresetStart(coords);
    else if (tool === "set_finish") store.setPresetFinish(coords);
    else if (tool === "elevator") store.startPresetElevatorPlacement(presetEndpoint(coords, undefined, level));
    else if (VERTICAL_PASSAGE_TOOLS.has(tool)) store.startPresetVerticalPassagePlacement(presetEndpoint(coords, undefined, level), tool as "vertical_passage_one_way" | "vertical_passage_two_way");
    else if (TELEPORT_TOOLS.has(tool)) this.tryTeleportClick(coords, tool);
  }

  /** Sets the active lock tool's kind on the original node at `coords`. A lock tool always sets its
   *  own kind; changing an existing lock is also the settings tool's job (GitHub issue #748). */
  private placeLockAt(coords: [number, number], tool: string): void {
    const kindMap: Record<string, NodeLockKind> = { lock_in: "in", lock_out: "out", full_lock: "both" };
    const kind = kindMap[tool];
    if (kind) useMazeStore.getState().setLockedNode(coords[0], coords[1], kind);
  }

  /** Starts or completes a two-click teleport placement at `coords`. Reports a refusal if the cell
   * is outside the field; remains a no-op when completion targets the pending origin cell. */
  private tryTeleportClick(coords: [number, number], tool: string): void {
    if (!this.renderer.getCachedCellSet().has(encodePoint(coords[0], coords[1]))) {
      notifyEditRefusal("preset_connections", TELEPORT_OUTSIDE_FIELD);
      return;
    }
    const store = useMazeStore.getState();
    const level = activeFloorLevel(store);
    const pendingFrom = store.presetTeleportPendingFrom;
    if (pendingFrom) {
      if (pendingFrom.point[0] === coords[0] && pendingFrom.point[1] === coords[1] && (pendingFrom.level ?? 0) === (level ?? 0)) return;
      const direction = tool === "teleport_two_way" ? "two_way" : "forward";
      store.addPresetTeleport(pendingFrom, presetEndpoint(coords, undefined, level), direction);
      this.renderer.updateTeleportPreview(null, 0, 0);
    } else {
      store.setPresetTeleportPendingFrom(presetEndpoint(coords, undefined, level));
    }
  }

  private cancelPendingTeleport(): void {
    const state = useMazeStore.getState();
    cancelPendingPointerAction(
      state.presetTeleportPendingFrom,
      () => state.setPresetTeleportPendingFrom(null),
      () => this.renderer.updateTeleportPreview(null, 0, 0),
    );
  }

  clearHover(): void {
    resetPointerHover({
      updateHover: (edge) => this.renderer.updateHover(edge),
      updateCellHover: (cell) => this.renderer.updateCellHover(cell),
      updateTeleportPreview: (point, x, y) => this.renderer.updateTeleportPreview(point, x, y),
    });
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    this.unsubscribeFloor();
  }
}
