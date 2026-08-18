import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../../fieldConfig";
import type { TeleportEdge } from "../../renderers/types";
import { getCellCenter, buildNodePositions, nearestCellCoord } from "../../tessellationGeometry";

/** Cross-floor resolution inputs for `buildTeleportEdges` (GitHub issue #337) — omitted by every
 *  non-floor-aware caller, which keeps the old behavior of silently dropping a teleport edge whose
 *  `to` doesn't resolve in `nodeById` (not reachable there yet anyway: cross-floor teleports don't
 *  exist until #340, and only floor-aware callers scope `edges` in a way that lets one through
 *  `selectFloorScopedMaze` in the first place). `resolveNodeLevel`/`unscopedNodeById` must both come
 *  from the *unscoped* node list, same requirement `buildVerticalConnectionMarkers` already has on
 *  its own `resolveNodeLevel`/`allEdges` params, since `to` never survives floor-scoping itself.
 *  `unscopedEdges` (same *unscoped* requirement) is what `byPair`'s bidirectional-detection needs
 *  for a cross-floor pair — its reverse-direction edge has its own `from` on the *other* floor, so
 *  it's never present in the already floor-scoped `edges` this function otherwise reads (same
 *  bidirectional-detection gap `selectVerticalPassagePairSet`'s own doc comment describes for
 *  `vertical_passage`). */
export type TeleportFloorContext = {
  resolveNodeLevel: (id: number) => number | undefined;
  unscopedNodeById: Map<number, NodeDto>;
  unscopedEdges: EdgeDto[];
  activeFloorIndex: number;
};

