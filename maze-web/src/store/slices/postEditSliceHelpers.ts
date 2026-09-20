import type { NodeDto, EdgeDto, PostEditEndpointWasmDto } from "../../wasm/types";
import type { PostEditEndpoint } from "../../pixi/postEditEndpoint";
import { nodeEndpoint, splitEndpoint, resolverForNodeId, buildSplitNodeResolver } from "../../pixi/postEditEndpoint";
import { deriveSplitPointsFromNodes } from "../../pixi/splitPointsCore";
import { buildPostEditDraftEdgesFromGenerated, extractPostEditTeleports, pruneRemovedSplitNodes } from "../../pixi/postEditUtils";
import type {
  PostEditBaseline, PostEditDerivedState, PostEditReplayContext,
} from "../../pixi/postEditReplay";
import { applyPostEditCommand, replayPostEditCommands } from "../../pixi/postEditReplay";
import type { PostEditCommand } from "../postEditCommandTypes";
import type { MazeStore, PostEditVerticalPassageEntry } from "../storeTypes";
import type { PostEditEdge, PostEditTeleportEntry } from "../postEditTypes";

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
  draftTeleports = draftTeleports.map((t, i) => ({ ...t, id: i + 1 }));

  return { draftEdges, draftTeleports, splitPoints, endpointFor };
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
  const { draftEdges, draftTeleports, splitPoints, endpointFor } = buildMultiFloorPostEditDraft(nodes, edges);
  const derived: PostEditDerivedState = {
    edges: draftEdges,
    teleports: draftTeleports,
    meta: {
      start: generatedStart !== null ? endpointFor(generatedStart) : null,
      finish: generatedFinish !== null ? endpointFor(generatedFinish) : null,
    },
    splitPoints,
    verticalPassages: [],
    elevators: [],
    suppressedVerticalPassagePairs: new Set(),
    suppressedElevatorPairs: new Set(),
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
 * reads (`postEditDraftEdges`/`Teleports`/`Meta`/`SplitPoints`/`VerticalPassages`/`Elevators`/
 * `Suppressed*Pairs`, GitHub issue #543) — the suppression sets are now log-derived facts
 * (`suppressGenerationPair` command) rather than an independently-mutated store field, but the
 * field names stay since ~40 read sites still destructure them. Called by
 * `appendPostEditCommand`/`replacePostEditCommands`, the sole log-mutation points, so these fields
 * are always in sync with `postEditCommands`/`postEditBaseline`. */
export function derivedStateToLegacyFields(derived: PostEditDerivedState): {
  postEditDraftEdges: Record<string, PostEditEdge>;
  postEditDraftTeleports: PostEditTeleportEntry[];
  postEditDraftMeta: { start: PostEditEndpoint | null; finish: PostEditEndpoint | null };
  postEditDraftSplitPoints: Record<string, number[]>;
  postEditDraftVerticalPassages: PostEditVerticalPassageEntry[];
  postEditDraftElevators: import("../postEditTypes").PostEditElevatorEntry[];
  postEditSuppressedElevatorPairs: ReadonlySet<string>;
  postEditSuppressedVerticalPassagePairs: ReadonlySet<string>;
} {
  return {
    postEditDraftEdges: derived.edges,
    postEditDraftTeleports: derived.teleports,
    postEditDraftMeta: derived.meta,
    postEditDraftSplitPoints: derived.splitPoints,
    postEditDraftVerticalPassages: derived.verticalPassages,
    postEditDraftElevators: derived.elevators,
    postEditSuppressedElevatorPairs: derived.suppressedElevatorPairs,
    postEditSuppressedVerticalPassagePairs: derived.suppressedVerticalPassagePairs,
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
  set((state) => ({
    postEditCommands: [...postEditCommands, command],
    postEditDerived: result.state,
    ...derivedStateToLegacyFields(result.state),
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
  const { postEditBaseline } = get();
  if (postEditBaseline === null) return;
  const derived = replayPostEditCommands(postEditBaseline, commands);
  set((state) => ({
    postEditCommands: commands,
    postEditDerived: derived,
    ...derivedStateToLegacyFields(derived),
    postEditDirty: dirty,
    _postEditRequestId: state._postEditRequestId + 1,
  }));
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
  const id = state._nextPostEditVerticalPassageId;
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
