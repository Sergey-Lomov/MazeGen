import type { NodeDto, PostEditEndpointWasmDto } from "../../wasm/types";
import type { PostEditEndpoint } from "../../pixi/postEditEndpoint";
import { nodeEndpoint } from "../../pixi/postEditEndpoint";
import type { MazeStore, PostEditVerticalPassageEntry } from "../storeTypes";

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
