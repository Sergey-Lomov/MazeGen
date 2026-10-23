import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { FieldConfig } from "../../../fieldConfig";
import type { VerticalConnectionMarker } from "../../renderers/types";
import { buildNodePositions } from "../../tessellationGeometry";

/** Every `VerticalPassage` edge's own `"from->to"` key (GitHub issue #337/#347's bidirectional-
 *  detection bug), built from the *unscoped* edge list — `selectFloorScopedMaze` only keeps a
 *  vertical/elevator edge whose `from` is on the active floor, so the reverse-direction edge of a
 *  bidirectional passage (its own `from` lives on the *other* floor) is always missing from any
 *  already floor-scoped edge list. A bidirectional-detection check built from scoped edges can
 *  therefore never find its own partner and always falls through as "one-way" — this must always
 *  be built from `state.nodes`/`state.edges` (or the debug-replay equivalent), the same unscoped
 *  source `selectNodeLevelResolver` already requires for the same reason. Shared by every caller
 *  of `buildVerticalConnectionMarkers` rather than each re-deriving it — see that function's own
 *  `allEdges` parameter. */
export function selectVerticalPassagePairSet(allEdges: EdgeDto[]): ReadonlySet<string> {
  const pairs = new Set<string>();
  for (const e of allEdges) {
    if (e.kind === "vertical_passage") pairs.add(`${e.from}->${e.to}`);
  }
  return pairs;
}

/** `VerticalPassage`/`Elevator` edges (GitHub issue #337/#347) as single point-anchored markers —
 *  the "Vector by walls" render mode's own reading of these edge kinds, see
 *  `VerticalConnectionMarker`'s own doc comment for why there's no connector line: `to` lives on
 *  another floor, entirely absent from this image's `nodes`. `edges` is expected already
 *  floor-scoped (`selectFloorScopedMaze`, which keeps a vertical/elevator edge whenever its `from`
 *  is on the active floor); `resolveNodeLevel` (`selectNodeLevelResolver`, built from the *unscoped*
 *  node list) resolves `to`'s own floor so a marker's direction arrow can compare it against
 *  `activeFloorIndex`. `verticalPairs` (`selectVerticalPassagePairSet`, same *unscoped*-source
 *  requirement as `resolveNodeLevel`, for the same reason — see that function's own doc comment) is
 *  what decides one-way vs. bidirectional; a set built from the already-scoped `edges` here would
 *  never contain the reverse-direction edge, since its own `from` is never on this floor.
 *
 *  One filled marker per distinct `from` node per edge kind — an `Elevator`'s fully-connected fan
 *  can produce several edges sharing the same `from` (one per other floor in the fan), which would
 *  otherwise draw the same marker stacked on itself several times. A one-way `VerticalPassage`'s
 *  arrival-only end also gets an *empty* marker at its `to` node, but that `to` node is (by
 *  definition) never on this call's own active floor — so it can never be found by scanning `edges`
 *  (which only ever has `from` on this floor, per `selectFloorScopedMaze`'s own doc comment).
 *  `allEdges` (the *unscoped* edge list, same source `resolveNodeLevel`/`verticalPairs` already
 *  require) is scanned separately for one-way edges whose `to` lands on this floor — that's the
 *  only way an arrival marker is ever found, since `edges` structurally can't contain it. `filled`/
 *  empty circle and the arrow's own fill are the visual distinction between "you can enter here"
 *  and "you only arrive here" (GitHub issue #337/#347 design follow-up) — see
 *  `VerticalConnectionMarker`'s own doc comment. */
