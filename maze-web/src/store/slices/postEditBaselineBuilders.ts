import type { NodeDto, EdgeDto } from "../../wasm/types";
import { type PostEditEndpoint, nodeEndpoint, splitEndpoint, resolverForNodeId, buildSplitNodeResolver } from "../../pixi/postEditEndpoint";
import { deriveSplitPointsFromNodes } from "../../pixi/splitPointsCore";
import { buildPostEditDraftEdgesFromGenerated, extractPostEditTeleports, pruneRemovedSplitNodes, assignSequentialIds, extractPostEditVerticalPassages, extractPostEditElevators } from "../../pixi/postEditUtils";
import type { PostEditBaseline, PostEditDerivedState, PostEditReplayContext } from "../../pixi/postEditReplay";
import type { MazeStore, PostEditVerticalPassageEntry } from "../storeTypes";
import type { PostEditEdge, PostEditElevatorEntry, PostEditTeleportEntry } from "../postEditTypes";
import { formatPostEditId } from "../../pixi/postEditIdFormat";
import { buildPostEditPointEntities, type PostEditPointEntityDescriptor } from "../../pixi/postEditPointEntities";
import { buildNodeByIdMap } from "../../pixi/postEditCommandLabels";
import { buildPostEditResetLifelines, type PostEditResetLifelineDescriptor } from "../../pixi/postEditResetLifelines";
import type { SplitLabelContext } from "../../pixi/postEditSplitLabels";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";

/** Groups a multi-floor `NodeDto[]` (GitHub issue #337) by `level` (`undefined` → `0`, same
 * convention `PresetEndpoint.level`/`activeFloorLevel` use) — the per-floor unit every point-keyed
 * grouping below (`deriveSplitPointsFromNodes`, `buildPointNodeMap`) must operate on one at a time,
 * since two nodes sharing an (x, y) on different floors would otherwise be conflated into one bogus
 * split-point group (GitHub issue #358). */
export function groupNodesByLevel(nodes: NodeDto[]): Map<number, NodeDto[]> {
  const m = new Map<number, NodeDto[]>();
  for (const n of nodes) {
    const level = n.level ?? 0;
    const list = m.get(level);
    if (list) list.push(n);
    else m.set(level, [n]);
  }
  return m;
}

/** Builds the `(x,y) -> NodeId[]` map (point → every real node at it, in snapshot order) that
 * `buildSplitNodeResolver` needs, from a confirmed `nodes` snapshot already scoped to one floor —
 * always bare `"x,y"` keys, matching `deriveSplitPointsFromNodes`'s own key convention (never
 * suffixed, see `pointKey`'s doc comment) for the split-points map it's paired against here. */
export function buildPointNodeMap(nodes: { id: number; x: number; y: number }[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    const list = m.get(key);
    if (list) list.push(n.id);
    else m.set(key, [n.id]);
  }
  return m;
}

/** Builds the same `(x,y) -> NodeId[]` map as `buildPointNodeMap`, but for a `nodes` list that can
 * span every floor at once (GitHub issue #358) — keyed `"x,y"` for floor 0, `"x,y@level"`
 * otherwise, matching `postEditDraftSplitPoints`'s own key convention so `buildSplitNodeResolver`'s
 * level-aware lookup can tell same-(x,y) points on different floors apart. */
export function buildMultiFloorPointNodeMap(nodes: { id: number; x: number; y: number; level?: number }[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const n of nodes) {
    const level = n.level ?? 0;
    const key = level === 0 ? `${n.x},${n.y}` : `${n.x},${n.y}@${level}`;
    const list = m.get(key);
    if (list) list.push(n.id);
    else m.set(key, [n.id]);
  }
  return m;
}

