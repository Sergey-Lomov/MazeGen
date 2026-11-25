/** The nav edges a highlighted hop list fully covers: every consecutive `path` pair of the nav edge
 *  is one of the `[from, to]` hops. `IssueHighlightOverlay` draws exactly these, as continuous
 *  contours with dots at their end (nav) nodes. */
export function fullyHighlightedNavEdges<T extends { path: number[] }>(navEdges: T[], hops: [number, number][]): T[] {
  const hopKeys = new Set(hops.map(([from, to]) => `${from},${to}`));
  return navEdges.filter((e) => e.path.slice(1).every((id, i) => hopKeys.has(`${e.path[i]},${id}`)));
}

/** Deduplicated set of every node id an `[from, to]` edge list touches — used by
 *  `DebugRefHighlightOverlay` (debug tree narration) for the from/to endpoint markers of a
 *  "cycle"-shaped highlight. Generic over the id type (`number` vs `bigint`). */
export function touchedNodeIds<TId>(edges: [TId, TId][]): TId[] {
  const ids = new Set<TId>();
  for (const [from, to] of edges) {
    ids.add(from);
    ids.add(to);
  }
  return [...ids];
}
