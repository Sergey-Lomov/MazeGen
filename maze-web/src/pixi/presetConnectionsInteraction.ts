import type { PresetConnectionsState } from "../store/presetConnectionsTypes";
import type { PresetTeleportEntry } from "./fieldEditUtils";

/**
 * Returns whether a preset-side picker or delete prompt owns the current interaction.
 *
 * Pointer handlers call this before doing hit-testing or mutating the store. Keeping the
 * predicate independent from the controller makes the modal guard explicit and prevents a
 * pointermove from accidentally continuing a gesture underneath a synchronous prompt.
 */
export function isPresetConnectionsModalOpen(
  state: Pick<
    PresetConnectionsState,
    | "presetSplitTargetPrompt" | "presetEntityDeletePrompt" | "presetVerticalPassagePending" | "presetElevatorPending"
    | "presetEntityPickPrompt" | "presetConnectionSettingsPrompt" | "presetLockSettingsPrompt"
  >,
): boolean {
  return state.presetSplitTargetPrompt !== null
    || state.presetEntityDeletePrompt !== null
    || state.presetVerticalPassagePending !== null
    || state.presetElevatorPending !== null
    || state.presetEntityPickPrompt !== null
    || state.presetConnectionSettingsPrompt !== null
    || state.presetLockSettingsPrompt !== null;
}

/**
 * Hit-testing owns only the active floor's teleport endpoints. A cross-floor teleport is edited
 * from the floor containing its `from` endpoint, matching the renderer's ownership convention.
 */
export function teleportsOnLevel(
  teleports: PresetTeleportEntry[],
  level: number | undefined,
): PresetTeleportEntry[] {
  return teleports.filter((teleport) => (teleport.from.level ?? 0) === (level ?? 0));
}