/** Resolves a raw confirmed `NodeId` back to a `PostEditEndpoint` that carries the CORRECT `level`
 * (GitHub issue #550 tenth follow-up) — `resolverForNodeId`'s own return value never sets `level`
 * (it only ever has `pointNodeMap`/`splitPoints` to work from, not `nodes` itself), so every caller
 * that needs a multi-floor-correct split endpoint had to re-inject `level` from `nodes` by hand:
 * `applyPostEditSplitTargetPick`, `commitPostEditVerticalPassage`, `confirmPostEditElevatorPlacement`
 * (this file/`postEditSlice.ts`), `tryTeleportClick` (`PostEditController.ts`) all built the exact
 * same `buildMultiFloorPointNodeMap` + `resolverForNodeId` + "look up `id`'s own level, re-stamp it
 * onto the split endpoint" sequence independently. This is that sequence, once. `nodes` is scanned
 * once per call, same cost the duplicated call sites already paid individually. */
export function resolveNodeIdToEndpoint(
  nodes: { id: number; x: number; y: number; level?: number }[],
  splitPoints: Readonly<Record<string, number[]>>,
  id: number,
): PostEditEndpoint {
  const pointNodeMap = buildMultiFloorPointNodeMap(nodes);
  const ep = resolverForNodeId(pointNodeMap, splitPoints)(id);
  if (ep.kind !== "split") return ep;
  const level = nodes.find((n) => n.id === id)?.level;
  return splitEndpoint(ep.point, ep.slotId, level === 0 ? undefined : level);
}

/** Builds a fresh multi-floor post-edit draft (`postEditDraftEdges`/`postEditDraftTeleports`/
 * `postEditDraftSplitPoints`, plus the `endpointFor` resolver used for `start`/`finish`) straight
 * from a flat `nodes`/`edges` list spanning every floor at once — the one piece of logic
 * `resetPostEdit` (rebuilding the draft from `_generatedNodes`/`_generatedEdges` on reset) and
 * `generateConfigBuilder`'s fresh-generation path (building the initial draft from
 * `snapshot.nodes`/`snapshot.edges`) both need identically. Every floor's own nodes/edges are
 * processed separately (`groupNodesByLevel`) since two nodes sharing an (x, y) on different floors
 * must not be conflated into one bogus split-point group by the point-keyed grouping below
 * (`deriveSplitPointsFromNodes`, `buildPointNodeMap`) — each floor's own `splitEndpoint`s are
 * stamped with that floor's `level`. A teleport whose two endpoints sit on different floors is
 * re-derived separately from the full, unfiltered `edges` (the per-level loop drops it, since
 * both endpoints must be in the same `levelIds` set to survive that filter) — GitHub issue #363.
 * Previously duplicated between `resetPostEdit` and the fresh-generation path; the latter's own
 * copy used a single global, level-unaware `pointNodeMap` across every floor's nodes combined,
 * which silently broke every split point on any floor above the first (GitHub issue #425). */
