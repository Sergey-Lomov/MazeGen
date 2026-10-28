import { type PresetConnectionEntry, type PresetVerticalPassageEntry, resolveCells } from "../../pixi/fieldEditUtils";
import { presetEdgeKey, resolvePresetSplitTargets } from "../../pixi/presetSplitResolve";
import { presetEndpoint, type PresetEndpoint } from "../../pixi/presetEndpoint";
import type { MazeState, MazeStore } from "../storeTypes";
import { debugStaleOf } from "../storeHelpers";
import { registerNotificationCode } from "../../notifications/notificationRegistry";
import * as m from "~/paraglide/messages";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import { levelFieldsOf } from "../storeHelpers";

/** Removes `presetConnections[key]`, but — unlike a plain `.delete` — leaves the pair reading as
 *  the maze's current `defaultEdgeState` (GitHub issue #540 follow-up bug report) rather than
 *  always falling back to `"undefined"`: when the default is `"wall"`/`"passage"`, every ordinary
 *  edge of the field already carries an explicit `source: "default"` entry (`applyDefaultEdgeState`)
 *  representing that state, so simply deleting the entry would silently regress it to undefined
 *  instead of the configured default. Mutates `presetConnections` in place — callers own cloning
 *  the map first. */
export function resetEdgeToDefault(
  presetConnections: Map<string, PresetConnectionEntry>,
  defaultEdgeState: "undefined" | "wall" | "passage",
  key: string,
  from: PresetEndpoint,
  to: PresetEndpoint,
): void {
  if (defaultEdgeState === "undefined") presetConnections.delete(key);
  else presetConnections.set(key, { from, to, state: defaultEdgeState, source: "default" });
}

export function appendPresetEntityOrder(order: string[], key: string): string[] {
  return order.includes(key) ? order : [...order, key];
}

export function removePresetEntityOrder(order: string[], key: string): string[] {
  return order.filter((existing) => existing !== key);
}

export function edgeEntityKey(key: string): string {
  return `edge:${key}`;
}

export function splitEntityKey(key: string): string {
  return `split:${key}`;
}

export function removeDeletedUserEdgeOrder(
  previous: Map<string, PresetConnectionEntry>,
  next: Map<string, PresetConnectionEntry>,
  order: string[],
): string[] {
  const removed = new Set<string>();
  for (const [key, entry] of previous) {
    if (entry.source === "user" && next.get(key)?.source !== "user") removed.add(edgeEntityKey(key));
  }
  return order.filter((key) => !removed.has(key));
}

export function addNewUserEdgeOrder(
  previous: Map<string, PresetConnectionEntry>,
  next: Map<string, PresetConnectionEntry>,
  order: string[],
): string[] {
  let result = order;
  for (const [key, entry] of next) {
    if (entry.source === "user" && previous.get(key)?.source !== "user") result = appendPresetEntityOrder(result, edgeEntityKey(key));
  }
  return result;
}

/** Builds the new `PresetVerticalPassageEntry` for a single-click placement (GitHub issue #357
 * follow-up) — `origin` is always `from`; `direction` ("up"/"down", already resolved as available
 * by `startPresetVerticalPassagePlacement`/the dialog) picks `to`'s floor. `vertical_passage_two_way`
 * always creates `direction: "two_way"`; `vertical_passage_one_way` always creates `"forward"` (`from`
 * is the departure end) — mirrors the old two-click tool's own click-order convention, just without
 * a second click.
 *
 * `toOverride` (GitHub issue #594) is the user's own pick from `PresetSplitTargetDialog`, already
 * resolved by `applyPresetSplitTargetPick` — when present it short-circuits the plain
 * `presetEndpoint(origin.point, undefined, toLevel)` default below, which otherwise always attached
 * `to` to the target floor's ORIGINAL node even when that point is declared split. Callers only ever
 * pass it once `tryCommitPresetVerticalPassage` has already confirmed `to`'s point isn't split (or
 * the dialog resolved it) — this function itself never re-checks split-ness. */
export function commitPresetVerticalPassage(
  state: MazeState,
  origin: PresetEndpoint,
  tool: "vertical_passage_one_way" | "vertical_passage_two_way",
  direction: "up" | "down",
  toOverride?: PresetEndpoint,
): Partial<MazeState> {
  const originLevel = origin.level ?? 0;
  const toLevel = direction === "up" ? originLevel + 1 : originLevel - 1;
  const to = toOverride ?? presetEndpoint(origin.point, undefined, toLevel === 0 ? undefined : toLevel);
  const entry: PresetVerticalPassageEntry = {
    id: state._nextPresetVerticalPassageId,
    from: origin,
    to,
    direction: tool === "vertical_passage_two_way" ? "two_way" : "forward",
  };
  return {
    presetVerticalPassages: [...state.presetVerticalPassages, entry],
    _nextPresetVerticalPassageId: state._nextPresetVerticalPassageId + 1,
    presetEntityOrder: appendPresetEntityOrder(state.presetEntityOrder, `vertical_passage:${entry.id}`),
    presetVerticalPassagePending: null,
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  };
}

