import type { StateCreator } from "zustand";
import type { MazeStore, PresetConnectionsState, PresetConnectionsActions } from "../storeTypes";
import { removePresetEntityOrder, tryCommitPresetVerticalPassage, dispatchPresetElevatorPlacement } from "./presetConnectionsHelpers";
import { cycleVerticalPassageDirection, removeVerticalPassage, moveVerticalPassageEndpoint, moveElevatorEndpoint, removeElevator, cellExistsAt } from "../../pixi/fieldEditUtils";
import { resolvePresetSplitTargets } from "../../pixi/presetSplitResolve";
import type { PresetEndpoint } from "../../pixi/presetEndpoint";
import { debugStaleOf, resolveFieldAtOf } from "../storeHelpers";
import { notifyVerticalDragFailure, notifyVerticalPassageUnavailable } from "../../notifications/editRefusalNotifications";

type Creator = StateCreator<MazeStore, [], [], PresetConnectionsState & PresetConnectionsActions>;
type CreatorSet = Parameters<Creator>[0];
type CreatorGet = Parameters<Creator>[1];

export const createPresetVerticalActions = (set: CreatorSet, get: CreatorGet): Pick<PresetConnectionsActions, "startPresetVerticalPassagePlacement" | "choosePresetVerticalPassageDirection" | "cancelPresetVerticalPassagePlacement" | "cyclePresetVerticalPassageDirection" | "removePresetVerticalPassage" | "movePresetVerticalPassageEndpoint" | "movePresetElevatorEndpoint" | "setPresetDragOverride" | "startPresetElevatorPlacement" | "editPresetElevator" | "togglePresetElevatorFloor" | "confirmPresetElevatorPlacement" | "cancelPresetElevatorPlacement" | "removePresetElevator"> => ({
  startPresetVerticalPassagePlacement: (origin, tool) => {
    const state = get();
    const resolveFieldAt = resolveFieldAtOf(state);
    const originLevel = origin.level ?? 0;
    const availableDirections: ("up" | "down")[] = [];
    if (cellExistsAt(resolveFieldAt, origin.point, originLevel + 1)) availableDirections.push("up");
    if (originLevel > 0 && cellExistsAt(resolveFieldAt, origin.point, originLevel - 1)) availableDirections.push("down");
    if (availableDirections.length === 0) {
      notifyVerticalPassageUnavailable("preset_connections");
      return;
    }
    // Every click adds a new passage, even where one already exists (GitHub issue #748): a cell may
    // hold any number of elements. Editing an existing passage is the settings tool's job.
    if (availableDirections.length === 1) {
      tryCommitPresetVerticalPassage(get, set, origin, tool, availableDirections[0]);
      return;
    }
    set({ presetVerticalPassagePending: { origin, tool, availableDirections } });
  },

  choosePresetVerticalPassageDirection: (direction) => {
    const pending = get().presetVerticalPassagePending;
    if (!pending) return;
    tryCommitPresetVerticalPassage(get, set, pending.origin, pending.tool, direction);
  },

  cancelPresetVerticalPassagePlacement: () => set({ presetVerticalPassagePending: null }),

  cyclePresetVerticalPassageDirection: (id) => set((state) => ({
    presetVerticalPassages: cycleVerticalPassageDirection(state.presetVerticalPassages, id),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),

  removePresetVerticalPassage: (id) => set((state) => ({
    presetVerticalPassages: removeVerticalPassage(state.presetVerticalPassages, id),
    presetEntityOrder: removePresetEntityOrder(state.presetEntityOrder, `vertical_passage:${id}`),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),

  movePresetVerticalPassageEndpoint: (id, end, point) => {
    const state = get();
    const entry = state.presetVerticalPassages.find((p) => p.id === id);
    if (!entry) return;
    const otherEnd = end === "from" ? entry.to : entry.from;
    const ownLevel = (end === "from" ? entry.from.level : entry.to.level) ?? 0;
    const otherLevel = otherEnd.level ?? 0;
    // Whether the OTHER floor even has a cell at the new point is checked here, before ANY
    // split-target dialog opens — `moveVerticalPassageEndpoint`'s own `cellExistsAt` failure path
    // only runs after the split-target queue (if any) has fully drained, which used to mean the
    // user could answer a "which node?" prompt only to be told afterwards that the drag failed
    // outright. A failure here is unaffected by which split node gets picked, so it's cheaper and
    // more honest to catch it up front.
    const resolveFieldAt = resolveFieldAtOf(state);
    if (!cellExistsAt(resolveFieldAt, point, otherLevel)) {
      notifyVerticalDragFailure("preset_connections", "vertical_passage", point, otherLevel);
      return;
    }
    // Both landing points (the dragged end's new point AND the other end's own point, same (x, y),
    // GitHub issue #566) can independently be declared split (GitHub issue #594) — checked BEFORE
    // `moveVerticalPassageEndpoint`'s own `cellExistsAt` failure path, since a split pick has
    // nothing to do with whether the other floor even has a cell there.
    const { picks, queue } = resolvePresetSplitTargets(
      [{ point, level: ownLevel === 0 ? undefined : ownLevel }, { point, level: otherLevel === 0 ? undefined : otherLevel }],
      state.presetSplitPoints,
    );
    if (queue.length === 0) {
      const result = moveVerticalPassageEndpoint(state.presetVerticalPassages, { id, end }, point, resolveFieldAt, picks[0], picks[1]);
      if (result.failure) notifyVerticalDragFailure("preset_connections", "vertical_passage", result.failure.point, result.failure.level);
      else set({ presetVerticalPassages: result.passages, presetsDirty: true, debugStale: debugStaleOf(state) });
      return;
    }
    const first = queue[0];
    set({
      presetSplitTargetPrompt: {
        point: first.point, level: first.level, slotIds: first.slotIds,
        action: { tool: "move_vertical_passage_endpoint", id, end },
        queue, picks,
      },
      presetEntityDeletePrompt: null,
    });
  },

  movePresetElevatorEndpoint: (id, level, point) => {
    const state = get();
    const entry = state.presetElevators.find((e) => e.id === id);
    if (!entry) return;
    const levels = entry.floors.map((f) => f.level ?? 0).sort((a, b) => a - b);
    // `levels` order mirrors `moveElevatorEndpoint`'s own — dragged floor first, then every OTHER
    // floor ascending — so `picks[i]` matches `levels[i]` the same way `place_elevator_target`'s
    // `picks` matches its own `levels` (GitHub issue #594, parity with post-edit's
    // `move_elevator_endpoint` from GitHub issue #567).
    const orderedLevels = [level, ...levels.filter((l) => l !== level)];
    // Every OTHER floor's cell existence at the new point is checked here, before ANY split-target
    // dialog opens — `moveElevatorEndpoint`'s own `cellExistsAt` failure path only runs after the
    // whole split-target queue has drained, which used to let the user answer several "which node?"
    // prompts only to be told afterwards the drag failed outright because some other floor simply
    // has no cell there. A failure here is unaffected by which split node gets picked on any floor.
    const resolveFieldAt = resolveFieldAtOf(state);
    for (const otherLevel of levels.filter((l) => l !== level)) {
      if (!cellExistsAt(resolveFieldAt, point, otherLevel)) {
        notifyVerticalDragFailure("preset_connections", "elevator", point, otherLevel);
        return;
      }
    }
    const { picks, queue } = resolvePresetSplitTargets(
      orderedLevels.map((l) => ({ point, level: l === 0 ? undefined : l })),
      state.presetSplitPoints,
    );
    if (queue.length === 0) {
      const overridesByLevel = new Map(orderedLevels.map((l, i) => [l, picks[i]!]));
      const result = moveElevatorEndpoint(state.presetElevators, { id, level }, point, resolveFieldAt, overridesByLevel);
      if (result.failure) notifyVerticalDragFailure("preset_connections", "elevator", result.failure.point, result.failure.level);
      else set({ presetElevators: result.elevators, presetsDirty: true, debugStale: debugStaleOf(state) });
      return;
    }
    const first = queue[0];
    set({
      presetSplitTargetPrompt: {
        point: first.point, level: first.level, slotIds: first.slotIds,
        action: { tool: "move_elevator_endpoint", id, levels: orderedLevels },
        queue, picks,
      },
      presetEntityDeletePrompt: null,
    });
  },

  setPresetDragOverride: (override) => set({ presetDragOverride: override }),
  // Always starts a new elevator, even on a point that already has one (GitHub issue #748).
  startPresetElevatorPlacement: (origin) => set({ presetElevatorPending: { origin, floors: new Set([origin.level ?? 0]) } }),

  // `floors` seeds from the entry's current floors so the dialog reflects real state, and confirming
  // updates the entry in place (GitHub issue #341 follow-up).
  editPresetElevator: (id, origin) => set((state) => {
    const existing = state.presetElevators.find((e) => e.id === id);
    if (!existing) return {};
    return { presetElevatorPending: { origin, floors: new Set(existing.floors.map((f) => f.level ?? 0)), editingId: existing.id } };
  }),

  togglePresetElevatorFloor: (floorIndex) => set((state) => {
    const pending = state.presetElevatorPending;
    if (!pending) return {};
    const originLevel = pending.origin.level ?? 0;
    if (floorIndex === originLevel) return {};
    const floors = new Set(pending.floors);
    if (floors.has(floorIndex)) floors.delete(floorIndex);
    else floors.add(floorIndex);
    return { presetElevatorPending: { ...pending, floors } };
  }),

  confirmPresetElevatorPlacement: () => {
    const state = get();
    const pending = state.presetElevatorPending;
    if (!pending || pending.floors.size < 2) return;
    const point = pending.origin.point;
    const originLevel = pending.origin.level ?? 0;
    const levels = Array.from(pending.floors).sort((a, b) => a - b);
    // The ORIGIN's own level (GitHub issue #594 follow-up bug report) must NOT be re-resolved here
    // even if it's declared split — `pending.origin` already carries the exact node the user picked
    // for it (either a plain click, or an earlier `PresetSplitTargetDialog` pick when the origin
    // point itself was split — see `applyPresetSplitTargetPick`'s `elevator` branch). Re-running
    // `resolvePresetSplitTargets` against every floor including the origin's own re-queued a pick
    // for a point the user had already resolved, and — because that extra queue entry's
    // `targetIndex` never got filled by anything downstream — the elevator never committed at all
    // (`dispatchPresetElevatorPlacement`'s `floors.length === action.levels.length` check kept
    // failing forever): the origin's own point was in BOTH `presetSplitTargetPrompt`'s queue and
    // already "resolved" in the user's mind, but nothing in this flow ever wrote `pending.origin`
    // into `picks` for it.
    const otherLevels = levels.filter((level) => level !== originLevel);
    const { picks: otherPicks, queue } = resolvePresetSplitTargets(
      otherLevels.map((level) => ({ point, level: level === 0 ? undefined : level })),
      state.presetSplitPoints,
    );
    const picks: (PresetEndpoint | undefined)[] = levels.map((level) =>
      level === originLevel ? pending.origin : otherPicks[otherLevels.indexOf(level)]);
    // `queue` entries carry `targetIndex` into `otherPicks`/`otherLevels` — remap onto `picks`' own
    // (full `levels`-based) indexing, since `levels` and `otherLevels` diverge by one skipped slot.
    const remappedQueue = queue.map((q) => ({ ...q, targetIndex: levels.indexOf(otherLevels[q.targetIndex]) }));
    if (remappedQueue.length === 0) {
      const floors = picks.filter((p): p is PresetEndpoint => p !== undefined);
      dispatchPresetElevatorPlacement(get, set, pending.editingId, floors);
      return;
    }
    const first = remappedQueue[0];
    set({
      presetSplitTargetPrompt: {
        point: first.point, level: first.level, slotIds: first.slotIds,
        action: { tool: "place_elevator_target", origin: pending.origin, levels, editingId: pending.editingId },
        queue: remappedQueue, picks,
      },
      presetEntityDeletePrompt: null,
    });
  },

  cancelPresetElevatorPlacement: () => set({ presetElevatorPending: null }),

  removePresetElevator: (id) => set((state) => ({
    presetElevators: removeElevator(state.presetElevators, id),
    presetEntityOrder: removePresetEntityOrder(state.presetEntityOrder, `elevator:${id}`),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),
});
