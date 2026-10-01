import type { NodeDto, EdgeDto } from "../wasm/types";
import type {
  PostEditVerticalPassageEntry, PostEditVerticalPassageDirection, PostEditVerticalPassageEndpointHit,
  PostEditElevatorEntry, PostEditElevatorEndpointHit, PostEditVerticalDragFailure,
} from "../store/mazeStore";
import { makeProjection } from "./tessellationProjection";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { type PostEditEndpoint, nodeEndpoint, resolveEndpoint, endpointKey, endpointsEqual } from "./postEditEndpoint";
import { pickNearestPointerHit } from "./pointerInteraction";

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
  const pointerCell = proj.screenToGrid(viewportX, viewportY);
  const candidates = passages.flatMap((passage) => (["from", "to"] as const).flatMap((end) => {
    const endpoint = end === "from" ? passage.from : passage.to;
    if (endpoint.kind !== "node" || (resolveNodeLevel(endpoint.id) ?? 0) !== (activeLevel ?? 0)) return [];
    const node = nodeById.get(endpoint.id);
    return node ? [{ id: passage.id, end, node }] : [];
  }));
  const hit = pickNearestPointerHit(
    viewportX,
    viewportY,
    candidates,
    (candidate) => proj.gridToScreen(candidate.node.x, candidate.node.y),
    (candidate) => pointerCell.x === candidate.node.x && pointerCell.y === candidate.node.y,
  );
  return hit ? { id: hit.id, end: hit.end } : null;
}

/** Same hit-test as `pickPostEditVerticalPassageEndpointAt`, for post-edit elevators (GitHub issue
 * #566) — only ever tests the active floor's own endpoint of each elevator entry (mirrors
 * `buildVerticalConnectionMarkers`'s own active-floor filter), so
 * `PostEditElevatorEndpointHit.level` is always the active floor. */
