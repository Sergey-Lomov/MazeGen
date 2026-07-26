/** The point+slot half of `PostEditEndpoint` (below), standalone — identifies one of a split
 * point's extra nodes by its stable per-point `slotId`. Always describes *some* added slot, never
 * "a point with no slot" (that's `PostEditEndpoint`'s separate `node` variant, or `PresetEndpoint`
 * with `slotId: undefined` — see `presetEndpoint.ts`). Shared between post-edit and preset-stage
 * split-node addressing so both sides compare/key slots identically. */
export interface SplitRef {
  point: [number, number];
  slotId: number;
}

export function splitRefsEqual(a: SplitRef, b: SplitRef): boolean {
  return a.point[0] === b.point[0] && a.point[1] === b.point[1] && a.slotId === b.slotId;
}

export function splitRefKey(ref: SplitRef): string {
  return `${ref.point[0]},${ref.point[1]}:${ref.slotId}`;
}

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
  | ({ kind: "split" } & SplitRef);

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
  return splitRefsEqual(a, b as SplitRef);
}

/** Stable string key for one endpoint: "n42" for a node, "s3,5:7" for a split (point "3,5",
 * slotId 7). The "n"/"s" prefix keeps the two variants' key spaces disjoint. */
export function endpointKey(ep: PostEditEndpoint): string {
  return ep.kind === "node" ? `n${ep.id}` : `s${splitRefKey(ep)}`;
}

/** Builds a Record key for an edge between two endpoints — replaces every hand-built
 * `${from}-${to}` template literal that assumed `from`/`to` were bare numbers. */
export function edgeKey(from: PostEditEndpoint, to: PostEditEndpoint): string {
  return `${endpointKey(from)}-${endpointKey(to)}`;
}

/** Resolves which node of a split `neighborPoint` genuinely connects back toward the point being
 * (re)built — used when wiring a face automatically (blueprint apply), where the correct partner
 * is whichever of the neighbor's nodes already has an edge, in `draftEdges`, toward any of that
 * point's *pre-blueprint* endpoints (`pointOldEndpoints` — the point is about to be rebuilt by its
 * own blueprint too, so its old identity, not the fresh endpoint the caller is about to write, is
 * what any pre-existing neighbor edge was recorded against), not whichever node happens to be the
 * neighbor's currently active UI slot (GitHub issue #243 — picking "the" active node here silently
 * wired a connection to the wrong node while leaving the neighbor's real connecting node's entry
 * orphaned). Falls back to the active-slot resolution when no such edge exists yet — mirrors the
 * preset-stage `resolvePresetPartnerAt` and the renderer's own `resolveOther`
 * (`buildSplitPassagesCore`). `neighborNodeIds` is every real node currently at `neighborPoint`, in
 * snapshot order (index 0 = original); `neighborSplitSlots` is that point's declared slotId list
 * (sorted order lines up with `neighborNodeIds`' extra entries, same contract as
 * `buildSplitNodeResolver`). */
export function resolvePostEditPartnerAt(
  pointOldEndpoints: PostEditEndpoint[],
  neighborPoint: [number, number],
  neighborNodeIds: number[],
  draftEdges: Readonly<Record<string, { from: PostEditEndpoint; to: PostEditEndpoint }>>,
  neighborSplitSlots: number[],
  activeMap: Readonly<Record<string, PostEditEndpoint>>,
): PostEditEndpoint | null {
  if (neighborNodeIds.length === 0) return null;
  const sortedSlots = [...neighborSplitSlots].sort((a, b) => a - b);
  // Every confirmed node — including a split slot — already has a real `NodeId`, and existing
  // `postEditDraftEdges` entries are recorded against that plain `nodeEndpoint`, never a `split`
  // endpoint (that variant only ever addresses a slot not yet confirmed, see `PostEditEndpoint`'s
  // doc comment) — search/return `nodeEndpoint(id)` for every candidate so an existing edge's key
  // actually matches.
  const candidates: PostEditEndpoint[] = neighborNodeIds.map((id) => nodeEndpoint(id));

  for (const candidate of candidates) {
    for (const from of pointOldEndpoints) {
      if (draftEdges[edgeKey(from, candidate)] || draftEdges[edgeKey(candidate, from)]) return candidate;
    }
  }
  const key = `${neighborPoint[0]},${neighborPoint[1]}`;
  const active = activeMap[key];
  if (active) {
    // The active-slot fallback may itself be an unresolved `split` endpoint (a not-yet-confirmed
    // slot) — resolve it to the matching confirmed id when possible so the returned endpoint stays
    // consistent with `candidates` above; otherwise return it as-is (nothing to resolve against yet).
    if (active.kind === "node") return active;
    const slotIndex = sortedSlots.indexOf(active.slotId);
    return slotIndex >= 0 && neighborNodeIds[slotIndex + 1] !== undefined ? nodeEndpoint(neighborNodeIds[slotIndex + 1]) : active;
  }
  return candidates[0];
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

/** The inverse of `buildSplitNodeResolver`: builds a real `NodeId` -> `PostEditEndpoint` resolver.
 * A plain node whose point has no split-slot registered for it resolves to `nodeEndpoint(id)` as
 * usual; a node that IS one of a split point's extra nodes (per `pointNodeMap`'s per-point order
 * and `splitPoints`' sorted slot list — same contract as `buildSplitNodeResolver`, index 0 is
 * always the original node) resolves to `splitEndpoint(point, slotId)` instead.
 *
 * Needed because a `NodeId` a WASM `generate()` call minted for an automatic split (GitHub issue
 * #222) is only meaningful for *that* call — `compute_analytics` (driving `confirmPostEdit`)
 * rebuilds the graph from scratch on every confirm, assigning ids in its own deterministic order
 * (`tessellation.points` order, then `split_points` in sorted `(point, slot_id)` order), which
 * generally does NOT match the id an auto-split node happened to get mid-traversal. A `node`
 * endpoint pinned to that stale id would silently resolve to the wrong node (or none) on the next
 * confirm — see the GitHub issue #222 post-load-isolated-node bug. Addressing it as
 * `(point, slotId)` instead sidesteps the mismatch entirely: `compute_analytics` resolves a
 * `split` endpoint through the very same `split_points` list it was just given, so it's always
 * self-consistent regardless of what raw id the node ends up with. */
export function resolverForNodeId(
  pointNodeMap: ReadonlyMap<string, number[]>,
  splitPoints: Readonly<Record<string, number[]>>,
): (id: number) => PostEditEndpoint {
  const pointOfId = new Map<number, [string, number[]]>();
  for (const [key, ids] of pointNodeMap) {
    for (const id of ids) pointOfId.set(id, [key, ids]);
  }
  return (id) => {
    const entry = pointOfId.get(id);
    if (!entry) return nodeEndpoint(id);
    const [key, ids] = entry;
    const index = ids.indexOf(id);
    if (index <= 0) return nodeEndpoint(id);
    const slots = splitPoints[key];
    const sortedSlots = slots ? [...slots].sort((a, b) => a - b) : [];
    const slotId = sortedSlots[index - 1];
    if (slotId === undefined) return nodeEndpoint(id);
    const [xStr, yStr] = key.split(",");
    return splitEndpoint([Number(xStr), Number(yStr)], slotId);
  };
}