export function buildVerticalConnectionMarkers(
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  cfg: FieldConfig,
  resolveNodeLevel: (id: number) => number | undefined,
  activeFloorIndex: number,
  verticalPairs: ReadonlySet<string>,
  allEdges: EdgeDto[],
  replaceTwoFloorElevatorsWithStairs = false,
): VerticalConnectionMarker[] {
  const isVertical = (e: EdgeDto): e is EdgeDto & { kind: "vertical_passage" | "elevator" } =>
    e.kind === "vertical_passage" || e.kind === "elevator";
  const verticalEdges = edges.filter(isVertical);
  const localNodeIds = new Set(nodeById.keys());
  const arrivalEdges = allEdges.filter((e): e is EdgeDto & { kind: "vertical_passage" } =>
    e.kind === "vertical_passage" && localNodeIds.has(e.to) && !localNodeIds.has(e.from) && !verticalPairs.has(`${e.to}->${e.from}`),
  );
  if (verticalEdges.length === 0 && arrivalEdges.length === 0) return [];

  const byPair = verticalPairs;
  const allNodes = Array.from(nodeById.values());
  // Keep split-node marker anchors in sync with graph/split renderers. In particular, a square
  // bridge has a shape-aware pair of anchors; an empty directed-pair list falls back to the
  // generic hub circle and puts the two vertical markers diagonally apart (GitHub issue #555).
  const directedPairs = allEdges
    .filter((e) => e.kind !== "teleport")
    .map(({ from, to }) => ({ from, to }));
  const nodePos = buildNodePositions(allNodes, cfg, directedPairs);

  // Aggregates direction across every reachable floor, not just one edge — an `Elevator`'s fan can
  // connect one node to several other floors at once (several edges sharing the same `from`), so a
  // single marker there must show `"both"` when it reaches floors on both sides of the active one,
  // not just whichever edge happened to be seen first (GitHub issue #337/#347 design follow-up).
  const directionAcross = (targetIds: Iterable<number>): "up" | "down" | "both" | undefined => {
    let sawUp = false;
    let sawDown = false;
    for (const id of targetIds) {
      const level = resolveNodeLevel(id);
      if (level === undefined || level === activeFloorIndex) continue;
      if (level > activeFloorIndex) sawUp = true;
      else sawDown = true;
    }
    if (sawUp && sawDown) return "both";
    if (sawUp) return "up";
    if (sawDown) return "down";
    return undefined;
  };

  // Groups edges by `from`+kind first (not deduped-on-first-seen) so an Elevator fan's several
  // edges from the same node are all available to `directionAcross` before a marker is built.
  const targetsByFromKind = new Map<string, number[]>();
  const orderedFromKinds: { from: number; kind: "vertical_passage" | "elevator" }[] = [];
  for (const e of verticalEdges) {
    const groupKey = `${e.from}:${e.kind}`;
    let targets = targetsByFromKind.get(groupKey);
    if (!targets) {
      targets = [];
      targetsByFromKind.set(groupKey, targets);
      orderedFromKinds.push({ from: e.from, kind: e.kind });
    }
    targets.push(e.to);
  }

  const seenKey = new Set<string>();
  const result: VerticalConnectionMarker[] = [];
  for (const { from, kind } of orderedFromKinds) {
    const groupKey = `${from}:${kind}`;
    if (seenKey.has(groupKey)) continue;
    seenKey.add(groupKey);

    const pos = nodePos.get(from);
    if (!pos) continue;

    const targets = targetsByFromKind.get(groupKey)!;
    const targetLevels = targets.map(resolveNodeLevel);
    const renderAsStairs = replaceTwoFloorElevatorsWithStairs && kind === "elevator" &&
      targetLevels.every((l): l is number => l !== undefined) && new Set(targetLevels).size === 1;
    const markerKind = renderAsStairs ? "vertical_passage" : kind;
    // A one-way VerticalPassage's departure marker draws empty (`filled: false`) with a solid
    // arrow (`arrowFilled: true`) — only the arrow, not the circle fill, distinguishes it from its
    // own arrival-only marker below. Bidirectional/Elevator draw the ordinary solid marker.
    const isOneWay = markerKind === "vertical_passage" && !renderAsStairs && !byPair.has(`${targets[0]}->${from}`);
    const targetFloorIndex = markerKind === "vertical_passage" ? resolveNodeLevel(targets[0]) : undefined;
    // Every floor this Elevator's fan reaches (GitHub issue #430) — sorted ascending, deduplicated.
    // Only resolved for `elevator`; a `vertical_passage` always has exactly one target, already
    // covered by `targetFloorIndex`.
    const targetFloorIndices = kind === "elevator"
      ? Array.from(new Set(targets.map(resolveNodeLevel).filter((l): l is number => l !== undefined))).sort((a, b) => a - b)
      : undefined;
    result.push({
      pos: [pos.x, pos.y], fromNode: from, kind: markerKind, direction: directionAcross(targets), targetFloorIndex,
      targetFloorIndices: markerKind === "elevator" ? targetFloorIndices : undefined,
      filled: !isOneWay, arrowFilled: true,
    });
  }

  // Arrival-end markers (one-way VerticalPassage only) — `arrivalEdges` (see this function's own
  // doc comment) is the only source that can find these, since their `to` node is never on this
  // floor's own `edges`/`nodeById` scope.
  for (const e of arrivalEdges) {
    const arrivalKey = `${e.to}:${e.kind}:arrival`;
    if (seenKey.has(arrivalKey)) continue;
    seenKey.add(arrivalKey);
    const arrivalPos = nodePos.get(e.to);
    if (!arrivalPos) continue;
    result.push({
      pos: [arrivalPos.x, arrivalPos.y], fromNode: e.to, kind: e.kind, direction: directionAcross([e.from]),
      targetFloorIndex: resolveNodeLevel(e.from), filled: false, arrowFilled: false,
    });
  }

  return result;
}
