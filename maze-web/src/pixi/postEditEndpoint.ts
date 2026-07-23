/** One endpoint of a post-edit edge/teleport/start/finish reference (GitHub issue #221). A tile's
 * point can resolve to more than one graph node ("split point") — a `node` endpoint is a plain
 * already-resolved `NodeId`; a `split` endpoint addresses one of a split point's extra nodes by
 * its stable per-point `slotId`, since the JS side never predicts the real `NodeId` a not-yet-
 * confirmed split node will get (see `postEditSlice.ts`'s `addSplitNode`).
 *
 * `NodeId` is not a stable cross-confirm identifier for a split node: `compute_analytics` rebuilds
 * the graph from scratch on every call, and `NodeId` is `IdGenerator`'s sequential counter — its
 * value depends on how many other nodes were created earlier in that specific call. Any raw
 * `NodeId` kept across two `confirmPostEdit` calls can silently point at the wrong node once the
 * set of split points changes (see the plan for GitHub issue #221, "Ключевое архитектурное
 * решение"). That's why `PostEditEdge`/`PostEditTeleportEntry`/`PostEditMeta`'s `from`/`to`/
 * `start`/`finish` are all `PostEditEndpoint`, not a bare `number` — the point/slotId reference
 * survives across confirms; only the resolved id, looked up fresh each time, doesn't need to. */
export type PostEditEndpoint =
  | { kind: "node"; id: number }
  | { kind: "split"; point: [number, number]; slotId: number };

export function nodeEndpoint(id: number): PostEditEndpoint {
  return { kind: "node", id };
}

export function splitEndpoint(point: [number, number], slotId: number): PostEditEndpoint {
  return { kind: "split", point, slotId };
}

/** Structural equality (no resolution) — true whether or not either endpoint currently resolves
 * to a real node. Used to find/remove references to a specific split node regardless of confirm
 * state (e.g. `removeSplitNode`'s edge/teleport/start/finish cleanup). */
export function endpointsEqual(a: PostEditEndpoint, b: PostEditEndpoint): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "node") return a.id === (b as { kind: "node"; id: number }).id;
  const bs = b as { kind: "split"; point: [number, number]; slotId: number };
  return a.point[0] === bs.point[0] && a.point[1] === bs.point[1] && a.slotId === bs.slotId;
}

/** Stable string key for one endpoint: "n42" for a node, "s3,5:7" for a split (point "3,5",
 * slotId 7). The "n"/"s" prefix keeps the two variants' key spaces disjoint. */
export function endpointKey(ep: PostEditEndpoint): string {
  return ep.kind === "node" ? `n${ep.id}` : `s${ep.point[0]},${ep.point[1]}:${ep.slotId}`;
}

/** Builds a Record key for an edge between two endpoints — replaces every hand-built
 * `${from}-${to}` template literal that assumed `from`/`to` were bare numbers. */
export function edgeKey(from: PostEditEndpoint, to: PostEditEndpoint): string {
  return `${endpointKey(from)}-${endpointKey(to)}`;
}

/** True if `ep` is a plain node endpoint equal to `id` — replaces ad-hoc `x === nodeId` checks
 * that assumed a bare number. */
export function endpointIsNode(ep: PostEditEndpoint, id: number): boolean {
  return ep.kind === "node" && ep.id === id;
}

/** Resolves an endpoint to a real `NodeId`, if possible. A `node` endpoint resolves trivially;
 * a `split` endpoint resolves via `resolveSplit`, built by the caller from the latest confirmed
 * snapshot (see `PostEditController`'s `buildNodeMap`). Returns `undefined` if it doesn't resolve
 * (yet) — see the module doc comment on when that happens and how each caller handles it:
 * - Canvas/renderer (`postEditTeleportsToDto`/`postEditEdgesToDto`): silently drops any entry with
 *   an unresolved endpoint from the resulting `EdgeDto[]` — the same "nothing to draw yet" pattern
 *   already used when `nodeById` has no match today.
 * - WASM call (`confirmPostEdit`): edges/teleports never need to resolve on the JS side at all —
 *   `split_points` is sent alongside edges in the same call, so by the time WASM resolves a
 *   `Split` endpoint, the node has already been created by that same call. `start`/`finish` are
 *   the one exception (`ComputeAnalyticsConfig.start`/`.finish` stay a plain `Option<u32>` on the
 *   wire) — an unresolved `start`/`finish` endpoint is sent as `null` for that call.
 * - "Manage split nodes" dialog: shows the added node right away (already in
 *   `postEditDraftSplitPoints`/`postEditActiveSplitNode`, which need no resolution), but its list
 *   of "current links" is empty until the first confirm — expected, not an error. */
export function resolveEndpoint(
  ep: PostEditEndpoint,
  resolveSplit: (point: [number, number], slotId: number) => number | undefined,
): number | undefined {
  return ep.kind === "node" ? ep.id : resolveSplit(ep.point, ep.slotId);
}

/** Builds the `(point, slotId) -> NodeId` resolver `resolveEndpoint` needs for `split` endpoints,
 * from the latest confirmed snapshot's node list (grouped by point, `nodeMap`, e.g.
 * `PostEditController`'s per-cell id list) and the current `postEditDraftSplitPoints` (slotId
 * list per point).
 *
 * Relies on `nodeMap`'s per-point node order matching `Field::nodes_at`'s contract — the point's
 * original node first, then each confirmed extra node in creation order (see
 * `maze-wasm/src/analytics.rs`'s `nodes: Vec<NodeDto>` construction) — so slot `k` in
 * `postEditDraftSplitPoints`'s *sorted* slotId list lines up with `nodeMap`'s (k+1)-th entry for
 * that point (index 0 is always the original node). Returns `undefined` for a slotId that either
 * isn't in the draft list, or hasn't been confirmed into the snapshot yet. */
export function buildSplitNodeResolver(
  nodeMap: ReadonlyMap<string, number[]>,
  splitPoints: Readonly<Record<string, number[]>>,
): (point: [number, number], slotId: number) => number | undefined {
  return (point, slotId) => {
    const key = `${point[0]},${point[1]}`;
    const ids = nodeMap.get(key);
    const slots = splitPoints[key];
    if (ids === undefined || slots === undefined) return undefined;
    const sortedSlots = [...slots].sort((a, b) => a - b);
    const slotIndex = sortedSlots.indexOf(slotId);
    if (slotIndex === -1) return undefined;
    return ids[slotIndex + 1];
  };
}
