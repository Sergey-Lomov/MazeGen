import type { NodeDto, EdgeDto, IssueDto } from "../../../wasm/types";
import type { MazeState } from "../../../store/mazeStore";
import { splitPatternsFor } from "../../shapeTemplates";
import { qcForTessellation } from "../../../store/slices/qcTessellationFilter";
import { sameTessellation } from "../../../store/storeHelpers";

/** Narrows a maze-wide `{ nodes, edges, start, finish }` view down to one floor, by `activeFloorId`
 *  (GitHub issue #337/#347) — the single shared floor-scoping step every render-facing consumer of
 *  a possibly-multi-floor node/edge set needs before handing them to the walls/teleports/split
 *  selectors above, none of which are floor-aware themselves: two nodes sharing an (x, y) on
 *  different floors would otherwise be mistaken for a split point by `buildSplitPointKeys`'s
 *  per-point grouping. Was inlined once in `GenerationRenderer`'s own `debugView` (GitHub issue
 *  #337); factored out here once `VectorByWallsRenderer`/`VectorByCorridorsRenderer` needed the
 *  identical scoping (GitHub issue #347) rather than each renderer re-deriving `activeFloorIndex`
 *  and re-filtering on its own. `activeFloorId` resolves to an index via `floors`' own array
 *  position (`levels_ordered()` order — see `Specs/floors.md`), defaulting to `0` (floor 1) when
 *  `activeFloorId` doesn't match any current floor (same defensive fallback `GenerationRenderer`
 *  used). A `vertical_passage`/`elevator` edge survives the cut as soon as `from` is on the active
 *  floor, even though `to` never is (it leads to another floor by construction). A `teleport` edge
 *  survives the same way (GitHub issue #337 cross-floor teleport rendering) — `to` may land on
 *  another floor once teleports themselves support cross-floor targets (#340); `buildTeleportEdges`
 *  is the one that resolves such a `to`'s real (off-image) position via `resolveNodeLevel` and
 *  substitutes a midpoint, not this function. Every other kind still requires both ends on the
 *  active floor, same as before this function existed, since an intra-floor edge with a dangling
 *  `to` is not something any of these selectors expect to handle. `start`/`finish` are only kept
 *  when they resolve to a node that survived the cut. */
export function selectFloorScopedMaze(
  nodes: NodeDto[],
  edges: EdgeDto[],
  floors: { id: string }[],
  activeFloorId: string,
  start: number | null = null,
  finish: number | null = null,
): { nodes: NodeDto[]; edges: EdgeDto[]; start: number | null; finish: number | null } {
  const activeFloorIndex = Math.max(floors.findIndex((f) => f.id === activeFloorId), 0);
  const floorNodes = nodes.filter((n) => (n.level ?? 0) === activeFloorIndex);
  const floorNodeIds = new Set(floorNodes.map((n) => n.id));
  const crossesFloorFreely = (e: EdgeDto) =>
    e.kind === "vertical_passage" || e.kind === "elevator" || e.kind === "teleport";
  const floorEdges = edges.filter((e) =>
    floorNodeIds.has(e.from) && (crossesFloorFreely(e) || floorNodeIds.has(e.to)),
  );
  return {
    nodes: floorNodes,
    edges: floorEdges,
    start: start !== null && floorNodeIds.has(start) ? start : null,
    finish: finish !== null && floorNodeIds.has(finish) ? finish : null,
  };
}

/** Memoized floor-node scoping (GitHub issue #739) — returns the previous array while `nodes`,
 *  `floors` and `activeFloorId` are unchanged, so a per-pointermove caller gets a stable result and
 *  identity-keyed caches built on top of it stay valid. Each caller owns its own instance. */
export function createFloorNodesSelector(): (nodes: NodeDto[], floors: { id: string }[], activeFloorId: string) => NodeDto[] {
  let last: { nodes: NodeDto[]; floors: { id: string }[]; activeFloorId: string; result: NodeDto[] } | null = null;
  return (nodes, floors, activeFloorId) => {
    if (last && last.nodes === nodes && last.floors === floors && last.activeFloorId === activeFloorId) return last.result;
    const result = selectFloorScopedMaze(nodes, [], floors, activeFloorId).nodes;
    last = { nodes, floors, activeFloorId, result };
    return result;
  };
}

/** Narrow "ask, don't fetch" access to a node's own floor (GitHub issue #347) — built once from the
 *  full, unscoped `nodes` list (before `selectFloorScopedMaze` narrows it to one floor), so a caller
 *  that only has floor-scoped data in hand (e.g. `VectorByWallsRenderer`, after scoping its own
 *  `nodes`/`edges`) can still resolve the *other* floor's node a `vertical_passage`/`elevator`
 *  edge's `to` points at, without needing the whole unscoped node list passed around. Callers should
 *  build this once per render (not per edge) and pass the resolver function down, not the raw list —
 *  every renderer/selector wanting a node's level goes through this same narrow interface instead of
 *  each hand-rolling its own `Map`. */
