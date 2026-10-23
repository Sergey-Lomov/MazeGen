import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import type { TeleportGroupOverride } from "../renderers/types";
import { buildTeleportEdges, buildTeleportFloorInputs, selectFloorScopedMaze } from "./mazeSelectors";
import { buildTeleportGroups, coordKey, type TeleportGroup } from "./teleportGroups";

/** Merges per-floor teleport groups into project-wide groups (GitHub issue #727 follow-up). A
 *  cross-floor teleport is built on each floor it touches, where it lands in that floor's own
 *  coordinate-merged group — so the same teleport (same `edgeKey`) appears in several per-floor
 *  groups. Groups sharing any edge key are unioned into one, keyed by the sorted union of their edge
 *  keys; a group untouched by any cross-floor teleport keeps its per-floor key unchanged. */
export function mergeTeleportGroupsAcrossFloors(perFloor: TeleportGroup[][]): TeleportGroup[] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(k, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const all = perFloor.flat();
  for (const g of all) {
    for (const k of g.edgeKeys) find(k);
    for (let i = 1; i < g.edgeKeys.length; i++) union(g.edgeKeys[0], g.edgeKeys[i]);
  }

  const byRoot = new Map<string, { edgeKeys: Set<string>; points: Map<string, [number, number]>; links: Map<string, TeleportGroup["links"][number]> }>();
  for (const g of all) {
    if (g.edgeKeys.length === 0) continue;
    const root = find(g.edgeKeys[0]);
    let entry = byRoot.get(root);
    if (!entry) {
      entry = { edgeKeys: new Set(), points: new Map(), links: new Map() };
      byRoot.set(root, entry);
    }
    for (const k of g.edgeKeys) entry.edgeKeys.add(k);
    for (const [px, py] of g.points) entry.points.set(coordKey(px, py), [px, py]);
    // A link's edge key is its sorted node-id pair (`teleportEdgeKey` with node ids).
    for (const link of g.links) {
      const lk = link.from < link.to ? `${link.from}-${link.to}` : `${link.to}-${link.from}`;
      if (!entry.links.has(lk)) entry.links.set(lk, link);
    }
  }

  const merged: TeleportGroup[] = [];
  for (const { edgeKeys, points, links } of byRoot.values()) {
    const sorted = Array.from(edgeKeys).sort();
    merged.push({
      key: sorted.join("|"),
      edgeKeys: sorted,
      points: Array.from(points.values()),
      links: sorted.flatMap((k) => links.get(k) ?? []),
    });
  }
  return merged.sort((a, b) => a.key.localeCompare(b.key));
}

/** Project-wide teleport groups: per floor exactly the way that floor's vector renderer builds
 *  its own groups (see `useTeleportGroupsAndCollisions`), then merged across floors. A merged
 *  group's `points` mix coordinates of every floor it spans (deduped by coordinate only) — the
 *  settings list reads `links`/`edgeKeys`, never `points`. */
type ProjectGroupArgs = {
  nodes: NodeDto[];
  edges: EdgeDto[];
  cfg: FieldConfig;
  floors: { id: string }[];
  avoidFieldExit: boolean;
  start: number | null;
  finish: number | null;
};

export function buildProjectTeleportGroups(args: ProjectGroupArgs): TeleportGroup[] {
  const { nodes, edges, cfg, floors, avoidFieldExit, start, finish } = args;
  const floorList = floors.length > 0 ? floors : [{ id: "" }];
  // Same `{ floorContext, spread }` the vector renderers build; only `activeFloorIndex` varies per floor.
  const { floorContext, spread } = buildTeleportFloorInputs({
    unscopedNodes: nodes,
    unscopedEdges: edges,
    floors: floorList,
    activeFloorId: floorList[0].id,
    start,
    finish,
    allowOutOfField: !avoidFieldExit,
    fieldCells: nodes.map((n): [number, number] => [n.x, n.y]),
  });
  const perFloor = floorList.map((floor, activeFloorIndex) => {
    const scoped = selectFloorScopedMaze(nodes, edges, floors, floor.id, start, finish);
    const nodeById = new Map(scoped.nodes.map((n) => [n.id, n]));
    const teleportEdges = buildTeleportEdges(nodeById, scoped.edges, cfg, { ...floorContext, activeFloorIndex }, spread);
    return buildTeleportGroups(teleportEdges);
  });
  return mergeTeleportGroupsAcrossFloors(perFloor);
}

/** Re-keys project-wide group overrides onto one floor's own groups: the renderers look overrides
 *  up by their per-floor group key, while the settings panel stores them under the project-wide
 *  (cross-floor merged) key. Returns `overrides` itself when nothing needs re-keying. */
export function resolveFloorGroupOverrides(
  floorGroups: TeleportGroup[],
  projectGroups: TeleportGroup[],
  overrides: Record<string, TeleportGroupOverride>,
): Record<string, TeleportGroupOverride> {
  const projectKeyByEdge = new Map<string, string>();
  for (const pg of projectGroups) for (const k of pg.edgeKeys) projectKeyByEdge.set(k, pg.key);
  let out: Record<string, TeleportGroupOverride> | null = null;
  for (const g of floorGroups) {
    const pk = projectKeyByEdge.get(g.edgeKeys[0]);
    if (pk === undefined || pk === g.key) continue;
    out ??= { ...overrides };
    if (overrides[pk]) out[g.key] = overrides[pk];
    else delete out[g.key];
  }
  return out ?? overrides;
}

let lastArgs: ProjectGroupArgs | null = null;
let lastGroups: TeleportGroup[] = [];

/** Renderer entry point: the stored project-wide overrides re-keyed onto `floorGroups` (this
 *  floor's own groups). Skips the all-floor rebuild when there is nothing to re-key, and reuses the
 *  last project-wide result while its inputs are reference-equal (renders repeat with unchanged data). */
export function resolveRendererGroupOverrides(
  floorGroups: TeleportGroup[],
  overrides: Record<string, TeleportGroupOverride>,
  args: ProjectGroupArgs,
): Record<string, TeleportGroupOverride> {
  if (Object.keys(overrides).length === 0) return overrides;
  const same = lastArgs !== null && (Object.keys(args) as (keyof ProjectGroupArgs)[]).every((k) => lastArgs![k] === args[k]);
  if (!same) {
    lastGroups = buildProjectTeleportGroups(args);
    lastArgs = args;
  }
  return resolveFloorGroupOverrides(floorGroups, lastGroups, overrides);
}