// Collapses opposite-direction teleport-edge pairs into one entity so a two-way teleport never
// renders as two overlapping lines/arrows. `oneWay: false` when both directions exist between
// the pair; `oneWay: true` (with from/to = that edge's actual direction) when only one does.
//
// A teleport endpoint on a split point (GitHub issue #223) anchors to that node's own hub point
// (`buildNodePositions`), not the tile's plain center — `nodeById`'s full value set stands in for
// `nodes` here (unsplit callers, e.g. GenerationRenderer, never have more than one node per point,
// so this is a no-op for them; only PostEditRenderer's split points actually differ). Builds the
// position map once (GitHub issue #318 follow-up) rather than calling `getSplitAwareNodePosition`
// per endpoint — that would rebuild the whole map from scratch for every one of up to `2 ×
// teleport pair count` lookups.
//
// `floorContext` (GitHub issue #337, optional — see its own doc comment) resolves a cross-floor
// `to` (absent from `nodeById`, which is floor-scoped for every floor-aware caller) via its own
// `unscopedNodeById`/`resolveNodeLevel`, then substitutes the midpoint between `from`'s and the
// real (off-image) `to` position as this edge's own `to` — the routing/collision-avoidance layers
// downstream (`TeleportConnectorRouter` et al.) never need to know the far end isn't really drawn
// there; only `toFloor` being set tells `TeleportRenderer` to draw a floor-badge at that point
// instead of an ordinary marker. That midpoint is built from each node's own plain cell center
// (`getCellCenter`), not either node's own hub position (`nodePos`/`buildNodePositions`) — a hub
// position is shaped by `directedPairs`, which differs depending on which floor is active (the
// active floor's own nodes/edges feed it, the far floor's never do), so the same logical pair
// viewed from either floor would otherwise resolve to two slightly different hub positions and the
// badge would visibly shift between floors. Plain cell centers have no such context-dependence —
// the same `(x, y)` always resolves to the same point regardless of which floor is asking.
export function buildTeleportEdges(
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  cfg: TessellationConfig,
  floorContext?: TeleportFloorContext,
): TeleportEdge[] {
  const teleports = edges.filter((e) => e.kind === "teleport");
  const byPair = new Set(teleports.map((e) => `${e.from}->${e.to}`));
  const seenPairKey = new Set<string>();
  const result: TeleportEdge[] = [];
  const allNodes = Array.from(nodeById.values());
  const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
  const nodePos = buildNodePositions(allNodes, cfg, directedPairs);

  for (const e of teleports) {
    const pairKey = e.from < e.to ? `${e.from},${e.to}` : `${e.to},${e.from}`;
    if (seenPairKey.has(pairKey)) continue;
    seenPairKey.add(pairKey);

    let fromPos = nodePos.get(e.from);
    let toPos = nodePos.get(e.to);
    let toFloor: number | undefined;
    let fromFloor: number | undefined;
    // A cross-floor pair's reverse edge is never in `byPair` (built from the floor-scoped
    // `teleports` above, which structurally can't contain it — see `TeleportFloorContext`'s own
    // doc comment) — re-checked against the unscoped edge list once this edge is confirmed
    // cross-floor, below, so `reverseExists` isn't finalized until after that check.
    let reverseExists = byPair.has(`${e.to}->${e.from}`);

    if (!toPos && floorContext) {
      const level = floorContext.resolveNodeLevel(e.to);
      if (level !== undefined && level !== floorContext.activeFloorIndex) {
        const fromNode = nodeById.get(e.from);
        const realToNode = floorContext.unscopedNodeById.get(e.to);
        if (fromNode && realToNode) {
          const fromCenter = getCellCenter(fromNode.x, fromNode.y, cfg);
          const realToCenter = getCellCenter(realToNode.x, realToNode.y, cfg);
          const midX = (fromCenter.x + realToCenter.x) / 2;
          const midY = (fromCenter.y + realToCenter.y) / 2;
          // Snapped onto the grid (GitHub issue #337 follow-up), not left at the raw midpoint —
          // an unsnapped point can land mid-wall, making the connector look like it cuts straight
          // through a wall instead of ending at a real cell. `nearestCellCoord` is a pure function
          // of `(midX, midY, cfg)` alone, so the snapped cell (and thus this badge's own world
          // position) is identical whichever floor computed it — required for the from/to symmetry
          // this whole midpoint scheme already depends on (see this function's own doc comment).
          const [snapX, snapY] = nearestCellCoord(midX, midY, cfg);
          const snapped = getCellCenter(snapX, snapY, cfg);
          toPos = { x: snapped.x, y: snapped.y };
          toFloor = level;
          reverseExists = floorContext.unscopedEdges.some((ue) => ue.kind === "teleport" && ue.from === e.to && ue.to === e.from);
        }
      }
    }
    // Symmetric case: this edge's own `from` (departure) lives on another floor, `to` (arrival) is
    // here — e.g. the reverse directed edge of a two-way cross-floor pair, seen on the arrival
    // floor. Without this branch the pair is silently dropped on this floor: `seenPairKey` already
    // claims the pair key from whichever directed edge the caller's `edges` array happened to list
    // first, so if that first one is the departure-elsewhere direction (`fromPos` unresolvable),
    // the pair never gets a second chance via the other directed edge, and the separate arrival-
    // only pass below only ever triggers for a *pure one-way* pair (which has no reverse directed
    // edge to begin with, so `seenPairKey` never blocks it in the first place).
    if (!fromPos && floorContext) {
      const level = floorContext.resolveNodeLevel(e.from);
      if (level !== undefined && level !== floorContext.activeFloorIndex) {
        const toNode = nodeById.get(e.to);
        const realFromNode = floorContext.unscopedNodeById.get(e.from);
        if (toNode && realFromNode) {
          const toCenter = getCellCenter(toNode.x, toNode.y, cfg);
          const realFromCenter = getCellCenter(realFromNode.x, realFromNode.y, cfg);
          const midX = (toCenter.x + realFromCenter.x) / 2;
          const midY = (toCenter.y + realFromCenter.y) / 2;
          const [snapX, snapY] = nearestCellCoord(midX, midY, cfg);
          const snapped = getCellCenter(snapX, snapY, cfg);
          fromPos = { x: snapped.x, y: snapped.y };
          fromFloor = level;
          reverseExists = floorContext.unscopedEdges.some((ue) => ue.kind === "teleport" && ue.from === e.to && ue.to === e.from);
        }
      }
    }
    if (!fromPos || !toPos) continue;

    result.push({
      from: [fromPos.x, fromPos.y],
      to: [toPos.x, toPos.y],
      oneWay: !reverseExists,
      fromNode: e.from,
      toNode: e.to,
      ...(toFloor !== undefined ? { toFloor } : {}),
      ...(fromFloor !== undefined ? { fromFloor } : {}),
    });
  }

  // Arrival-only cross-floor one-way teleports (GitHub issue #357 follow-up): a pure one-way
  // teleport whose `from` lives on another floor never survives `edges`' own floor-scoping (which
  // only keeps an edge when `from` is on the active floor), so the loop above never sees it — the
  // active floor would otherwise show nothing at all for it, unlike a same-floor one-way teleport,
  // whose arrival end still draws (as an outline point on its own `edges` entry). Every such pair is
  // already `seenPairKey`-excluded here when it has a same-direction *or* reverse entry the loop
  // above already produced (a same-floor pair a `resolveNodeLevel`-thin `unscopedEdges` scan would
  // otherwise re-detect as "arrival-only" a second time). Scanned from `unscopedEdges` (never just
  // `edges`, which is this function's own floor-scoped param and structurally excludes exactly the
  // edges this pass needs) — a no-op when `floorContext` is absent, same as the main loop's own
  // cross-floor branch.
  if (floorContext) {
    for (const e of floorContext.unscopedEdges) {
      if (e.kind !== "teleport") continue;
      const pairKey = e.from < e.to ? `${e.from},${e.to}` : `${e.to},${e.from}`;
      if (seenPairKey.has(pairKey)) continue;
      const toLevel = floorContext.resolveNodeLevel(e.to);
      if (toLevel !== floorContext.activeFloorIndex) continue;
      const fromLevel = floorContext.resolveNodeLevel(e.from);
      if (fromLevel === undefined || fromLevel === floorContext.activeFloorIndex) continue;
      seenPairKey.add(pairKey);

      const realToNode = floorContext.unscopedNodeById.get(e.to);
      const realFromNode = floorContext.unscopedNodeById.get(e.from);
      if (!realToNode || !realFromNode) continue;
      const toPos = nodePos.get(e.to) ?? getCellCenter(realToNode.x, realToNode.y, cfg);

      const fromCenter = getCellCenter(realFromNode.x, realFromNode.y, cfg);
      const toCenter = getCellCenter(realToNode.x, realToNode.y, cfg);
      const midX = (fromCenter.x + toCenter.x) / 2;
      const midY = (fromCenter.y + toCenter.y) / 2;
      const [snapX, snapY] = nearestCellCoord(midX, midY, cfg);
      const snapped = getCellCenter(snapX, snapY, cfg);

      result.push({
        from: [snapped.x, snapped.y],
        to: [toPos.x, toPos.y],
        oneWay: true,
        fromNode: e.from,
        toNode: e.to,
        fromFloor: fromLevel,
      });
    }
  }

  return result;
}
