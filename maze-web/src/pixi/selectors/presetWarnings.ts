import type { NodeLockKind } from "../../wasm/types";
import type { PresetConnectionEntry, PresetElevatorEntry, PresetTeleportEntry, PresetVerticalPassageEntry } from "../../domain/fieldEditUtils";
import type { PresetEndpoint } from "../../domain/presetEndpoint";
import { presetSplitLabelContextOf } from "../../domain/presetSplitLabels";
import {
  computeInvalidElevatorIds, computeInvalidEndpoint, computeInvalidKeys, computeInvalidLockedNodeKeys, computeInvalidMarkers,
  computeInvalidSplitPoints, computeInvalidTeleportIds, computeInvalidVerticalPassageIds, listedInvalidConnections, listedInvalidSplitKeys,
} from "../../domain/fieldValidity";
import { computeIsolatedNodeKeys } from "./presetSelectors";
import { computePresetSplitProblems, type PresetSplitPointProblems } from "./presetSplitProblems";

type SplitContextInput = Parameters<typeof presetSplitLabelContextOf>[0];

/** The preset data the Problems section and the Features panel status both count warnings from
 *  (GitHub issue #1107). A subset of the store state, so the store itself can be passed. */
export interface PresetWarningInput {
  presetConnections: Map<string, PresetConnectionEntry>;
  presetSplitPoints: Record<string, number[]>;
  presetTeleports: PresetTeleportEntry[];
  presetVerticalPassages: PresetVerticalPassageEntry[];
  presetElevators: PresetElevatorEntry[];
  presetStart: PresetEndpoint | null;
  presetFinish: PresetEndpoint | null;
  presetGenSource: PresetEndpoint | null;
  lockedNodes: Map<string, NodeLockKind>;
  autoLockedNodes: Set<string>;
  presetActiveSplitNode: Record<string, PresetEndpoint>;
  floors: SplitContextInput["floors"];
  floorFields: SplitContextInput["floorFields"];
}

/** Problems of every preset split point: the face diagnostics shared with the split edit panel. */
export function computePresetSplitProblemsOf(input: PresetWarningInput): PresetSplitPointProblems[] {
  if (Object.keys(input.presetSplitPoints).length === 0) return [];
  const ctx = presetSplitLabelContextOf({
    splitPoints: input.presetSplitPoints,
    presetConnections: input.presetConnections,
    activeSplitNode: input.presetActiveSplitNode,
    floors: input.floors,
    floorFields: input.floorFields,
  });
  return ctx ? computePresetSplitProblems(ctx) : [];
}

/** Number of split problems (one per flagged node). */
export function countPresetSplitProblems(problems: PresetSplitPointProblems[]): number {
  return problems.reduce((sum, problem) => sum + problem.messages.length, 0);
}

/** Preset entities outside their floor's field, as the preset list shows them: one per user-authored
 *  connection (a split tile's face records are not rows), teleport, vertical passage, elevator, marker
 *  (start, finish, generation source), lock and split point with slots. */
export function computePresetInvalidElementCount(
  input: PresetWarningInput,
  resolveFieldAt: Parameters<typeof computeInvalidKeys>[1],
): number {
  const invalidMarkers = computeInvalidMarkers(input.presetStart, input.presetFinish, resolveFieldAt);
  return listedInvalidConnections(input.presetConnections, input.presetSplitPoints, computeInvalidKeys(input.presetConnections, resolveFieldAt)).length
    + computeInvalidTeleportIds(input.presetTeleports, resolveFieldAt).size
    + computeInvalidVerticalPassageIds(input.presetVerticalPassages, resolveFieldAt).size
    + computeInvalidElevatorIds(input.presetElevators, resolveFieldAt).size
    + (invalidMarkers.start ? 1 : 0) + (invalidMarkers.finish ? 1 : 0)
    + (computeInvalidEndpoint(input.presetGenSource, resolveFieldAt) ? 1 : 0)
    + computeInvalidLockedNodeKeys(input.lockedNodes, resolveFieldAt).size
    + listedInvalidSplitKeys(input.presetSplitPoints, computeInvalidSplitPoints(input.presetSplitPoints, resolveFieldAt)).length;
}

/** The warning count of the Preset Connections "Problems" section, also shown by the Features panel
 *  status: every isolated node and every split problem is one warning, all elements outside the
 *  field together are one. */
export function presetWarningCount(isolatedNodeCount: number, splitProblemCount: number, invalidElementCount: number): number {
  return isolatedNodeCount + splitProblemCount + (invalidElementCount > 0 ? 1 : 0);
}

/** `presetWarningCount` computed from the preset data alone. */
export function computePresetWarningCount(
  input: PresetWarningInput,
  resolveFieldAt: Parameters<typeof computeInvalidKeys>[1],
): number {
  return presetWarningCount(
    computeIsolatedNodeKeys(input.lockedNodes, input.autoLockedNodes, input.presetConnections).length,
    countPresetSplitProblems(computePresetSplitProblemsOf(input)),
    computePresetInvalidElementCount(input, resolveFieldAt),
  );
}
