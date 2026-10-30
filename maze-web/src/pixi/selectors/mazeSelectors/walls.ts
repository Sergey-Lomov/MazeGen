import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { FieldConfig } from "../../../fieldConfig";
import type { WallEdge, PassageKind } from "../../renderers/types";
import { getCellCenter, getFaceEdgeSegment, getNeighborData, getSharedEdgeSegment } from "../../tessellationGeometry";
import { buildCellSet } from "../sharedSelectors";
import { getSeamModel } from "../seams";
import { buildSplitPointKeys } from "./split";

// A cell is "closed" (filled as a wall) only when it has no connection at all — including a
// teleport-only connection. A teleport in/out is a valid way to enter/exit the cell even though
// it renders no wall opening on any geometric side (see buildMazeWalls, which deliberately
// ignores teleport edges for the opposite reason: a teleport must not fake an open passage
// between geometric neighbors). Both kinds count as "connected" here.
//
// A split point (GitHub issue #221) can have more than one `NodeDto` at the same (x,y) — the
// original node plus each extra split node. Grouping by cell before checking connectivity is
// required: filtering `nodes` directly (one entry per *node*, not per *cell*) would mark the cell
// closed whenever any single one of its nodes happens to have no edges (e.g. the original node's
// direct passage was walled off, but a split node added at the same point has a passage of its
// own) — the point as a whole is still open, so the cell must not render as a wall.
// `allEdges` (GitHub issue #337/#359 follow-up, optional — unscoped, same requirement as
// `buildVerticalConnectionMarkers`'s own `allEdges` param) covers a one-way `VerticalPassage`/
// `Elevator` whose arrival-only end lands on this floor: `edges` is floor-scoped for every
// floor-aware caller (`selectFloorScopedMaze` keeps a vertical/elevator edge only when its `from`
// is on the active floor — see that function's own doc comment), so an arrival-only `to` node's
// edge is structurally absent from `edges` and this cell would otherwise be mistaken for having no
// connection at all and rendered as a wall. Omitted callers (every non-floor-aware one) see no
// change in behavior — `edges` alone is exactly what `connected` was built from before this param
// existed.
export function buildClosedCells(nodes: NodeDto[], edges: EdgeDto[], allEdges?: EdgeDto[]): [number, number][] {
  const connected = new Set<number>();
  for (const e of edges) { connected.add(e.from); connected.add(e.to); }
  if (allEdges) {
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const e of allEdges) {
      if (e.kind !== "vertical_passage" && e.kind !== "elevator") continue;
      // Vertical passage/elevator edges are never post-edit-editable (see `PostEditRenderer`'s own
      // call site), so neither end is in `edges`/`activeEdges` above — both `from` (the departure
      // end, on this floor for an edge whose own `from` is here) and `to` (the arrival-only end
      // covered before this fix) must be checked, not just `to`.
      if (nodeIds.has(e.from)) connected.add(e.from);
      if (nodeIds.has(e.to)) connected.add(e.to);
    }
  }
  const anyConnectedByCell = new Map<string, boolean>();
  const cellCoords = new Map<string, [number, number]>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    cellCoords.set(key, [n.x, n.y]);
    anyConnectedByCell.set(key, (anyConnectedByCell.get(key) ?? false) || connected.has(n.id));
  }
  const closed: [number, number][] = [];
  for (const [key, isConnected] of anyConnectedByCell) {
    if (!isConnected) closed.push(cellCoords.get(key)!);
  }
  return closed;
}

