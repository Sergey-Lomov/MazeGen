/** Deduplicated set of every node id an `[from, to]` edge list touches — shared by
 *  `IssueHighlightOverlay` (Analytics' issue-highlight) and `DebugRefHighlightOverlay` (debug
 *  tree narration) so both draw the same from/to endpoint markers for a "cycle"-shaped highlight
 *  without duplicating the reduction. Generic over the id type since the two callers key nodes
 *  differently (`number` vs `bigint`). */
export function touchedNodeIds<TId>(edges: [TId, TId][]): TId[] {
  const ids = new Set<TId>();
  for (const [from, to] of edges) {
    ids.add(from);
    ids.add(to);
  }
  return [...ids];
}
