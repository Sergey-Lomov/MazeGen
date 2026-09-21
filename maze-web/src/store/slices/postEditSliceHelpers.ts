import type { NodeDto, EdgeDto, PostEditEndpointWasmDto } from "../../wasm/types";
import type { PostEditEndpoint } from "../../pixi/postEditEndpoint";
import { nodeEndpoint, splitEndpoint, resolverForNodeId, buildSplitNodeResolver } from "../../pixi/postEditEndpoint";
import { deriveSplitPointsFromNodes } from "../../pixi/splitPointsCore";
import {
  buildPostEditDraftEdgesFromGenerated, extractPostEditTeleports, pruneRemovedSplitNodes, assignSequentialIds,
  extractPostEditVerticalPassages, extractPostEditElevators,
} from "../../pixi/postEditUtils";
import type {
  PostEditBaseline, PostEditDerivedState, PostEditReplayContext,
} from "../../pixi/postEditReplay";
import { applyPostEditCommand, replayPostEditCommands } from "../../pixi/postEditReplay";
import { compactPostEditCommands } from "../../pixi/postEditCompaction";
import type { PostEditCommand } from "../postEditCommandTypes";
import type { MazeStore, PostEditVerticalPassageEntry } from "../storeTypes";
import type { PostEditEdge, PostEditElevatorEntry, PostEditTeleportEntry } from "../postEditTypes";
import { formatPostEditId, parsePostEditIdNumber } from "../../pixi/postEditIdFormat";

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

/** `PostEditEndpoint` → the WASM edge/teleport DTO's endpoint shape. Not a passthrough: the split
 * variant's field is `slotId` on the TS-side `PostEditEndpoint` but `slot_id` on the wire
 * (`PostEditEndpointDto` derives `Deserialize` with no per-field rename, so serde expects the
 * literal Rust field name). */
