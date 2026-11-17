import type { MazeStore, PresetConnectionsActions } from "./storeTypes";
import { hasGeneration } from "./storeHelpers";

/** A preset edit held back until the user confirms that it discards the generation and post-edit
 *  (GitHub issue #922). `run` replays the original, unguarded action call. */
export interface PendingPresetEdit {
  run: () => void;
}

type PresetActionName = keyof PresetConnectionsActions;

interface GuardedAction {
  name: PresetActionName;
  /** Narrows the guard to calls that really commit; other calls pass through. */
  when?: (args: unknown[]) => boolean;
}

/** Every action that commits preset data. Selection, hover, prompt and placement-in-progress
 *  actions are excluded: they change no preset data, so they never invalidate the maze. Multi-step
 *  actions are guarded at their entry point so the confirmation comes before the first change.
 *  Generation settings (`setGenerationSourceMode`) are excluded too: their controls live outside
 *  the preset card, where the confirmation dialog is not rendered. */
export const GUARDED_PRESET_ACTIONS: GuardedAction[] = [
  { name: "applyPresetConnectionsTool" }, { name: "applyPresetConnectionsToolAt" },
  { name: "cyclePresetConnectionDirection" }, { name: "setPresetConnectionUndefined" },
  { name: "clearInvalidPresetConnections" }, { name: "resetPresetConnections" },
  { name: "setAutoLock" }, { name: "setPresetStart" }, { name: "setPresetFinish" }, { name: "setPresetGenSource" },
  { name: "setPresetStartEndpoint" }, { name: "setPresetFinishEndpoint" }, { name: "setPresetGenSourceEndpoint" },
  { name: "setDefaultEdgeState" },
  { name: "setLockedNode" }, { name: "removeLockedNode" }, { name: "clearLockedNodes" },
  { name: "setPresetLockKind" }, { name: "movePresetLockTo" },
  { name: "addPresetTeleport" }, { name: "cyclePresetTeleportDirection" }, { name: "removePresetTeleport" },
  { name: "movePresetTeleportEndpoint" }, { name: "movePresetTeleportEndpointTo" }, { name: "setPresetTeleportDirection" },
  { name: "startPresetVerticalPassagePlacement" }, { name: "choosePresetVerticalPassageDirection" },
  { name: "cyclePresetVerticalPassageDirection" }, { name: "removePresetVerticalPassage" },
  { name: "movePresetVerticalPassageEndpoint" }, { name: "setPresetVerticalPassageDirection" },
  { name: "confirmPresetElevatorPlacement" }, { name: "removePresetElevator" }, { name: "movePresetElevatorEndpoint" },
  { name: "addPresetSplitNode" }, { name: "removePresetSplitNode" }, { name: "removePresetSplitAll" },
  { name: "rotatePresetSplitPoint" }, { name: "applyPresetSplitBlueprint" }, { name: "applyPresetSplitTargetPick" },
  { name: "resetPresetPoint" }, { name: "removePresetPointEntity" }, { name: "removeAllPresetPointEntities" },
  // The bulk shortcut removes several entities in one go; without `bulk` the call only opens a
  // picker or delegates to a guarded single removal.
  { name: "requestPresetEntityDelete", when: (args) => args[3] === true },
];

type Setter = (partial: Partial<MazeStore>) => void;

/** Wraps the preset data actions of `store` so that, while a generation or post-edit exists, they
 *  park in `presetEditConfirmation` instead of running. Mirrors the field-edit guard. */
export function guardPresetEdits(store: MazeStore, set: Setter, get: () => MazeStore): MazeStore {
  const actions = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const { name, when } of GUARDED_PRESET_ACTIONS) {
    const original = actions[name];
    actions[name] = (...args: unknown[]) => {
      const state = get();
      if (!hasGeneration(state) || (when && !when(args))) return original(...args);
      // A confirmation is already open: further edits wait for its answer rather than queueing.
      if (state.presetEditConfirmation !== null) return undefined;
      set({ presetEditConfirmation: { run: () => { original(...args); } } });
      return undefined;
    };
  }
  return store;
}
