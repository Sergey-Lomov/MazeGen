import type { TeleportEdge } from "../renderers/types";

/** Rounds a world-space coordinate into a stable string key — mirrors `TeleportRenderer`'s
 *  pre-#293 `coordKey`, kept as its own copy here since `teleportGroups.ts` must not import from
 *  the renderer layer (selectors stay renderer-agnostic). Exported so other selector-layer callers
 *  needing the exact same point identity (e.g. `exportWarnings.ts`) don't hand-roll their own
 *  rounding at a different precision. */
export function coordKey(x: number, y: number): string {
  return `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
}

/** Stable per-edge identity for a `TeleportEdge` produced by `buildTeleportEdges` — the sorted pair
 *  of its endpoint node ids (order-independent, since `buildTeleportEdges` already collapses a
 *  two-way teleport's forward/backward `EdgeDto`s into one `TeleportEdge`). Falls back to a
 *  position-based key when `fromNode`/`toNode` are absent (non-`VectorByWallsRenderer` callers
 *  never build groups, but the fallback keeps this total). */
export function teleportEdgeKey(edge: TeleportEdge): string {
  if (edge.fromNode !== undefined && edge.toNode !== undefined) {
    return edge.fromNode < edge.toNode ? `${edge.fromNode}-${edge.toNode}` : `${edge.toNode}-${edge.fromNode}`;
  }
  return edge.from[0] < edge.to[0] || (edge.from[0] === edge.to[0] && edge.from[1] < edge.to[1])
    ? `${coordKey(edge.from[0], edge.from[1])}~${coordKey(edge.to[0], edge.to[1])}`
    : `${coordKey(edge.to[0], edge.to[1])}~${coordKey(edge.from[0], edge.from[1])}`;
}

/** One "connection" group for the `"grouped"` teleport pattern (GitHub issue #293) — a teleport
 *  pair's two endpoints, merged with any other pair sharing an endpoint coordinate (see module
 *  doc). `key` is the group's stable identity (sorted, joined member edge keys) used to look up its
 *  `TeleportGroupOverride` in `VectorByWallsSettings.teleportGroupOverrides` and to key React list
 *  items in the settings panel. `points` are the group's unique world-space marker positions (one
 *  shape drawn per point, not per edge — GitHub issue #293's "one shape on each unique point of the
 *  connection" answer). */
export type TeleportGroup = {
  key: string;
  edgeKeys: string[];
  points: [number, number][];
  /** The group's teleports as node-id pairs (only edges carrying both `fromNode` and `toNode`),
   *  in the same order as `edgeKeys`. `from` -> `to` is the passage direction when `oneWay`; a
   *  two-way teleport's order is arbitrary. Drives the settings panel's per-group teleport list. */
  links: TeleportGroupLink[];
};

export type TeleportGroupLink = { from: number; to: number; oneWay: boolean };

/** Merge-mode-off grouping (GitHub issue #868): every teleport is its own group, even when its
 *  endpoints coincide with another teleport's. Edges sharing an edge key (a teleport seen twice) fold
 *  into one group. */
function buildUnmergedTeleportGroups(edges: TeleportEdge[]): TeleportGroup[] {
  const byKey = new Map<string, TeleportGroup>();
  for (const e of edges) {
    const edgeKey = teleportEdgeKey(e);
    let group = byKey.get(edgeKey);
    if (!group) {
      group = { key: edgeKey, edgeKeys: [edgeKey], points: [], links: [] };
      byKey.set(edgeKey, group);
      if (e.fromNode !== undefined && e.toNode !== undefined) {
        group.links.push({ from: e.fromNode, to: e.toNode, oneWay: e.oneWay });
      }
    }
    for (const p of [e.from, e.to]) {
      if (!group.points.some(([x, y]) => coordKey(x, y) === coordKey(p[0], p[1]))) group.points.push(p);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

/** Merges `TeleportEdge`s into `TeleportGroup`s wherever an endpoint coordinate coincides across
 *  different teleport pairs (GitHub issue #293's "grouped" pattern) — implemented as union-find
 *  over coordinate keys, unioning both a group's own from/to on every edge (so a pair's two ends
 *  always start in the same group even before any merge) and any two edges that share a coordinate.
 *  Every edge participates in grouping regardless of whether `fromNode`/`toNode` are set — the
 *  union-find itself only needs coordinates, which are always present. `fromNode`/`toNode` only
 *  matter for `teleportEdgeKey`'s node-id identity (stable across a merge chain the way a
 *  position-based fallback key can't fully guarantee); callers that key off `TeleportGroup.key` for
 *  persisted customization (`VectorByWallsRenderer`) always supply node ids, so this only affects
 *  the fallback key's stability, not whether an edge without them gets grouped/drawn at all — an
 *  edge previously dropped here entirely (e.g. `PresetConnectionsRenderer`'s preset teleport edges,
 *  which have no node ids yet at that stage) used to vanish from every consumer of this function,
 *  including `TeleportRenderer`'s per-group draw-order interleave, which relies on
 *  `buildTeleportGroups` unconditionally now (GitHub issue #293 follow-up). */
export function buildTeleportGroups(edges: TeleportEdge[], merge = true): TeleportGroup[] {
  if (!merge) return buildUnmergedTeleportGroups(edges);
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    if (!parent.has(k)) parent.set(k, k);
    parent.set(k, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const e of edges) {
    const fromKey = coordKey(e.from[0], e.from[1]);
    const toKey = coordKey(e.to[0], e.to[1]);
    find(fromKey);
    find(toKey);
    union(fromKey, toKey);
  }

  const byRoot = new Map<string, { edgeKeys: Set<string>; points: Map<string, [number, number]>; links: Map<string, TeleportGroupLink> }>();
  for (const e of edges) {
    const root = find(coordKey(e.from[0], e.from[1]));
    let entry = byRoot.get(root);
    if (!entry) {
      entry = { edgeKeys: new Set(), points: new Map(), links: new Map() };
      byRoot.set(root, entry);
    }
    const edgeKey = teleportEdgeKey(e);
    entry.edgeKeys.add(edgeKey);
    if (e.fromNode !== undefined && e.toNode !== undefined && !entry.links.has(edgeKey)) {
      entry.links.set(edgeKey, { from: e.fromNode, to: e.toNode, oneWay: e.oneWay });
    }
    entry.points.set(coordKey(e.from[0], e.from[1]), e.from);
    entry.points.set(coordKey(e.to[0], e.to[1]), e.to);
  }

  const groups: TeleportGroup[] = [];
  for (const { edgeKeys, points, links } of byRoot.values()) {
    const sortedEdgeKeys = Array.from(edgeKeys).sort();
    groups.push({
      key: sortedEdgeKeys.join("|"),
      edgeKeys: sortedEdgeKeys,
      points: Array.from(points.values()),
      links: sortedEdgeKeys.flatMap((k) => links.get(k) ?? []),
    });
  }
  groups.sort((a, b) => a.key.localeCompare(b.key));
  return groups;
}