/** Entry point for a FRESH vertical-passage placement (GitHub issue #594, parity with post-edit's
 * `tryCommitPostEditVerticalPassage` from GitHub issue #567) — wraps `commitPresetVerticalPassage`
 * with a split-tile check on the TARGET floor: `to`'s own point is looked up in `presetSplitPoints`
 * and, if declared split, the commit is deferred through `presetSplitTargetPrompt`
 * (`action.tool: "place_vertical_passage_target"`) instead of silently taking
 * `commitPresetVerticalPassage`'s previous `slotId: undefined` default. An unsplit `to` point
 * commits exactly as before. */
export function tryCommitPresetVerticalPassage(
  get: () => MazeStore,
  set: (partial: Partial<MazeStore> | ((state: MazeStore) => Partial<MazeStore>)) => void,
  origin: PresetEndpoint,
  tool: "vertical_passage_one_way" | "vertical_passage_two_way",
  direction: "up" | "down",
): void {
  const state = get();
  const originLevel = origin.level ?? 0;
  const toLevel = direction === "up" ? originLevel + 1 : originLevel - 1;
  const { picks, queue } = resolvePresetSplitTargets([{ point: origin.point, level: toLevel === 0 ? undefined : toLevel }], state.presetSplitPoints);
  if (queue.length === 0) {
    set(commitPresetVerticalPassage(state, origin, tool, direction, picks[0]));
    return;
  }
  const first = queue[0];
  set({
    presetSplitTargetPrompt: {
      point: first.point, level: first.level, slotIds: first.slotIds,
      action: { tool: "place_vertical_passage_target", origin, passageTool: tool, direction },
      queue, picks,
    },
    presetEntityDeletePrompt: null,
  });
}

/** Appends/updates the `PresetElevatorEntry` for a resolved `floors` list (GitHub issue #594,
 * parity with post-edit's `dispatchPostEditElevatorPlacement` from GitHub issue #567) — the tail end
 * of `confirmPresetElevatorPlacement`, factored out so `applyPresetSplitTargetPick`'s
 * `place_elevator_target` branch can call it too once every queued split floor has been resolved
 * through the dialog. `editingId` set → updates that existing entry in place; unset → mints a fresh
 * one with the next elevator id. */
export function dispatchPresetElevatorPlacement(
  get: () => MazeStore,
  set: (partial: Partial<MazeStore> | ((state: MazeStore) => Partial<MazeStore>)) => void,
  editingId: number | undefined,
  floors: PresetEndpoint[],
): void {
  const state = get();
  const presetElevators = editingId !== undefined
    ? state.presetElevators.map((e) => e.id === editingId ? { ...e, floors } : e)
    : [...state.presetElevators, { id: state._nextPresetElevatorId, floors }];
  const entityKey = `elevator:${editingId !== undefined ? editingId : state._nextPresetElevatorId}`;
  set({
    presetElevators,
    _nextPresetElevatorId: editingId !== undefined ? state._nextPresetElevatorId : state._nextPresetElevatorId + 1,
    presetEntityOrder: editingId !== undefined
      ? state.presetEntityOrder
      : appendPresetEntityOrder(state.presetEntityOrder, entityKey),
    presetElevatorPending: null,
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  });
}

export const REMOVE_ENDPOINT_NODE_REJECTED = "preset_connections.remove_endpoint_node_rejected";
registerNotificationCode(REMOVE_ENDPOINT_NODE_REJECTED, { category: "notice", message: () => m[REMOVE_ENDPOINT_NODE_REJECTED]() });

export function applyDefaultEdgeState(
  state: MazeState,
  newDefault: "undefined" | "wall" | "passage",
): Map<string, PresetConnectionEntry> {
  // Remove every existing default entry across all floors — `defaultEdgeState` is one maze-wide
  // toggle (GitHub issue #434), not per-floor, so a change must repopulate every floor's default
  // entries, not just the active floor's.
  const presetConnections = new Map(state.presetConnections);
  for (const [key, entry] of presetConnections) {
    if (entry.source === "default") presetConnections.delete(key);
  }

  if (newDefault === "undefined") return presetConnections;

  for (const levelField of levelFieldsOf(state)) {
    const { cfg, customPoints } = levelField;
    const cells = resolveCells(cfg, customPoints);
    const cellSet = buildCellSet(cells);

    for (const [x, y] of cells) {
      const { offsets } = getNeighborData(cfg, x, y);
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (!cellSet.has(`${nx},${ny}`)) continue;
        const less = x < nx || (x === nx && y < ny);
        if (!less) continue; // only process edge once (owner = canonical-lesser cell)
        const from = presetEndpoint([x, y], undefined, levelField.level);
        const to = presetEndpoint([nx, ny], undefined, levelField.level);
        const key = presetEdgeKey(from, to);
        if (!presetConnections.has(key)) {
          presetConnections.set(key, { from, to, state: newDefault, source: "default" });
        }
      }
    }
  }
  return presetConnections;
}
