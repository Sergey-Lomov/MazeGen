import type { NodeDto, EdgeDto } from "../../../wasm/types";
import { selectVerticalPassagePairSet } from "./vertical";

function formatFloor(level: number): string {
  return `L${level + 1}`;
}

/** A teleport/vertical-passage endpoint target, formatted per GitHub issue #353's contract: same-
 *  floor target shows plain cell coordinates, cross-floor target shows the floor label instead
 *  (never both — the floor is implied by the coordinate when they're on the active floor). */
function formatTarget(other: NodeDto, activeFloorLevel: number): string {
  const otherLevel = other.level ?? 0;
  return otherLevel === activeFloorLevel ? `(${other.x},${other.y})` : `(${formatFloor(otherLevel)})`;
}

/** Every marker-line contributed by one specific node — start/finish, teleport endpoints, and
 *  vertical passage/elevator markers anchored on this node's own id. `nodeById`/`edges` must be
 *  the *unscoped* (whole-maze) node/edge lists, same requirement `buildTeleportEdges`/
 *  `buildVerticalConnectionMarkers` already have — a cross-floor teleport's `to`, or a vertical
 *  passage's arrival end, only resolves through the unscoped lists. */
function buildNodeMarkerLines(
  node: NodeDto,
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  start: number | null,
  finish: number | null,
): string[] {
  const lines: string[] = [];
  if (start === node.id) lines.push("Start");
  if (finish === node.id) lines.push("Finish");

  const activeFloorLevel = node.level ?? 0;

  // Teleports — collapse a forward+backward pair between the same two nodes into one two-way
  // line, mirroring `buildTeleportEdges`'s own pairing (that function builds pixel positions for
  // drawing; this one only needs the logical direction/target, so re-deriving directly from
  // `edges` is simpler than reverse-engineering positions back into node ids).
  const seenTeleportPair = new Set<string>();
  for (const e of edges) {
    if (e.kind !== "teleport" || (e.from !== node.id && e.to !== node.id)) continue;
    const pairKey = e.from < e.to ? `${e.from},${e.to}` : `${e.to},${e.from}`;
    if (seenTeleportPair.has(pairKey)) continue;
    seenTeleportPair.add(pairKey);

    const departingHere = e.from === node.id;
    const otherId = departingHere ? e.to : e.from;
    const other = nodeById.get(otherId);
    if (!other) continue;
    const reverseExists = edges.some((r) => r.kind === "teleport" && r.from === e.to && r.to === e.from);
    const target = formatTarget(other, activeFloorLevel);
    const arrow = reverseExists ? "<->" : departingHere ? "->" : "<-";
    lines.push(`Teleport ${arrow} ${target}`);
  }

  // Vertical passages (one-way or two-way) and elevators (always two-way, fan out to several
  // floors from one node) — mirrors `buildVerticalConnectionMarkers`'s own from/arrival split.
  const verticalPairs = selectVerticalPassagePairSet(edges);
  const seenVerticalPair = new Set<string>();
  const elevatorTargetLevels: number[] = [];
  for (const e of edges) {
    if (e.kind !== "vertical_passage" && e.kind !== "elevator") continue;
    if (e.from !== node.id && e.to !== node.id) continue;

    if (e.kind === "elevator") {
      if (e.from !== node.id) continue; // elevator has no one-way arrival end to report separately
      const other = nodeById.get(e.to);
      if (other) elevatorTargetLevels.push(other.level ?? 0);
      continue;
    }

    const pairKey = e.from < e.to ? `${e.from},${e.to}` : `${e.to},${e.from}`;
    if (seenVerticalPair.has(pairKey)) continue;
    seenVerticalPair.add(pairKey);

    const departingHere = e.from === node.id;
    const otherId = departingHere ? e.to : e.from;
    const other = nodeById.get(otherId);
    if (!other) continue;
    const reverseExists = verticalPairs.has(`${e.to}->${e.from}`);
    const target = `(${formatFloor(other.level ?? 0)})`;
    const arrow = reverseExists ? "<->" : departingHere ? "->" : "<-";
    lines.push(`Vertical passage ${arrow} ${target}`);
  }
  if (elevatorTargetLevels.length > 0) {
    const sorted = [...new Set(elevatorTargetLevels)].sort((a, b) => a - b);
    lines.push(`Elevator (${sorted.map(formatFloor).join(", ")})`);
  }

  return lines;
}

/** Builds the cell-inspector status-bar line for the node(s) sitting at grid cell `(x, y)` on the
 *  given floor (GitHub issue #353) — one shared selector every feature-renderer's hover readout
 *  goes through (`maze-web/CLAUDE.md`'s feature-renderer ownership rule: no renderer reaches into
 *  another's own data, so this lives in the tessellation/render-agnostic selector layer instead,
 *  alongside `buildMazeMarkers`/`buildTeleportEdges`/etc.). `nodeById`/`edges` must be the
 *  *unscoped* (whole-maze) lists — same requirement every cross-floor-aware selector here already
 *  has, so a teleport/vertical marker landing on another floor resolves correctly regardless of
 *  which floor is currently active.
 *
 *  An ordinary (non-split) cell renders as `"x:3, y:5"` when it carries no marker at all, else
 *  `"x:3, y:5 | Start | Teleport -> (7,2)"` (`" | "`-joined marker lines). A split cell (more than
 *  one node at the same point, on the same floor) renders each node as its own `"[Node N: ...]"`
 *  block — `N` is `node.i + 1` (the point's original node first, then each slot in creation
 *  order, matching `NodeDto.i`'s own per-point index convention — see `Specs/post-edit.md`'s
 *  "Node-list duplication fix" section) — with an empty node spelled out as `"[Node N: empty]"`.
 *  A node's own marker lines are joined with `"; "` inside its brackets so that separator never
 *  collides with the `" | "` used between blocks/nodes at the outer level. */
export function buildCellInspection(
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  x: number,
  y: number,
  floorLevel: number,
  start: number | null,
  finish: number | null,
): string {
  const coordLabel = `x:${x}, y:${y}`;

  const nodesHere = Array.from(nodeById.values())
    .filter((n) => n.x === x && n.y === y && (n.level ?? 0) === floorLevel)
    .sort((a, b) => a.i - b.i);

  if (nodesHere.length === 0) return coordLabel;

  if (nodesHere.length === 1) {
    const lines = buildNodeMarkerLines(nodesHere[0], nodeById, edges, start, finish);
    return lines.length === 0 ? coordLabel : [coordLabel, ...lines].join(" | ");
  }

  const blocks = nodesHere.map((n) => {
    const lines = buildNodeMarkerLines(n, nodeById, edges, start, finish);
    const body = lines.length === 0 ? "empty" : lines.join("; ");
    return `[Node ${n.i + 1}: ${body}]`;
  });
  return [coordLabel, ...blocks].join(" | ");
}
