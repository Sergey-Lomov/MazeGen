import { useMazeStore } from "../store/mazeStore";
import type { NodeLockKind } from "../wasm/types";
import type { Container } from "pixi.js";
import { pickEdgeAtPosition, pickTeleportEndpointAt, pickVerticalPassageEndpointAt, pickElevatorEndpointAt, isInEdgeVertexDeadZone, type PresetTeleportEndpointHit, type PresetVerticalPassageEndpointHit, type PresetElevatorEndpointHit } from "./fieldEditUtils";
import { presetEndpoint, type PresetEndpoint } from "./presetEndpoint";
import { encodePoint } from "./tessellationProjection";
import type { PresetConnectionsRenderer } from "./PresetConnectionsRenderer";
import { BaseController } from "./BaseController";
import { activeFloorLevel } from "../store/storeHelpers";
import { cancelPendingPointerAction, pointerCellAtConfig, resetPointerHover } from "./pointerInteraction";
import { isPresetConnectionsModalOpen, teleportsOnLevel } from "./presetConnectionsInteraction";

const DRAG_EDGE_TOOLS = new Set(["wall", "passage", "reset"]);
const TELEPORT_TOOLS = new Set(["teleport_one_way", "teleport_two_way"]);
const VERTICAL_PASSAGE_TOOLS = new Set(["vertical_passage_one_way", "vertical_passage_two_way"]);
const VERTEX_TOOLS = new Set(["set_start", "set_finish", "teleport_one_way", "teleport_two_way", "vertical_passage_one_way", "vertical_passage_two_way", "elevator"]);
// Node-locking and generation-source tools target a whole cell/point, not an edge — they hover
// the cell under the cursor (GitHub issue #456), same as `VERTEX_TOOLS` / `manage_split_nodes`.
const CELL_HOVER_TOOLS = new Set(["lock_in", "lock_out", "full_lock", "gen_source"]);

export class PresetConnectionsController extends BaseController {
  private renderer: PresetConnectionsRenderer;
  private draggingTeleportEndpoint: PresetTeleportEndpointHit | null = null;
  private teleportDragMoved = false;
  private draggingVerticalPassageEndpoint: PresetVerticalPassageEndpointHit | null = null;
  private verticalPassageDragMoved = false;
  private draggingElevatorEndpoint: PresetElevatorEndpointHit | null = null;
  private elevatorDragMoved = false;
  // Whether a start/finish marker drag (GitHub issue #613) actually moved to a different cell —
  // mirrors `teleportDragMoved`/`verticalPassageDragMoved`/`elevatorDragMoved` above.
  private markerDragMoved = false;
  private lastViewportPos = { x: 0, y: 0 };
  // Captured at pointerdown so a cell-drag gesture (which re-requests deletion on every cell it
  // visits, via `continueCellDrag`'s callback) keeps using the shift state the drag started with,
  // not whatever it happens to be on a later pointermove.
  private bulkDelete = false;

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Escape") {
      this.cancelPendingTeleport();
      useMazeStore.getState().cancelPresetVerticalPassagePlacement();
      useMazeStore.getState().cancelPresetElevatorPlacement();
      useMazeStore.getState().cancelPresetSplitTarget();
      useMazeStore.getState().cancelPresetEntityDelete();
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
    this.lastViewportPos = { x: vpX, y: vpY };