export function buildMultiFloorPostEditDraft(
  nodes: NodeDto[],
  edges: EdgeDto[],
): {
  draftEdges: Record<string, PostEditEdge>;
  draftTeleports: PostEditTeleportEntry[];
  splitPoints: Record<string, number[]>;
  splitPointIds: Record<string, string>;
  draftVerticalPassages: PostEditVerticalPassageEntry[];
  draftElevators: PostEditElevatorEntry[];
  endpointFor: (id: number) => PostEditEndpoint;
} {
  const nodesByLevel = groupNodesByLevel(nodes);
  const splitPoints: Record<string, number[]> = {};
  const endpointForId = new Map<number, PostEditEndpoint>();
  let draftEdges: Record<string, PostEditEdge> = {};
  let draftTeleports: PostEditTeleportEntry[] = [];

  for (const [level, levelNodes] of nodesByLevel) {
    const levelIds = new Set(levelNodes.map((n) => n.id));
    const levelEdges = edges.filter((e) => levelIds.has(e.from) && levelIds.has(e.to));
    const levelKey = level === 0 ? undefined : level;
    const pointNodeMap = buildPointNodeMap(levelNodes);
    const levelSplitPoints = deriveSplitPointsFromNodes(levelNodes);
    const rawEndpointFor = resolverForNodeId(pointNodeMap, levelSplitPoints);
    const endpointFor = (id: number): PostEditEndpoint => {
      const ep = rawEndpointFor(id);
      return ep.kind === "split" ? splitEndpoint(ep.point, ep.slotId, levelKey) : ep;
    };
    for (const id of levelIds) endpointForId.set(id, endpointFor(id));

    for (const [key, slots] of Object.entries(levelSplitPoints)) {
      splitPoints[levelKey === undefined ? key : `${key}@${levelKey}`] = slots;
    }

    draftEdges = { ...draftEdges, ...buildPostEditDraftEdgesFromGenerated(levelEdges, endpointFor) };
    const { teleports } = extractPostEditTeleports(levelEdges, endpointFor);
    draftTeleports = [...draftTeleports, ...teleports];
  }

  const endpointFor = (id: number): PostEditEndpoint => endpointForId.get(id) ?? nodeEndpoint(id);

  const levelForId = new Map<number, number>();
  for (const n of nodes) levelForId.set(n.id, n.level ?? 0);
  const crossFloorTeleportEdges = edges.filter(
    (e) => e.kind === "teleport" && levelForId.get(e.from) !== levelForId.get(e.to),
  );
  if (crossFloorTeleportEdges.length > 0) {
    const { teleports } = extractPostEditTeleports(crossFloorTeleportEdges, endpointFor);
    draftTeleports = [...draftTeleports, ...teleports];
  }

  // Renumbered once, after every batch (per-level + cross-floor) is merged, so ids stay unique
  // across the whole draft — each `extractPostEditTeleports` call numbers its own batch from 1.
  draftTeleports = draftTeleports.map((t, i) => ({ ...t, id: formatPostEditId("teleport", i + 1) }));

  // Split-tile id (GitHub issue #564) — one id per point key, assigned deterministically from the
  // sorted canonical point keys (`assignSequentialIds`), independent of node/edge iteration order.
  const splitPointIdMap = assignSequentialIds(Object.keys(splitPoints).map((key) => ({ key })));
  const splitPointIds: Record<string, string> = {};
  for (const [key, id] of splitPointIdMap) splitPointIds[key] = formatPostEditId("splitPoint", id);

  // Generation-baked vertical passages/elevators (GitHub issue #564) — extracted from the FULL,
  // unfiltered `edges` (both entities are cross-floor-native, no per-level/cross-floor double pass
  // needed the way teleport extraction needs). Each category gets its own `assignSequentialIds`
  // call — separate id namespace, never shared with one-way/split-point/the other vertical kind.
  const vpExtracted = extractPostEditVerticalPassages(edges, endpointFor);
  const vpIds = assignSequentialIds(vpExtracted.map((e) => ({ key: e.key })));
  const draftVerticalPassages: PostEditVerticalPassageEntry[] = vpExtracted.map((e) => ({ ...e.entity, id: formatPostEditId("verticalPassage", vpIds.get(e.key)!) }));

  const elevatorExtracted = extractPostEditElevators(edges, endpointFor);
  const elevatorIds = assignSequentialIds(elevatorExtracted.map((e) => ({ key: e.key })));
  const draftElevators: PostEditElevatorEntry[] = elevatorExtracted.map((e) => ({ ...e.entity, id: formatPostEditId("elevator", elevatorIds.get(e.key)!) }));

  return { draftEdges, draftTeleports, splitPoints, splitPointIds, draftVerticalPassages, draftElevators, endpointFor };
}

/** Builds a fresh `PostEditBaseline` from a generation snapshot (GitHub issue #543) — the
 * replacement for `buildMultiFloorPostEditDraft`'s old "build the initial draft" role, now
 * producing the replay context + empty-log derived state a fresh command log folds on top of.
 * `revision` is the caller's responsibility to bump (only on new generation, never on reset). */