export function selectNodeLevelResolver(nodes: NodeDto[]): (id: number) => number | undefined {
  const levelById = new Map(nodes.map((n) => [n.id, n.level ?? 0]));
  return (id: number) => levelById.get(id);
}

/** Every maze node id on floor `levelIndex` (`NodeDto.level ?? 0`, same 0-based `levels_ordered()`
 *  convention as `selectNodeLevelResolver`/`selectFloorScopedMaze`) — the reverse of
 *  `selectNodeLevelResolver`'s node->floor lookup, used for "highlight this whole floor" (a
 *  floor-scoped deficit issue, `IssuePayloadDto::AreaDeficit`, has no specific node/edge of its own
 *  to highlight, only the floor as a whole). */
export function selectNodeIdsForLevel(nodes: NodeDto[], levelIndex: number): number[] {
  return nodes.filter((n) => (n.level ?? 0) === levelIndex).map((n) => n.id);
}

// --- Loss-detection predicates ---
// When adding a new feature that produces user data (not analytics/read-only),
// add a predicate here and wire it into the relevant confirmation dialogs.

/** True when the user has made manual post-edit changes since the last generate/reset. */
export function selectPostEditDirty(s: Pick<MazeState, "postEditDirty">): boolean {
  return s.postEditDirty;
}

/** True when confirming tessellation would destroy data the user has entered. Kind change resets
 * every floor's own field config (Specs/field-editor.md), so any floor being dirty counts. */
export function selectTessellationWouldLoseData(s: Pick<MazeState,
  "previewKind" | "previewParams" | "tessellationKind" | "tessellationParams" | "floorFields" | "presetsDirty" | "mazeDirty" | "postEditDirty"
  | "previewFieldConfig" | "splitPatterns" | "rules" | "availableChecks" | "availableStrategies" | "availableRuleParams"
>): boolean {
  // Params define the cell set, so changing them resets the fields like a kind change does.
  if (!sameTessellation({ kind: s.previewKind, params: s.previewParams }, { kind: s.tessellationKind, params: s.tessellationParams })) {
    const anyFieldDirty = Object.values(s.floorFields).some((f) => f.fieldDirty);
    if (anyFieldDirty || s.presetsDirty || s.mazeDirty || s.postEditDirty) return true;
  }
  // Split patterns survive only when the new tessellation config provides their shape template
  // (GitHub issue #758) — checked on any config change, not just a kind change.
  const tessellation = s.previewFieldConfig.tessellation;
  if (splitPatternsFor(s.splitPatterns, tessellation).length !== s.splitPatterns.length) return true;
  const qc = qcForTessellation(s, tessellation);
  return qc.rules !== s.rules;
}

/** True when removing `floorId` would discard field data configured on that floor (GitHub issue
 * #338) — its own field config differs from a fresh default for the current maze-wide kind, i.e.
 * has custom points or a non-default predefined size. Preset connections are still maze-wide (see
 * Specs/space.md's "Not yet built on top of this layer" note), so nothing preset-related can be
 * lost by removing a single floor. */
export function selectFloorRemovalLosesFieldData(s: Pick<MazeState, "floorFields">, floorId: string): boolean {
  const field = s.floorFields[floorId];
  if (!field) return false;
  return field.fieldDirty;
}

/** True when removing or reordering floors would require resetting the current generation/
 * post-edit results — floor identity shift affects underlying node/graph state (see
 * Specs/space.md). The caller (FloorsFeature) must actually call `reset()` on confirm when this
 * is true, not just warn — a stale maze left on screen after floor identity changed underneath it
 * would be actively misleading, not merely "possibly outdated". */
export function selectFloorChangeLosesGenerationData(s: Pick<MazeState, "mazeDirty" | "postEditDirty">): boolean {
  return s.mazeDirty || s.postEditDirty;
}

const PIPELINE_ONLY_ISSUE_KINDS = ["repair_limit_reached"];

/** Issues shown by the Analytics card/feature — `postEditAnalytics.issues` when present
 * (recomputed by `confirmPostEdit`'s `computeAnalytics`, which always re-runs right after
 * generation, even with no user edits), else `issues` (the raw post-generation snapshot).
 * `computeAnalytics` runs QC alone, with no `RepairLimits` concept, so `repair_limit_reached`
 * (pushed only by `build_maze`'s repair loop — see `Specs/repair.md`) can never appear in
 * `postEditAnalytics.issues`; carried forward from `issues` regardless of which source otherwise
 * wins, so it survives the post-generation `confirmPostEdit` recompute. Single source of truth
 * for both the bubble list (`AnalyticsFeature`) and the card status (`FeaturesPanel`) — they must
 * agree on what counts as "this maze has issues". */
export function selectAnalyticsIssues(s: Pick<MazeState, "issues" | "postEditAnalytics">): IssueDto[] {
  return [
    ...s.issues.filter((i) => PIPELINE_ONLY_ISSUE_KINDS.includes(i.kind)),
    ...(s.postEditAnalytics?.issues ?? s.issues),
  ];
}