export function pickPostEditElevatorEndpointAt(
  viewportX: number,
  viewportY: number,
  cfg: TessellationConfig,
  elevators: PostEditElevatorEntry[],
  nodeById: Map<number, NodeDto>,
  resolveNodeLevel: (id: number) => number | undefined,
  activeLevel: number | undefined,
): PostEditElevatorEndpointHit | null {
  const proj = makeProjection(cfg);
  const pointerCell = proj.screenToGrid(viewportX, viewportY);
  const candidates = elevators.flatMap((elevator) => {
    const own = elevator.floors.find((floor) => floor.kind === "node" && (resolveNodeLevel(floor.id) ?? 0) === (activeLevel ?? 0));
    if (!own || own.kind !== "node") return [];
    const node = nodeById.get(own.id);
    return node ? [{ id: elevator.id, level: activeLevel ?? 0, node }] : [];
  });
  const hit = pickNearestPointerHit(
    viewportX,
    viewportY,
    candidates,
    (candidate) => proj.gridToScreen(candidate.node.x, candidate.node.y),
    (candidate) => pointerCell.x === candidate.node.x && pointerCell.y === candidate.node.y,
  );
  return hit ? { id: hit.id, level: hit.level } : null;
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

/** Finds the real node at `(x, y)` on floor `level` — the post-edit analogue of the preset stage's
 * `cellExistsAt`: post-edit addresses already-resolved graph nodes rather than raw field cells, so
 * "does the point exist on that floor" is a node lookup, not a field-membership check. */
function findNodeAt(nodes: NodeDto[], resolveNodeLevel: (id: number) => number | undefined, point: [number, number], level: number): NodeDto | undefined {
  return nodes.find((n) => n.x === point[0] && n.y === point[1] && (resolveNodeLevel(n.id) ?? 0) === level);
}

/** Pure setter — replaces one end of a vertical-passage entry with an already-resolved endpoint,
 * trusting the caller for consistency. The command log replays this verbatim (`command.endpoint`
 * is always the RESULT of a successful `resolveVerticalPassageMove` call, computed once at
 * dispatch time — see `postEditSlice.ts`'s `movePostEditVerticalPassageEndpoint` action), so this
 * stays a plain, infallible reducer step; it does not itself sync the other end (GitHub issue
 * #566's actual fix lives in `resolveVerticalPassageMove`, which decides BOTH ends' resulting
 * `PostEditEndpoint`s before a command is ever appended). */
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

/** Resolves what BOTH ends of a vertical passage should become after dragging `hit.end` to
 * `newNode` (GitHub issue #566) — a vertical passage's two ends are the same (x, y) column on
 * different floors, so moving only the dragged end (the pre-fix behavior) desyncs the passage's
 * own coordinates. Fails (`failure` set, no `from`/`to`) when the OTHER end's own floor has no
 * node at `newNode`'s `(x, y)` — the caller (`postEditSlice.ts`) is expected to revert the whole
 * drag gesture on failure, never append a command for a partial move.
 *
 * `ownEndpoint`/`otherEndpoint` (GitHub issue #567) override the plain `nodeEndpoint(...)` this
 * function would otherwise build for the dragged end / resolve via `findNodeAt` for the other end
 * — used once the user has explicitly picked a node via `PostEditSplitTargetDialog` for a landing
 * point that turned out to be split (`findNodeAt`'s bare `.find()` would otherwise silently always
 * pick that point's original node, never letting the user land on a numbered slot). Omitted
 * (`undefined`) for a plain, non-split landing point — the original `nodeEndpoint`/`findNodeAt`
 * behavior is unchanged in that case. */
export function resolveVerticalPassageMove(
  entry: PostEditVerticalPassageEntry,
  end: "from" | "to",
  newNode: NodeDto,
  nodes: NodeDto[],
  resolveNodeLevel: (id: number) => number | undefined,
  ownEndpoint?: PostEditEndpoint,
  otherEndpoint?: PostEditEndpoint,
): { from: PostEditEndpoint; to: PostEditEndpoint } | { failure: PostEditVerticalDragFailure } {
  const otherEp = end === "from" ? entry.to : entry.from;
  // The OTHER end's CURRENT endpoint can already be `split`-kind (GitHub issue #567 — it may have
  // been resolved to a numbered slot by an earlier drag/placement), not just `node`-kind — a
  // split-kind endpoint carries its own `level` directly, same `endpointLevel` reads for an
  // elevator floor, so this no longer needs to bail out early. Bailing here used to fail EVERY
  // drag of a vertical passage whose other end already lived on a split tile, even though the
  // caller (`PostEditController`) already queues a fresh pick for that other end via
  // `otherEndpoint` when it's needed.
  const otherLevel = endpointLevel(otherEp, resolveNodeLevel);
  const own = ownEndpoint ?? nodeEndpoint(newNode.id);
  let other = otherEndpoint;
  if (!other) {
    const otherNode = findNodeAt(nodes, resolveNodeLevel, [newNode.x, newNode.y], otherLevel);
    if (!otherNode) return { failure: { level: otherLevel, point: [newNode.x, newNode.y] } };
    other = nodeEndpoint(otherNode.id);
  }
  return end === "from" ? { from: own, to: other } : { from: other, to: own };
}

export function removePostEditElevator(elevators: PostEditElevatorEntry[], id: string): PostEditElevatorEntry[] {
  return elevators.filter(e => e.id !== id);
}

/** Pure setter — replaces an elevator's `floors` with an already-resolved list, trusting the
 * caller for consistency. Mirrors `movePostEditVerticalPassageEndpoint`'s own doc comment: the
 * command log replays this verbatim, the real GitHub issue #566 fix lives in
 * `resolveElevatorMove`. */
export function movePostEditElevatorEndpoint(
  elevators: PostEditElevatorEntry[],
  id: string,
  floors: PostEditEndpoint[],
): PostEditElevatorEntry[] {
  return elevators.map((e) => (e.id === id ? { ...e, floors } : e));
}

function endpointLevel(f: PostEditEndpoint, resolveNodeLevel: (id: number) => number | undefined): number {
  return f.kind === "node" ? (resolveNodeLevel(f.id) ?? 0) : (f.level ?? 0);
}

/** Resolves what EVERY floor endpoint of an elevator should become after dragging `hit.level`'s
 * own endpoint to `newNode` (GitHub issue #566) — mirrors `resolveVerticalPassageMove`, but an
 * elevator's whole fan shares one column, so a drag on any one floor's marker must re-target every
 * other floor's own endpoint to the same point too. Covers `split`-kind floor endpoints too (an
 * elevator floor CAN be split-addressed, see `confirmPostEditElevatorPlacement`) — a split floor's
 * own `level` comes straight off the endpoint, no node lookup needed for that part. Fails when no
 * node exists at `newNode`'s `(x, y)` on one of the OTHER floors (first such floor, ascending
 * order). Returns each resolved OTHER floor as a raw `NodeDto`; the caller re-wraps a floor that
 * was originally `split`-kind back through `resolveNodeIdToEndpoint` (needs `postEditDraftSplitPoints`,
 * not available in this file) so its slot identity survives the move.
 *
 * `overridesByLevel` (GitHub issue #567) — a level -> already-resolved `PostEditEndpoint` map for
 * any floor (the dragged one included) whose landing point turned out to be split and got an
 * explicit user pick via `PostEditSplitTargetDialog`; that floor's own entry is used verbatim
 * instead of `findNodeAt`'s bare `.find()` (which would otherwise silently always pick the point's
 * original node). A level with no override entry keeps the original behavior. */
export function resolveElevatorMove(
  entry: PostEditElevatorEntry,
  hit: PostEditElevatorEndpointHit,
  newNode: NodeDto,
  nodes: NodeDto[],
  resolveNodeLevel: (id: number) => number | undefined,
  overridesByLevel?: ReadonlyMap<number, PostEditEndpoint>,
): { own: PostEditEndpoint; others: Map<number, PostEditEndpoint> } | { failure: PostEditVerticalDragFailure } {
  const otherLevels = entry.floors
    .map((f) => endpointLevel(f, resolveNodeLevel))
    .filter((level) => level !== hit.level)
    .sort((a, b) => a - b);
  const resolvedByLevel = new Map<number, PostEditEndpoint>();
  for (const level of otherLevels) {
    const override = overridesByLevel?.get(level);
    if (override) {
      resolvedByLevel.set(level, override);
      continue;
    }
    const node = findNodeAt(nodes, resolveNodeLevel, [newNode.x, newNode.y], level);
    if (!node) return { failure: { level, point: [newNode.x, newNode.y] } };
    resolvedByLevel.set(level, nodeEndpoint(node.id));
  }
  const own = overridesByLevel?.get(hit.level) ?? nodeEndpoint(newNode.id);
  return { own, others: resolvedByLevel };
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
 * `ComputeAnalyticsConfig.vertical_edges` expects — mirrors `postEditTeleportsToDto`. An endpoint
 * can be `split`-kind (GitHub issue #567: landing a drag/fresh placement on a split tile's non-main
 * node), so `resolveSplit` MUST be a maze-wide/unscoped resolver, not one built from a single
 * floor's nodes — a vertical passage/elevator is inherently cross-floor, so a split `to`/other-floor
 * endpoint routinely lives on a floor other than whichever one the caller is currently rendering;
 * a floor-scoped resolver silently fails on it, and the `if (from === undefined || to === undefined)
 * continue` below then drops the WHOLE edge, not just the unresolved endpoint. `direction:
 * "backward"` runs `to->from`, same convention `postEditTeleportsToDto` uses. An elevator fans out
 * into every pairwise combination of its resolvable floor endpoints, both directions — mirrors
 * `build_preset_state`'s own elevator-establishing loop on the Rust side. */
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
