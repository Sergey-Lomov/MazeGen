import type { MazeState } from "../store/storeTypes";
import { buildPresetPointEntities, type PresetPointEntityDescriptor, type PresetPointEntityKind } from "./pointEntities";
import type { PostEditPointEntityDescriptor, PostEditPointEntityKind } from "./postEditPointEntities";

/** What the move/settings tools (GitHub issue #748) do with the element picked in a cell. */
export type EntityToolPurpose = "move" | "settings";

const PRESET_KINDS: Record<EntityToolPurpose, ReadonlySet<PresetPointEntityKind>> = {
  move: new Set(["start", "finish", "gen_source", "teleport", "vertical_passage", "elevator", "lock"]),
  settings: new Set(["teleport", "vertical_passage", "elevator", "lock", "split_node"]),
};

const POST_EDIT_KINDS: Record<EntityToolPurpose, ReadonlySet<PostEditPointEntityKind>> = {
  move: new Set(["start", "finish", "teleport", "vertical_passage", "elevator"]),
  settings: new Set(["teleport", "vertical_passage", "elevator", "split_point"]),
};

/** Preset point entities the move or settings tool can act on, in the descriptor list's order. */
export function presetEntitiesForPurpose(
  purpose: EntityToolPurpose,
  entities: PresetPointEntityDescriptor[],
): PresetPointEntityDescriptor[] {
  return entities.filter((entity) => PRESET_KINDS[purpose].has(entity.kind));
}

/** Post-edit point entities the move or settings tool can act on, in the descriptor list's order. */
export function postEditEntitiesForPurpose(
  purpose: EntityToolPurpose,
  entities: PostEditPointEntityDescriptor[],
): PostEditPointEntityDescriptor[] {
  return entities.filter((entity) => POST_EDIT_KINDS[purpose].has(entity.kind));
}

/** Store fields `presetPurposeEntitiesAt` reads. */
export type PresetPointEntitySourceState = Pick<
  MazeState,
  | "floors" | "activeFloorId" | "presetSplitPoints" | "presetStart" | "presetFinish" | "presetGenSource"
  | "presetTeleports" | "presetVerticalPassages" | "presetElevators" | "presetConnections"
  | "lockedNodes" | "autoLockedNodes"
>;

/** Elements of the cell at `point`/`level` (every node of a split tile) that the move or settings
 *  tool can act on. */
export function presetPurposeEntitiesAt(
  state: PresetPointEntitySourceState,
  point: [number, number],
  level: number | undefined,
  purpose: EntityToolPurpose,
): PresetPointEntityDescriptor[] {
  const activeFloorIndex = Math.max(state.floors.findIndex((f) => f.id === state.activeFloorId), 0);
  const entities = buildPresetPointEntities(point, level, activeFloorIndex, { kind: "point_all" }, {
    presetSplitPoints: state.presetSplitPoints,
    presetStart: state.presetStart,
    presetFinish: state.presetFinish,
    presetGenSource: state.presetGenSource,
    presetTeleports: state.presetTeleports,
    presetVerticalPassages: state.presetVerticalPassages,
    presetElevators: state.presetElevators,
    presetConnections: state.presetConnections,
    lockedNodes: state.lockedNodes,
    autoLockedNodes: state.autoLockedNodes,
  });
  return presetEntitiesForPurpose(purpose, entities);
}
