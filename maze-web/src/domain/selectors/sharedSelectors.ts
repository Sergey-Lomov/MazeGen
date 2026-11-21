import type { NodeDto } from "../../wasm/types";

export function buildCellSet(cells: [number, number][]): Set<string> {
  return new Set(cells.map(([x, y]) => `${x},${y}`));
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