export function buildPostEditBaseline(
  nodes: NodeDto[],
  edges: EdgeDto[],
  revision: number,
  generatedStart: number | null,
  generatedFinish: number | null,
): PostEditBaseline {
  const { draftEdges, draftTeleports, splitPoints, splitPointIds, draftVerticalPassages, draftElevators, endpointFor } =
    buildMultiFloorPostEditDraft(nodes, edges);
  const derived: PostEditDerivedState = {
    edges: draftEdges,
    teleports: draftTeleports,
    meta: {
      start: generatedStart !== null ? endpointFor(generatedStart) : null,
      finish: generatedFinish !== null ? endpointFor(generatedFinish) : null,
    },
    splitPoints,
    splitPointIds,
    verticalPassages: draftVerticalPassages,
    elevators: draftElevators,
  };
  const prunedNodes = pruneRemovedSplitNodes(nodes, splitPoints, (n) => {
    const level = n.level ?? 0;
    return level === 0 ? `${n.x},${n.y}` : `${n.x},${n.y}@${level}`;
  });
  const pointNodeMap = buildMultiFloorPointNodeMap(prunedNodes);
  const resolveSplit = buildSplitNodeResolver(pointNodeMap, splitPoints);
  const context: PostEditReplayContext = { nodes, edges, resolveSplit };
  return { revision, context, derived };
}

/** The slice of `MazeStore` `buildPostEditPointEntitiesAt` actually reads — narrowed out so a
 * caller that only has these fields (not a full `MazeStore`) can still share the exact same
 * resolution logic instead of reimplementing it. `PostEditEntityDeleteDialog` is the motivating
 * case (GitHub issue #550 tenth follow-up): it subscribes to each field individually via
 * `useMazeStore` selectors for render reactivity (a single `getState()` snapshot wouldn't
 * re-render on store changes), so it can't just pass a `MazeStore` through — but it needs the
 * exact same `nodesHere`/`nodeLevel`/`nodeById`/`inFieldCellsAt`/`splitCtx` assembly this function
 * already does, previously duplicated near-verbatim in the dialog component itself. */
export type PostEditPointEntitiesSourceState = Pick<
  MazeStore,
  | "nodes" | "postEditDraftSplitPoints" | "postEditDraftMeta" | "postEditDraftTeleports"
  | "postEditDraftVerticalPassages" | "postEditDraftElevators" | "postEditDraftEdges"
  | "floors" | "floorFields" | "activeFieldConfig" | "postEditActiveSplitNode"
>;

/** The `SplitLabelContext` both point-scoped pickers label their rows with, resolved from live state. */
function buildSplitLabelContext(
  state: Pick<MazeStore, "nodes" | "postEditDraftSplitPoints" | "postEditActiveSplitNode" | "floors" | "floorFields" | "activeFieldConfig" | "postEditDraftEdges">,
): SplitLabelContext {
  const inFieldCellsAt = (lvl: number | undefined): ReadonlySet<string> => {
    const floor = state.floors[lvl ?? 0];
    const field = floor ? state.floorFields[floor.id] : undefined;
    return field ? buildCellSet(buildActiveCells(field.fieldPoints, field.fieldEditMode, field.fieldConfig)) : new Set<string>();
  };
  const cfgAt = (lvl: number | undefined): typeof state.activeFieldConfig => {
    const floor = state.floors[lvl ?? 0];
    const field = floor ? state.floorFields[floor.id] : undefined;
    return field ? field.fieldConfig : state.activeFieldConfig;
  };
  return {
    allNodes: state.nodes,
    splitPoints: state.postEditDraftSplitPoints,
    activeSplitNode: state.postEditActiveSplitNode,
    draftEdges: state.postEditDraftEdges,
    cfgAt,
    inFieldCellsAt,
  };
}