    if (this.draggingMarker) {
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      const cell = { x, y };
      // Cursor highlight follows the drag (GitHub issue #612) instead of staying on the origin
      // cell or vanishing for the whole gesture.
      const inField = this.renderer.getCachedCellSet().has(encodePoint(cell.x, cell.y));
      this.renderer.updateCellHover(inField ? [cell.x, cell.y] : null);
      if (!inField) return;
      const coords: [number, number] = [cell.x, cell.y];
      const origin = this.draggingMarker === "set_start" ? state.presetStart : state.presetFinish;
      const originLevel = activeFloorLevel(state);
      const onOrigin = origin !== null && (origin.level ?? 0) === (originLevel ?? 0)
        && origin.point[0] === coords[0] && origin.point[1] === coords[1];
      // Live preview only (GitHub issue #613) — nothing is committed to `presetStart`/`presetFinish`
      // until pointerup, so a fast drag no longer forces a full store update per move. Commit
      // happens in `onPointerUp`, and only if the cursor actually left the origin cell (mirrors
      // `teleportDragMoved`/`verticalPassageDragMoved`/`elevatorDragMoved` below) — otherwise a
      // plain click (no movement) keeps costing nothing, same as before this change.
      if (!onOrigin) {
        this.markerDragMoved = true;
        useMazeStore.getState().setPresetDragOverride({
          kind: "marker", marker: this.draggingMarker === "set_start" ? "start" : "finish", point: coords,
        });
      } else if (useMazeStore.getState().presetDragOverride?.kind === "marker") {
        // Returning to the drag origin restores the committed marker position in the live preview.
        // Keep the gesture armed so a later move can create a new override again (GitHub issue
        // #695).
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
      const teleport = state.presetTeleports.find(t => t.id === this.draggingTeleportEndpoint!.id);
      if (!teleport) return;
      const current = this.draggingTeleportEndpoint.end === "from" ? teleport.from : teleport.to;
      const other = this.draggingTeleportEndpoint.end === "from" ? teleport.to : teleport.from;
      const movedToOther = other.point[0] === cell.x && other.point[1] === cell.y;
      if (current.point[0] !== cell.x || current.point[1] !== cell.y) {
        // Cursor left the original cell — this is a drag gesture even if landing on the other
        // endpoint's cell is rejected below, so pointerup must not reinterpret it as a click.
        this.teleportDragMoved = true;
        if (!movedToOther) {
          useMazeStore.getState().movePresetTeleportEndpoint(
            this.draggingTeleportEndpoint.id,
            this.draggingTeleportEndpoint.end,
            [cell.x, cell.y],
            current.level ?? 0,
          );
        }
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
      const movedToOther = other.point[0] === cell.x && other.point[1] === cell.y && (other.level ?? 0) === (current.level ?? 0);
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
    // A click on an existing teleport endpoint can complete a pending placement on pointerup
    // without producing any pointermove first. Capture the down position so that release-only
    // resolution targets the cell actually clicked rather than the previous/default position.
    this.lastViewportPos = { x: vpX, y: vpY };
    const tool = state.presetConnectionsTool;

    // Locks are cell tools (not VERTEX_TOOLS), but a split cell still needs an explicit node
    // target. Defer the click to the same picker used by other split-node vertex actions.
    if (button === 0 && (tool === "lock_in" || tool === "lock_out" || tool === "full_lock")) {
      const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
      const cell = { x, y };
      const point: [number, number] = [cell.x, cell.y];
      const level = activeFloorLevel(state);
      if (!this.renderer.getCachedCellSet().has(encodePoint(cell.x, cell.y))) return;
      const splitKey = level === undefined ? `${cell.x},${cell.y}` : `${cell.x},${cell.y}@${level}`;
      const slotIds = state.presetSplitPoints[splitKey];
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
        if (!inField) return;
        const splitKey = level === undefined ? `${coords[0]},${coords[1]}` : `${coords[0]},${coords[1]}@${level}`;
        const slotIds = store.presetSplitPoints[splitKey];
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

      // All four vertex elements (start, finish, every teleport endpoint) share one editing
      // mode: whichever vertex tool is active, drag/RMB-delete applies to any of them — but only
      // among elements on the active floor (GitHub issue #340); a marker on another floor is
      // edited from that floor instead.
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

      if (onStart) {
        this.armMarkerDrag("set_start");
        this.renderer.updateCellHover(null);
        return;
      }
      if (onFinish) {
        this.armMarkerDrag("set_finish");
        this.renderer.updateCellHover(null);
        return;
      }
      if (teleportHit) {
        // Arm as a drag candidate — resolved on pointerup: if the cursor never moved to a
        // different cell, treat it as a plain click (start/complete a new teleport) instead of
        // a drag, so clicking an existing endpoint's cell can still begin/finish a new link there.
        this.draggingTeleportEndpoint = teleportHit;
        this.teleportDragMoved = false;
        return;
      }
      if (verticalPassageHit) {
        this.draggingVerticalPassageEndpoint = verticalPassageHit;
        this.verticalPassageDragMoved = false;
        return;
      }
      if (elevatorMarkerHit) {
        this.draggingElevatorEndpoint = elevatorMarkerHit;
        this.elevatorDragMoved = false;
        return;
      }

      if (tool === "set_start") store.setPresetStart(coords);
      else if (tool === "set_finish") store.setPresetFinish(coords);
      else if (tool === "elevator") store.startPresetElevatorPlacement(presetEndpoint(coords, undefined, level));
      else if (VERTICAL_PASSAGE_TOOLS.has(tool)) store.startPresetVerticalPassagePlacement(presetEndpoint(coords, undefined, level), tool as "vertical_passage_one_way" | "vertical_passage_two_way");
      else this.tryTeleportClick(vpX, vpY, tool, state);
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
      // point's nodes) — the clear path for a split point, where a left click always opens the node
      // picker instead of toggling. Mirrors `set_start`/`set_finish`'s own right-click clear.
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
      // picker every other vertex-tool placement uses (GitHub issue #474). Matches `set_start`:
      // the picked node is assigned unconditionally (no toggle); clearing is right-click only.
      const splitKey = level === undefined ? `${coords[0]},${coords[1]}` : `${coords[0]},${coords[1]}@${level}`;
      const slotIds = store.presetSplitPoints[splitKey];
      if (slotIds && slotIds.length > 0) {
        store.requestPresetSplitTarget({ point: coords, level, slotIds: [...slotIds].sort((a, b) => a - b), action: { tool: "gen_source" } });
        return;
      }

      const cur = store.presetGenSource;
      if (cur && (cur.level ?? 0) === (level ?? 0) && cur.point[0] === coords[0] && cur.point[1] === coords[1]) {
        store.setPresetGenSource(null);
      } else {
        store.setPresetGenSource(coords);
      }
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
      const level = activeFloorLevel(store);
      const key = level === undefined ? `${x},${y}` : `${x},${y}@${level}`;
      if (button === 2) {
        store.removeLockedNode(x, y);
      } else if (button === 0) {
        if (!this.renderer.getCachedCellSet().has(encodePoint(x, y))) return;
        const kindMap: Record<string, NodeLockKind> = { lock_in: "in", lock_out: "out", full_lock: "both" };
        const kind = kindMap[tool];
        if (store.lockedNodes.get(key) === kind) {
          store.removeLockedNode(x, y);
        } else {
          store.setLockedNode(x, y, kind);
        }
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
    // Marker drag commits here, before `super.onPointerUp` clears `draggingMarker` (GitHub issue
    // #613) — only one `setPresetStart`/`setPresetFinish` for the whole gesture, and only if the
    // drag actually moved to a different cell (a plain click on an already-placed marker must stay
    // a no-op, same as before this change).
    if (button === 0 && this.draggingMarker) {
      const marker = this.draggingMarker;
      if (this.markerDragMoved) {
        const override = useMazeStore.getState().presetDragOverride;
        if (override?.kind === "marker") {
          if (marker === "set_start") useMazeStore.getState().setPresetStart(override.point);
          else useMazeStore.getState().setPresetFinish(override.point);
        }
      }
      useMazeStore.getState().setPresetDragOverride(null);
      this.markerDragMoved = false;
    }
    super.onPointerUp(button);
    if (button === 0) {
      this.endEdgeDrag();

      if (this.draggingTeleportEndpoint) {
        if (!this.teleportDragMoved) {
          const state = useMazeStore.getState();
          if (TELEPORT_TOOLS.has(state.presetConnectionsTool)) {
            if (state.presetTeleportPendingFrom) {
              // A placement is already in progress — clicking an existing endpoint's cell
              // completes the new link there rather than cycling that endpoint's direction.
              this.tryTeleportClick(this.lastViewportPos.x, this.lastViewportPos.y, state.presetConnectionsTool, state);
            } else {
              state.cyclePresetTeleportDirection(this.draggingTeleportEndpoint.id);
            }
          }
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
        } else {
          const state = useMazeStore.getState();
          if (VERTICAL_PASSAGE_TOOLS.has(state.presetConnectionsTool)) {
            state.cyclePresetVerticalPassageDirection(this.draggingVerticalPassageEndpoint.id);
          }
        }
        useMazeStore.getState().setPresetDragOverride(null);
        this.draggingVerticalPassageEndpoint = null;
        this.verticalPassageDragMoved = false;
      }

      if (this.draggingElevatorEndpoint) {
        if (this.elevatorDragMoved) {
          const override = useMazeStore.getState().presetDragOverride;
          if (override?.kind === "elevatorEndpoint" && override.id === this.draggingElevatorEndpoint.id) {
            useMazeStore.getState().movePresetElevatorEndpoint(override.id, override.level, override.point);
          }
        } else {
          // A plain click (no drag) on an existing elevator marker re-opens the floor-picker
          // dialog to edit that entry — mirrors the pre-drag-support click behavior.
          const state = useMazeStore.getState();
          if (state.presetConnectionsTool === "elevator") {
            const hit = this.draggingElevatorEndpoint;
            const entry = state.presetElevators.find((e) => e.id === hit.id);
            const own = entry?.floors.find((f) => (f.level ?? 0) === hit.level);
            if (own) state.startPresetElevatorPlacement(own);
          }
        }
        useMazeStore.getState().setPresetDragOverride(null);
        this.draggingElevatorEndpoint = null;
        this.elevatorDragMoved = false;
      }
    }
  }

  cancelPointerGesture(): void {
    const gestureActive = this.isDragActive
      || this.draggingMarker !== null
      || this.draggingTeleportEndpoint !== null
      || this.draggingVerticalPassageEndpoint !== null
      || this.draggingElevatorEndpoint !== null;
    super.cancelPointerGesture();
    this.draggingTeleportEndpoint = null;
    this.teleportDragMoved = false;
    this.draggingVerticalPassageEndpoint = null;
    this.verticalPassageDragMoved = false;
    this.draggingElevatorEndpoint = null;
    this.elevatorDragMoved = false;
    this.markerDragMoved = false;
    this.bulkDelete = false;
    if (gestureActive) {
      useMazeStore.getState().setPresetDragOverride(null);
    }
  }

  /** Starts or completes a two-click teleport placement at the cell under (vpX, vpY). No-op if
   * the cell is outside the field, or (on completion) equal to the pending origin cell. */
  private tryTeleportClick(vpX: number, vpY: number, tool: string, state: ReturnType<typeof useMazeStore.getState>): void {
    const [x, y] = pointerCellAtConfig(state.floorFields[state.activeFloorId].tessellationConfig, vpX, vpY);
    const cell = { x, y };
    if (!this.renderer.getCachedCellSet().has(encodePoint(cell.x, cell.y))) return;

    const coords: [number, number] = [cell.x, cell.y];
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
  }
}
