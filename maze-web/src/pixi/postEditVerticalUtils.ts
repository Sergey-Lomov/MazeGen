import type { NodeDto, EdgeDto } from "../wasm/types";
import type {
  PostEditVerticalPassageEntry, PostEditVerticalPassageDirection, PostEditVerticalPassageEndpointHit,
  PostEditElevatorEntry,
} from "../store/mazeStore";
import { makeProjection } from "./tessellationProjection";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { type PostEditEndpoint, nodeEndpoint, resolveEndpoint, endpointKey, endpointsEqual } from "./postEditEndpoint";
import { TELEPORT_ENDPOINT_HIT_RADIUS } from "./postEditTeleportUtils";

/** Same hit-test as `pickPostEditTeleportEndpointAt`, for post-edit vertical passages (GitHub issue
 * #341) — mirrors `pickVerticalPassageEndpointAt` (`fieldEditUtils.ts`), adapted to node-id space:
 * only ever tests the endpoint whose resolved node lives on the active floor (`resolveNodeLevel`,
 * see `selectNodeLevelResolver`), same as `pickPostEditTeleportEndpointAt`'s own node-resolution
 * pattern. An endpoint whose node doesn't resolve (shouldn't happen — vertical passages are never
 * `split`-addressed) is skipped. */
export function pickPostEditVerticalPassageEndpointAt(
  viewportX: number,
  viewportY: number,
  cfg: TessellationConfig,
  passages: PostEditVerticalPassageEntry[],
  nodeById: Map<number, NodeDto>,
  resolveNodeLevel: (id: number) => number | undefined,
  activeLevel: number | undefined,
): PostEditVerticalPassageEndpointHit | null {
  const proj = makeProjection(cfg);
  const thresholdSq = TELEPORT_ENDPOINT_HIT_RADIUS * TELEPORT_ENDPOINT_HIT_RADIUS;
  let best: PostEditVerticalPassageEndpointHit | null = null;
  let bestDistSq = Infinity;
  for (const p of passages) {
    for (const end of ["from", "to"] as const) {
      const ep = end === "from" ? p.from : p.to;
      if (ep.kind !== "node") continue;
      if ((resolveNodeLevel(ep.id) ?? 0) !== (activeLevel ?? 0)) continue;
      const node = nodeById.get(ep.id);
      if (!node) continue;
      const { x: px, y: py } = proj.gridToScreen(node.x, node.y);
      const dx = px - viewportX;
      const dy = py - viewportY;
      const distSq = dx * dx + dy * dy;
      if (distSq < thresholdSq && distSq < bestDistSq) {
        bestDistSq = distSq;
        best = { id: p.id, end };
      }
    }
  }
  return best;
}

/** The draft vertical-passage entry connecting endpoints `a` and `b` (either order), or `undefined`.
 *  Both `startPostEditVerticalPassagePlacement`'s generation-time seed guard (GitHub issue #385) and
 *  its direction-aware create path (GitHub issue #491) need "is this pair already drafted?" — keyed
 *  by `PostEditEndpoint` equality (GitHub issue #550 ninth follow-up), not raw node ids, since either
 *  side can be a split point's numbered slot (a generation-baked passage on a split node already
 *  extracts as a `split`-kind endpoint, see `extractPostEditVerticalPassages`; user placement must
 *  match that, not silently treat every split origin as "no existing entry"). */
export function findPostEditVerticalPassageForPair(
  passages: PostEditVerticalPassageEntry[],
  a: PostEditEndpoint,
  b: PostEditEndpoint,
): PostEditVerticalPassageEntry | undefined {
  return passages.find(p =>
    (endpointsEqual(p.from, a) && endpointsEqual(p.to, b)) || (endpointsEqual(p.from, b) && endpointsEqual(p.to, a)));
}

/** Only meaningful for the `vertical_passage_one_way` tool — mirrors `cycleVerticalPassageDirection`. */
export function cyclePostEditVerticalPassageDirection(
  passages: PostEditVerticalPassageEntry[],
  id: string,
): PostEditVerticalPassageEntry[] {
  return passages.map(p => {
    if (p.id !== id || p.direction === "two_way") return p;
    return { ...p, direction: p.direction === "forward" ? "backward" : "forward" };
  });
}

