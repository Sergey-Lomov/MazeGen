import type { NodeDto, EdgeDto, PostEditEndpointWasmDto } from "../../wasm/types";
import type { PostEditEndpoint } from "../../pixi/postEditEndpoint";
import { nodeEndpoint, splitEndpoint, resolverForNodeId } from "../../pixi/postEditEndpoint";
import { deriveSplitPointsFromNodes } from "../../pixi/splitPointsCore";
import { buildPostEditDraftEdgesFromGenerated, extractPostEditTeleports } from "../../pixi/postEditUtils";
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
  const toNode = state.nodes.find((n) => n.x === originNode.x && n.y === originNode.y && (n.level ?? 0) === toLevel);
  if (!toNode) return;
  const entry: PostEditVerticalPassageEntry = {
    id: state._nextPostEditVerticalPassageId,
    from: origin,
    to: nodeEndpoint(toNode.id),
    direction: tool === "vertical_passage_two_way" ? "two_way" : "forward",
  };
  set((state) => ({
    postEditDraftVerticalPassages: [...state.postEditDraftVerticalPassages, entry],
    _nextPostEditVerticalPassageId: state._nextPostEditVerticalPassageId + 1,
    postEditVerticalPassagePending: null,
    postEditDirty: true,
  }));
  if (get().postEditAutoConfirm) {
    void get().confirmPostEdit();
  }
}