export function toWasmEndpoint(ep: PostEditEndpoint): PostEditEndpointWasmDto {
  if (ep.kind === "split") {
    return { kind: "split", point: ep.point, slot_id: ep.slotId, level: ep.level ?? 0 };
  }
  return ep;
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

/** Resolves which of a point's confirmed nodes a placement targets — `activeSplitNode`'s own entry
 * for that point/level if one is a `node`-kind endpoint present in `nodeIds`, else the point's
 * first (original) node. Mirrors `PostEditController.resolveActiveEndpointAt`'s own fallback logic,
 * but for store-slice code that needs a plain `NodeId` rather than a `PostEditEndpoint` — used by
 * `commitPostEditVerticalPassage`'s `to` and `confirmPostEditElevatorPlacement`'s per-floor node
 * (GitHub issue #546 fifth follow-up: both previously always took `nodeIds[0]` outright, silently
 * collapsing every OTHER floor/endpoint of a split point down to its original node regardless of
 * which slot the user actually meant — only the FIRST endpoint of a placement ever went through the
 * split-target picker (`PostEditSplitTargetDialog`), which is the only thing that ever sets
 * `activeSplitNode` for a point in the first place; every subsequent point resolved by plain
 * coordinate lookup silently ignored it). A `split`-kind active entry (an unconfirmed slot) is not
 * resolved here — `nodeIds` is the CONFIRMED node list, so a still-unconfirmed active slot has no
 * matching id yet and falls back to the same "first node" default as no active entry at all. */
export function resolveActiveNodeIdAt(
  point: [number, number],
  nodeIds: number[],
  activeSplitNode: Record<string, PostEditEndpoint>,
  level?: number,
): number | undefined {
  if (nodeIds.length === 0) return undefined;
  const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
  const active = activeSplitNode[key];
  if (active?.kind === "node" && nodeIds.includes(active.id)) return active.id;
  return nodeIds[0];
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

  // One-way edge ids (GitHub issue #564) — same problem as teleports above: each per-level
  // `buildPostEditDraftEdgesFromGenerated` call numbers its own batch from 1, so a multi-floor
  // draft would otherwise collide (floor 0's id=1 and floor 1's id=1 both existing). Renumber once
  // globally, sorted by each edge's own canonical `edgeKey`, after every level is merged.
  const oneWayEntries = Object.entries(draftEdges).filter(
    (entry): entry is [string, Extract<PostEditEdge, { id: string }>] =>
      entry[1].kind === "one_way_forward" || entry[1].kind === "one_way_backward",
  );
  const oneWayIdMap = assignSequentialIds(oneWayEntries.map(([key]) => ({ key })));
  for (const [key, edge] of oneWayEntries) draftEdges[key] = { ...edge, id: formatPostEditId("oneWay", oneWayIdMap.get(key)!) };

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

/** Mirrors a `PostEditDerivedState` into the legacy field names every non-mutating consumer still
 * reads (`postEditDraftEdges`/`Teleports`/`Meta`/`SplitPoints`/`SplitPointIds`/`VerticalPassages`/
 * `Elevators`, GitHub issue #543) — field names stay since ~40 read sites still destructure them.
 * Called by `appendPostEditCommand`/`replacePostEditCommands`, the sole log-mutation points, so
 * these fields are always in sync with `postEditCommands`/`postEditBaseline`. */
export function derivedStateToLegacyFields(derived: PostEditDerivedState): {
  postEditDraftEdges: Record<string, PostEditEdge>;
  postEditDraftTeleports: PostEditTeleportEntry[];
  postEditDraftMeta: { start: PostEditEndpoint | null; finish: PostEditEndpoint | null };
  postEditDraftSplitPoints: Record<string, number[]>;
  postEditDraftSplitPointIds: Record<string, string>;
  postEditDraftVerticalPassages: PostEditVerticalPassageEntry[];
  postEditDraftElevators: import("../postEditTypes").PostEditElevatorEntry[];
} {
  return {
    postEditDraftEdges: derived.edges,
    postEditDraftTeleports: derived.teleports,
    postEditDraftMeta: derived.meta,
    postEditDraftSplitPoints: derived.splitPoints,
    postEditDraftSplitPointIds: derived.splitPointIds,
    postEditDraftVerticalPassages: derived.verticalPassages,
    postEditDraftElevators: derived.elevators,
  };
}

/** Every "next id" counter that must start past whatever `derived` already occupies (GitHub issue
 *  #564) — teleport/one-way/split-point/vertical-passage/elevator each have their own namespace,
 *  id'd 1..N within their own category by `assignSequentialIds`. Takes a `PostEditDerivedState`,
 *  not a `PostEditBaseline`, so the same computation covers both a fresh empty-log baseline
 *  (`generate()`/`resetPostEdit`, passing `baseline.derived`) and a project file's replayed
 *  baseline+log state (`loadProject`, GitHub issue #564 second follow-up) — a command log can mint
 *  ids past whatever the baseline alone occupied, so seeding only from the baseline after a load
 *  would under-count and risk a fresh id colliding with one the log already used. Shared by
 *  `generate()` (`generateConfigBuilder.ts`) and `resetPostEdit` (`postEditSlice.ts`) — both build a
 *  fresh baseline and must seed these identically; the two used to duplicate this computation, and
 *  `generate()`'s own copy drifted out of sync (one-way/split-point never seeded at all,
 *  vertical-passage/elevator hardcoded back to `1` instead of reading the baseline), silently
 *  colliding a freshly baseline-seeded id with the next user-created entity's id. */
export function nextPostEditIdCounters(derived: PostEditDerivedState): {
  _nextPostEditTeleportId: number;
  _nextPostEditOneWayId: number;
  _nextPostEditSplitPointId: number;
  _nextPostEditVerticalPassageId: number;
  _nextPostEditElevatorId: number;
} {
  const oneWayIds = Object.values(derived.edges)
    .filter((e): e is Extract<PostEditEdge, { id: string }> => e.kind === "one_way_forward" || e.kind === "one_way_backward")
    .map((e) => parsePostEditIdNumber("oneWay", e.id));
  const splitPointIdValues = Object.values(derived.splitPointIds).map((id) => parsePostEditIdNumber("splitPoint", id));
  const verticalPassageIds = derived.verticalPassages.map((p) => parsePostEditIdNumber("verticalPassage", p.id));
  const elevatorIds = derived.elevators.map((e) => parsePostEditIdNumber("elevator", e.id));
  return {
    _nextPostEditTeleportId: derived.teleports.length + 1,
    _nextPostEditOneWayId: oneWayIds.length > 0 ? Math.max(...oneWayIds) + 1 : 1,
    _nextPostEditSplitPointId: splitPointIdValues.length > 0 ? Math.max(...splitPointIdValues) + 1 : 1,
    _nextPostEditVerticalPassageId: verticalPassageIds.length > 0 ? Math.max(...verticalPassageIds) + 1 : 1,
    _nextPostEditElevatorId: elevatorIds.length > 0 ? Math.max(...elevatorIds) + 1 : 1,
  };
}

/** The only entry point that appends a single command to the log incrementally (GitHub issue #543
 * plan section 6) — calls `applyPostEditCommand` directly against the current derived state rather
 * than a full `replayPostEditCommands` (parity between the two is covered by
 * `postEditReplay.test.ts`). Returns `false` (leaving state untouched) if the command didn't apply
 * — callers must not have advanced any id counter before this returns `true`, since UX guards in
 * the action already reject almost every invalid case before a command is even built. Bumps
 * `_postEditRequestId` on any successful mutation (not just `confirmPostEdit`), closing the
 * async-staleness race the plan calls out. */
export function appendPostEditCommand(
  get: () => MazeStore,
  set: (partial: Partial<MazeStore> | ((state: MazeStore) => Partial<MazeStore>)) => void,
  command: PostEditCommand,
): boolean {
  const state = get();
  const { postEditBaseline, postEditCommands, postEditDerived } = state;
  if (postEditBaseline === null || postEditDerived === null) return false;
  const result = applyPostEditCommand(postEditBaseline.context, postEditDerived, command);
  if (!result.applied) return false;
  const appended = [...postEditCommands, command];
  // `postEditAutoCompact` (GitHub issue #548 follow-up): compact right here, in the same `set`, so
  // an appended command that immediately becomes stale (e.g. a second direction flip cancelling the
  // first) never renders even for one frame. `compactPostEditCommands` re-derives its own state from
  // `postEditBaseline`, independent of `result.state` above, so a compaction pass is used verbatim
  // when it changes anything, rather than trying to patch `result.state` incrementally.
  const { finalCommands, finalDerived } = state.postEditAutoCompact
    ? finalizeAutoCompact(postEditBaseline, appended, result.state)
    : { finalCommands: appended, finalDerived: result.state };
  set((state) => ({
    postEditCommands: finalCommands,
    postEditDerived: finalDerived,
    ...derivedStateToLegacyFields(finalDerived),
    postEditDirty: true,
    _postEditRequestId: state._postEditRequestId + 1,
  }));
  return true;
}

/** The only entry point that replaces the whole log (reset / point-reset / load, GitHub issue #543
 * plan section 6) — always a full `replayPostEditCommands` from `postEditBaseline`, since the new
 * list isn't a plain append to the old one. `dirty` is an explicit parameter per the plan's dirty
 * table (never inferred here) — callers state their own intent. */
export function replacePostEditCommands(
  get: () => MazeStore,
  set: (partial: Partial<MazeStore> | ((state: MazeStore) => Partial<MazeStore>)) => void,
  commands: PostEditCommand[],
  dirty: boolean,
): void {
  const state = get();
  const { postEditBaseline } = state;
  if (postEditBaseline === null) return;
  const derived = replayPostEditCommands(postEditBaseline, commands);
  // `postEditAutoCompact` (GitHub issue #548 follow-up) — same as `appendPostEditCommand` above.
  // Compacting an already-compacted log is a no-op (`compactPostEditCommands` returns the same
  // array reference), so this is safe even when `replacePostEditCommands` is itself called FROM
  // `compactPostEditLog`'s own manual-compaction action — no infinite recursion, just one redundant
  // (cheap) pass that immediately bails out.
  const { finalCommands, finalDerived } = state.postEditAutoCompact
    ? finalizeAutoCompact(postEditBaseline, commands, derived)
    : { finalCommands: commands, finalDerived: derived };
  set((state) => ({
    postEditCommands: finalCommands,
    postEditDerived: finalDerived,
    ...derivedStateToLegacyFields(finalDerived),
    postEditDirty: dirty,
    _postEditRequestId: state._postEditRequestId + 1,
  }));
}

/** Shared `postEditAutoCompact` step for `appendPostEditCommand`/`replacePostEditCommands` (GitHub
 * issue #548 follow-up) — compacts `commands` against `baseline` and, only if compaction actually
 * dropped/rewrote anything, re-derives state from the compacted log; otherwise reuses `fallbackDerived`
 * (the caller's own already-computed derived state) unchanged, avoiding a redundant replay pass on
 * the (overwhelmingly common) case where nothing was stale yet. */
function finalizeAutoCompact(
  baseline: PostEditBaseline,
  commands: PostEditCommand[],
  fallbackDerived: PostEditDerivedState,
): { finalCommands: PostEditCommand[]; finalDerived: PostEditDerivedState } {
  const compacted = compactPostEditCommands(baseline, commands);
  if (compacted === commands) return { finalCommands: commands, finalDerived: fallbackDerived };
  return { finalCommands: compacted, finalDerived: replayPostEditCommands(baseline, compacted) };
}

/** Builds the new `PostEditVerticalPassageEntry` for a single-click placement (GitHub issue #341,
 * mirrors `commitPresetVerticalPassage` in `presetConnectionsSlice.ts`) — `origin` is always
 * `from`; `direction` ("up"/"down", already resolved as available by
 * `startPostEditVerticalPassagePlacement`/the dialog) picks `to`'s floor by resolving that floor's
 * own original node at `origin`'s `(x, y)`. */
export function commitPostEditVerticalPassage(
  get: () => MazeStore,
  set: (partial: Partial<MazeStore> | ((state: MazeStore) => Partial<MazeStore>)) => void,
  origin: PostEditEndpoint,
  tool: "vertical_passage_one_way" | "vertical_passage_two_way",
  direction: "up" | "down",
): void {
  if (origin.kind !== "node") return;
  const state = get();
  const originNode = state.nodes.find((n) => n.id === origin.id);
  if (!originNode) return;
  const originLevel = originNode.level ?? 0;
  const toLevel = direction === "up" ? originLevel + 1 : originLevel - 1;
  const point: [number, number] = [originNode.x, originNode.y];
  // A split `to` point resolves to whichever node the user last picked there (GitHub issue #546
  // fifth follow-up), not always its original node — same `postEditActiveSplitNode` map the edge
  // tools already read (`PostEditController.resolveActiveEndpointAt`), so a placement whose
  // destination cell was already disambiguated (by an earlier edge/teleport click, or a previous
  // placement into the same split point) lands on the correct node instead of silently defaulting.
  const toNodeIds = state.nodes.filter((n) => n.x === point[0] && n.y === point[1] && (n.level ?? 0) === toLevel).map((n) => n.id);
  const toNodeId = resolveActiveNodeIdAt(point, toNodeIds, state.postEditActiveSplitNode, toLevel === 0 ? undefined : toLevel);
  if (toNodeId === undefined) return;
  const id = formatPostEditId("verticalPassage", state._nextPostEditVerticalPassageId);
  const applied = appendPostEditCommand(get, set, {
    kind: "addVerticalPassage", id, from: origin, to: nodeEndpoint(toNodeId),
    direction: tool === "vertical_passage_two_way" ? "two_way" : "forward",
  });
  if (applied) {
    set((state) => ({
      _nextPostEditVerticalPassageId: state._nextPostEditVerticalPassageId + 1,
      postEditVerticalPassagePending: null,
    }));
  }
  if (get().postEditAutoConfirm) {
    void get().confirmPostEdit();
  }
}