export function removePostEditVerticalPassage(passages: PostEditVerticalPassageEntry[], id: string): PostEditVerticalPassageEntry[] {
  return passages.filter(p => p.id !== id);
}

export function movePostEditVerticalPassageEndpoint(
  passages: PostEditVerticalPassageEntry[],
  hit: PostEditVerticalPassageEndpointHit,
  endpoint: PostEditEndpoint,
): PostEditVerticalPassageEntry[] {
  return passages.map(p => {
    if (p.id !== hit.id) return p;
    return { ...p, [hit.end]: endpoint };
  });
}

export function removePostEditElevator(elevators: PostEditElevatorEntry[], id: string): PostEditElevatorEntry[] {
  return elevators.filter(e => e.id !== id);
}

/** Every node id reachable from any of `startIds` via `elevator`-kind edges in `edges`, `startIds`
 *  themselves included — mirrors `maze_core::graph::Graph::elevator_groups`'s connected-component
 *  definition (GitHub issue #346): a group is a graph connected component, never nodes sharing the
 *  same x-y point (two elevators, e.g. floors 1-3 and floors 4-6, can occupy the same point without
 *  being connected). BFS, not a single-hop lookup, so it stays correct even if a caller's `edges`
 *  don't form a full mesh. Takes every start at once (rather than being called per-id) so a
 *  multi-node point only builds the adjacency map once. */