/** Builds the removable-entity list for the post-edit delete-tool picker dialog (GitHub issue
 * #550) at one point/level — resolves `point`'s nodes (original node's confirmed id plus every
 * declared split slot) from `state.nodes`/`postEditDraftSplitPoints`, then defers to
 * `buildPostEditPointEntities` for the actual per-entity scan. Returns `[]` when the point has no
 * confirmed original node yet (nothing to target). Shared by `requestPostEditEntityDelete` and
 * `removePostEditPointEntity` (re-checking whether the prompt's scope emptied out), and by
 * `PostEditEntityDeleteDialog` itself, so all three read live state through the exact same
 * resolution. */
export function buildPostEditPointEntitiesAt(
  state: PostEditPointEntitiesSourceState,
  point: [number, number],
  level: number | undefined,
): PostEditPointEntityDescriptor[] {
  const originalNode = state.nodes.find((n) => n.x === point[0] && n.y === point[1] && (n.level ?? 0) === (level ?? 0));
  if (!originalNode) return [];
  const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
  const slotIds = [...(state.postEditDraftSplitPoints[key] ?? [])].sort((a, b) => a - b);
  const nodesHere: PostEditEndpoint[] = [nodeEndpoint(originalNode.id), ...slotIds.map((slotId) => splitEndpoint(point, slotId, level))];
  const nodeLevel = (ep: PostEditEndpoint): number => {
    if (ep.kind === "split") return ep.level ?? 0;
    return state.nodes.find((n) => n.id === ep.id)?.level ?? 0;
  };
  const nodeById = buildNodeByIdMap(state.nodes);
  const multiFloor = state.floors.length > 1;
  // Same `SplitLabelContext` shape `PostEditChangesPanel`/`PostEditEntityDeleteDialog` build for
  // their own rows — needed here too since `buildPostEditPointEntities` now stamps every row with
  // the exact same coordinate bubbles the changes log shows (GitHub issue #550 fourth follow-up).
  const splitCtx = buildSplitLabelContext(state);
  return buildPostEditPointEntities(nodesHere, slotIds, {
    postEditDraftSplitPoints: state.postEditDraftSplitPoints,
    postEditDraftMeta: state.postEditDraftMeta,
    postEditDraftTeleports: state.postEditDraftTeleports,
    postEditDraftVerticalPassages: state.postEditDraftVerticalPassages,
    postEditDraftElevators: state.postEditDraftElevators,
    nodeLevel,
    nodeById, multiFloor, splitCtx,
  });
}

/** The slice of `MazeStore` `buildPostEditResetLifelinesAt` reads — same narrowing reasoning as
 * `PostEditPointEntitiesSourceState`, plus the log/baseline fields a lifeline listing (unlike the
 * delete picker's live-entity listing) needs to read directly. */
export type PostEditResetLifelinesSourceState = Pick<
  MazeStore,
  "nodes" | "postEditDraftSplitPoints" | "postEditActiveSplitNode" | "floors" | "floorFields" | "activeFieldConfig"
  | "postEditBaseline" | "postEditCommands" | "postEditDraftEdges"
>;

/** Builds the row list for the post-edit Reset tool's multi-lifeline picker dialog (GitHub issue
 * #549) at one point/level — defers to `buildPostEditResetLifelines` for the actual lifeline
 * collection/labeling, resolving the `nodeById`/`splitCtx` label context the same way
 * `buildPostEditPointEntitiesAt` does. Returns `[]` before the first generation (no baseline yet). */
export function buildPostEditResetLifelinesAt(
  state: PostEditResetLifelinesSourceState,
  point: [number, number],
  level: number | undefined,
): PostEditResetLifelineDescriptor[] {
  if (state.postEditBaseline === null) return [];
  const nodeById = buildNodeByIdMap(state.nodes);
  const multiFloor = state.floors.length > 1;
  const splitCtx = buildSplitLabelContext(state);
  return buildPostEditResetLifelines(state.postEditBaseline, state.postEditCommands, point, level, nodeById, multiFloor, splitCtx);
}