export function buildMazeWalls(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: FieldConfig,
): WallEdge[] {
  const nodeById = new Map<number, NodeDto>();
  for (const n of nodes) nodeById.set(n.id, n);

  const directed = new Set<string>();
  for (const e of edges) {
    // Teleport edges are rendered by TeleportRenderer, not as a wall opening -- a teleport
    // between geometrically adjacent cells must not read as an open passage here. `edges` may
    // contain both kinds mixed together (see EdgeDto's coexistence note), so this must filter,
    // not just trust the caller passed a basic-only list.
    if (e.kind === "teleport") continue;
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to) continue;
    directed.add(`${from.x},${from.y}->${to.x},${to.y}`);
  }

  const cells: [number, number][] = nodes.map(n => [n.x, n.y]);
  const cellSet = buildCellSet(cells);
  const splitPointKeys = buildSplitPointKeys(nodes);
  const result: WallEdge[] = [];

  for (const n of nodes) {
    const selfKey = `${n.x},${n.y}`;
    if (splitPointKeys.has(selfKey)) continue; // rendered by buildSplitPassages instead
    const { offsets } = getNeighborData(cfg, n.x, n.y);
    for (const [dx, dy] of offsets) {
      const nx = n.x + dx;
      const ny = n.y + dy;
      if (!cellSet.has(`${nx},${ny}`)) continue;
      if (splitPointKeys.has(`${nx},${ny}`)) continue; // rendered by buildSplitPassages instead
      const ownsEdge = n.x < nx || (n.x === nx && n.y < ny);
      if (!ownsEdge) continue;

      const fwd = directed.has(`${n.x},${n.y}->${nx},${ny}`);
      const bwd = directed.has(`${nx},${ny}->${n.x},${n.y}`);

      let kind: PassageKind;
      if (fwd && bwd) kind = "both";
      else if (fwd) kind = "forward";
      else if (bwd) kind = "backward";
      else kind = "none";

      if (kind === "both") continue; // bidirectional passage — no wall

      let oneWayDir: { dx: number; dy: number } | undefined;
      if (kind === "forward" || kind === "backward") {
        const fromCenter = getCellCenter(n.x, n.y, cfg);
        const toCenter = getCellCenter(nx, ny, cfg);
        const tdx = kind === "forward" ? toCenter.x - fromCenter.x : fromCenter.x - toCenter.x;
        const tdy = kind === "forward" ? toCenter.y - fromCenter.y : fromCenter.y - toCenter.y;
        const len = Math.sqrt(tdx * tdx + tdy * tdy);
        if (len > 0) oneWayDir = { dx: tdx / len, dy: tdy / len };
      }

      result.push({
        a: [n.x, n.y],
        b: [nx, ny],
        kind,
        style: "solid",
        oneWayDir,
      });
    }
  }

  // Boundary walls (no neighbor in cellSet) — drawn even for split points: a field-edge side is
  // never one of a split node's connected faces (`buildSplitPassagesCore` only draws segments
  // toward faces the point's nodes actually connect across), so skipping it here would leave the
  // point's outer edge with no wall at all.
  const seams = getSeamModel(cfg);
  const boundaryDrawn = new Set<string>();
  for (const n of nodes) {
    const { offsets } = getNeighborData(cfg, n.x, n.y);
    for (const [face, [dx, dy]] of offsets.entries()) {
      const nx = n.x + dx;
      const ny = n.y + dy;
      const neighborless = dx === 0 && dy === 0;
      const half = seams.halfEdgeAt([n.x, n.y], face);
      if (half) {
        // A glued face is not a field edge: each side draws the whole face as its own wall (or
        // none, when the passage is open), and a one-way indicator on it points out of this cell on
        // the source side and into it on the partner side.
        const seamKey = `${n.x},${n.y}#${face}`;
        if (boundaryDrawn.has(seamKey)) continue;
        boundaryDrawn.add(seamKey);
        // A split point's seam face is drawn by `buildSplitPassages` (passage segments or an
        // all-wall face, on this side's own geometry), same as its ordinary faces.
        if (splitPointKeys.has(`${n.x},${n.y}`)) continue;
        const [px, py] = half.partnerCell;
        const fwd = directed.has(`${n.x},${n.y}->${px},${py}`);
        const bwd = directed.has(`${px},${py}->${n.x},${n.y}`);
        if (fwd && bwd) continue;
        const kind: PassageKind = fwd ? "forward" : bwd ? "backward" : "none";
        let oneWayDir: { dx: number; dy: number } | undefined;
        const edge = getFaceEdgeSegment([n.x, n.y], face, cfg);
        if (kind !== "none" && edge) {
          const center = getCellCenter(n.x, n.y, cfg);
          const outX = edge.contact.x - center.x;
          const outY = edge.contact.y - center.y;
          const len = Math.hypot(outX, outY);
          if (len > 0) oneWayDir = kind === "forward" ? { dx: outX / len, dy: outY / len } : { dx: -outX / len, dy: -outY / len };
        }
        result.push({ a: [n.x, n.y], b: [px, py], face, kind, style: "solid", oneWayDir });
        continue;
      }
      if (!neighborless && cellSet.has(`${nx},${ny}`)) continue;
      // A split point has several nodes at the same (x,y) — dedupe so its boundary side isn't
      // pushed once per node.
      const boundaryKey = `${n.x},${n.y}->${nx},${ny}#${neighborless ? face : ""}`;
      if (boundaryDrawn.has(boundaryKey)) continue;
      boundaryDrawn.add(boundaryKey);
      result.push({ a: [n.x, n.y], b: [nx, ny], face: neighborless ? face : undefined, kind: "none", style: "solid" });
    }
  }

  return result;
}

/** World positions of every one-way wall indicator (`WallRenderer`'s chevron/arrow/triangle,
 *  centered on `WallEdge.oneWayDir`'s own segment midpoint — GitHub issue #518) — for the teleport
 *  connector router's own avoidance set, so an orthogonal connector doesn't visibly cut through a
 *  one-way indicator the same way it used to cut through start/finish before GitHub issue #300/#516.
 *  Mirrors `WallRenderer`'s private `getEdgeSegment`'s own logic (`getSharedEdgeSegment`) rather than
 *  duplicating it, so the position matches exactly where the indicator is actually drawn. */
export function buildOneWayWallIndicatorPositions(
  edges: WallEdge[],
  cfg: FieldConfig,
): [number, number][] {
  const result: [number, number][] = [];
  for (const edge of edges) {
    if (!edge.oneWayDir) continue;
    const seg = edge.face === undefined ? getSharedEdgeSegment(edge.a, edge.b, cfg) : getFaceEdgeSegment(edge.a, edge.face, cfg);
    if (!seg) continue;
    result.push([seg.contact.x, seg.contact.y]);
  }
  return result;
}