export function elevatorComponent(edges: { from: number; to: number; kind: string }[], startIds: Iterable<number>): Set<number> {
  const neighbors = new Map<number, Set<number>>();
  const addNeighbor = (from: number, to: number) => {
    let set = neighbors.get(from);
    if (!set) {
      set = new Set();
      neighbors.set(from, set);
    }
    set.add(to);
  };
  for (const e of edges) {
    if (e.kind !== "elevator") continue;
    addNeighbor(e.from, e.to);
    addNeighbor(e.to, e.from);
  }
  const component = new Set<number>(startIds);
  const queue = [...component];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const neighbor of neighbors.get(id) ?? []) {
      if (!component.has(neighbor)) {
        component.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return component;
}

/** Rebuilds editable vertical-passage entries from generation's `EdgeDto[]` (GitHub issue #564) —
 * mirrors `extractPostEditTeleports`'s collapse-forward+backward-into-one-entry pattern, but keyed
 * by a canonical **endpoint** pair (`endpointKey(endpointFor(nodeId))`), not a raw node-id pair —
 * a raw `NodeId` is not guaranteed stable across regenerate/reload the way a resolved
 * `PostEditEndpoint` key is (see `resolverForNodeId`'s doc comment). Returns id-less entities plus
 * their own canonical key, entity/key assignment deliberately split (see `assignSequentialIds`) so
 * extraction stays a pure function of `edges`, with no id-allocation policy baked in. */
export function extractPostEditVerticalPassages(
  edges: EdgeDto[],
  endpointFor: (id: number) => PostEditEndpoint = nodeEndpoint,
): { entity: Omit<PostEditVerticalPassageEntry, "id">; key: string }[] {
  const vpEdges = edges.filter(e => e.kind === "vertical_passage");
  const byPair = new Set(vpEdges.map(e => `${e.from}->${e.to}`));
  const seenPairKey = new Set<string>();
  const result: { entity: Omit<PostEditVerticalPassageEntry, "id">; key: string }[] = [];

  for (const e of vpEdges) {
    const from = endpointFor(e.from);
    const to = endpointFor(e.to);
    const fromKey = endpointKey(from);
    const toKey = endpointKey(to);
    const pairKey = fromKey < toKey ? `${fromKey},${toKey}` : `${toKey},${fromKey}`;
    if (seenPairKey.has(pairKey)) continue;
    seenPairKey.add(pairKey);

    const reverseExists = byPair.has(`${e.to}->${e.from}`);
    result.push({
      entity: { from, to, direction: reverseExists ? "two_way" : "forward" },
      key: pairKey,
    });
  }

  return result;
}

/** Rebuilds editable elevator entries from generation's `EdgeDto[]` (GitHub issue #564) —
 * partitions every `elevator`-kind edge into connected components via `elevatorComponent` (one
 * `visited`-set pass so each component is emitted exactly once), each component being one logical
 * elevator — the same connected-component identity `markerIndex.ts`'s own `elevatorComponent` call
 * already relies on for image-export marker numbering, not a new invariant. Canonical key is the
 * sorted, joined list of the component's own `endpointKey(endpointFor(nodeId))` values — stable
 * under raw `NodeId` reshuffling the same way `extractPostEditVerticalPassages`'s pair key is. */
export function extractPostEditElevators(
  edges: EdgeDto[],
  endpointFor: (id: number) => PostEditEndpoint = nodeEndpoint,
): { entity: Omit<PostEditElevatorEntry, "id">; key: string }[] {
  const elevatorEdges = edges.filter(e => e.kind === "elevator");
  const nodeIds = new Set<number>();
  for (const e of elevatorEdges) {
    nodeIds.add(e.from);
    nodeIds.add(e.to);
  }
  const visited = new Set<number>();
  const result: { entity: Omit<PostEditElevatorEntry, "id">; key: string }[] = [];

  for (const nodeId of nodeIds) {
    if (visited.has(nodeId)) continue;
    const component = elevatorComponent(elevatorEdges, [nodeId]);
    for (const id of component) visited.add(id);
    const floors = [...component].map((id) => endpointFor(id));
    const key = floors.map((f) => endpointKey(f)).sort().join("|");
    result.push({ entity: { floors }, key });
  }

  return result;
}

/** `PostEditVerticalPassageEntry.direction` → the wire `VerticalPassageDirectionDto` — mirrors
 * `presetVerticalPassageDirectionToDto`. */
export function postEditVerticalPassageDirectionToDto(
  direction: PostEditVerticalPassageDirection,
): import("../wasm/types").VerticalPassageDirectionDto | undefined {
  if (direction === "two_way") return undefined;
  return direction;
}

/** Converts editable vertical-passage/elevator entries to the flat `{from, to, kind}[]` shape
 * `ComputeAnalyticsConfig.vertical_edges` expects — mirrors `postEditTeleportsToDto`, but each
 * endpoint is always `node`-kind already (a vertical passage/elevator is never `split`-addressed),
 * so `resolveEndpoint` only ever hits the trivial branch; kept for symmetry and to skip an entry
 * whose endpoint somehow isn't a `node` (shouldn't happen). `direction: "backward"` runs `to->from`,
 * same convention `postEditTeleportsToDto` uses. An elevator fans out into every pairwise
 * combination of its resolvable floor endpoints, both directions — mirrors `build_preset_state`'s
 * own elevator-establishing loop on the Rust side. */
export function postEditVerticalToDto(
  passages: PostEditVerticalPassageEntry[],
  elevators: PostEditElevatorEntry[],
  resolveSplit: (point: [number, number], slotId: number) => number | undefined,
): { from: number; to: number; kind: "vertical_passage" | "elevator" }[] {
  const result: { from: number; to: number; kind: "vertical_passage" | "elevator" }[] = [];
  for (const p of passages) {
    const from = resolveEndpoint(p.from, resolveSplit);
    const to = resolveEndpoint(p.to, resolveSplit);
    if (from === undefined || to === undefined) continue;
    if (p.direction === "two_way") {
      result.push({ from, to, kind: "vertical_passage" });
      result.push({ from: to, to: from, kind: "vertical_passage" });
    } else if (p.direction === "backward") {
      result.push({ from: to, to: from, kind: "vertical_passage" });
    } else {
      result.push({ from, to, kind: "vertical_passage" });
    }
  }
  for (const e of elevators) {
    const ids = e.floors.map((f) => resolveEndpoint(f, resolveSplit)).filter((id): id is number => id !== undefined);
    for (let i = 0; i < ids.length; i++) {
      for (let j = 0; j < ids.length; j++) {
        if (i === j) continue;
        result.push({ from: ids[i], to: ids[j], kind: "elevator" });
      }
    }
  }
  return result;
}
