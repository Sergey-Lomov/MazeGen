import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../../fieldConfig";
import { selectVerticalPassagePairSet } from "./vertical";
import { splitPointFaceKindsByNode } from "../../splitNodeGeometry";
import { splitNodeSemanticNamesFromKinds } from "../../splitNodeNames";
import { formatTargetLabel } from "../../targetLabel";
import * as m from "~/paraglide/messages";

/** Semantic split-node short label for `node` (e.g. "Cor1"), when its point's face configuration
 *  matches a recognized special-split topology, else `undefined` for a non-split point/generic
 *  fallback caller. `cfg` is `null` to skip resolution entirely (mirrors `buildCellInspection`'s
 *  own "no cfg = always generic 'Node N'" contract). Mirrors the preset/post-edit resolvers'
 *  `resolvePresetSplitNodeShortLabel`/`resolveSplitNodeShortLabel`, adapted to this selector's own
 *  raw `nodeById`/`edges` data shape (no `PostEditEndpoint`/`draftEdges` here). */
function resolveNodeSplitLabel(
  node: NodeDto,
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  cfg: TessellationConfig | null,
): string | undefined {
  if (!cfg) return undefined;
  const nodeLevel = node.level ?? 0;
  const pointNodes = Array.from(nodeById.values())
    .filter((n) => n.x === node.x && n.y === node.y && (n.level ?? 0) === nodeLevel)
    .sort((a, b) => a.i - b.i);
  if (pointNodes.length <= 1) return undefined;

  const floorNodes = Array.from(nodeById.values()).filter((n) => (n.level ?? 0) === nodeLevel);
  const byTile = new Map<string, NodeDto[]>();
  for (const n of floorNodes) {
    const k = `${n.x}:${n.y}`;
    const list = byTile.get(k);
    if (list) list.push(n); else byTile.set(k, [n]);
  }
  const directed = new Set(edges.filter((e) => e.kind !== "teleport").map((e) => `${e.from}->${e.to}`));
  const semanticNames = splitNodeSemanticNamesFromKinds(splitPointFaceKindsByNode(pointNodes, byTile, directed, cfg));
  const index = pointNodes.findIndex((n) => n.id === node.id);
  return semanticNames?.[index]?.short ?? m["post_edit.split_node_label_short"]({ slotId: node.i + 1 });
}

/** A teleport/vertical-passage endpoint target, formatted via the shared `formatTargetLabel`
 *  (GitHub issue #602) — same-floor target shows plain coordinates, cross-floor target shows the
 *  floor prefix too (GitHub issue #353's contract: same-floor omits the floor since it's implied
 *  by the coordinate; cross-floor needs it since the coordinate alone wouldn't disambiguate),
 *  plus the target's own split-node suffix when it lands on a split tile (GitHub issue #595's
 *  follow-up — this never resolved before). Wrapped in parens, matching this selector's own
 *  pre-existing convention for every marker line (not the bare-bubble convention `presetTargetLabel`/
 *  `postEditTargetLabel` use — this text is inline status-bar prose, not a UI bubble).
 *
 *  `floorOnly` (GitHub issue #595's compact-display follow-up): a vertical-passage/elevator target's
 *  x/y is always identical to the departure point's own — only the floor ever differs — so callers
 *  for those two kinds pass `true` to drop the coordinate pair and split-node suffix down to just
 *  `L{floor}`. Teleport targets keep the full display (their x/y can genuinely differ). */
function formatTarget(
  other: NodeDto,
  activeFloorLevel: number,
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  cfg: TessellationConfig | null,
  floorOnly = false,
): string {
  const otherLevel = other.level ?? 0;
  const crossFloor = otherLevel !== activeFloorLevel;
  const suffix = resolveNodeSplitLabel(other, nodeById, edges, cfg);
  return `(${formatTargetLabel([other.x, other.y], otherLevel, crossFloor, suffix, floorOnly)})`;
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
  cfg: TessellationConfig | null,
): string[] {
  const lines: string[] = [];
  if (start === node.id) lines.push(m["status.cell_start"]());
  if (finish === node.id) lines.push(m["status.cell_finish"]());

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
    const target = formatTarget(other, activeFloorLevel, nodeById, edges, cfg);
    const arrow = reverseExists ? "<->" : departingHere ? "->" : "<-";
    lines.push(m["status.cell_teleport"]({ arrow, target }));
  }

  // Vertical passages (one-way or two-way) and elevators (always two-way, fan out to several
  // floors from one node) — mirrors `buildVerticalConnectionMarkers`'s own from/arrival split.
  // Both are cross-floor by construction (the other end is never this node's own floor), so their
  // target always includes the floor prefix — no same-floor/cross-floor branch like teleports have.
  const verticalPairs = selectVerticalPassagePairSet(edges);
  const seenVerticalPair = new Set<string>();
  const elevatorTargets: NodeDto[] = [];
  for (const e of edges) {
    if (e.kind !== "vertical_passage" && e.kind !== "elevator") continue;
    if (e.from !== node.id && e.to !== node.id) continue;

    if (e.kind === "elevator") {
      if (e.from !== node.id) continue; // elevator has no one-way arrival end to report separately
      const other = nodeById.get(e.to);
      if (other) elevatorTargets.push(other);
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
    const target = formatTarget(other, activeFloorLevel, nodeById, edges, cfg, true);
    const arrow = reverseExists ? "<->" : departingHere ? "->" : "<-";
    lines.push(m["status.cell_vertical_passage"]({ arrow, target }));
  }
  if (elevatorTargets.length > 0) {
    const seenLevel = new Set<number>();
    const uniqueTargets = elevatorTargets.filter((t) => {
      const level = t.level ?? 0;
      if (seenLevel.has(level)) return false;
      seenLevel.add(level);
      return true;
    }).sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
    const targets = uniqueTargets.map((t) => formatTargetLabel([t.x, t.y], t.level ?? 0, true, resolveNodeSplitLabel(t, nodeById, edges, cfg), true));
    lines.push(m["status.cell_elevator"]({ targets: targets.join(", ") }));
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
 *  `"x:3, y:5 | Start | Teleport -> (7:2)"` (`" | "`-joined marker lines). A split cell (more than
 *  one node at the same point, on the same floor) renders each node as its own `"[Node N: ...]"`
 *  block — `N` is `node.i + 1` (the point's original node first, then each slot in creation
 *  order, matching `NodeDto.i`'s own per-point index convention — see `Specs/post-edit.md`'s
 *  "Node-list duplication fix" section) — with an empty node spelled out as `"[Node N: empty]"`.
 *  A node's own marker lines are joined with `"; "` inside its brackets so that separator never
 *  collides with the `" | "` used between blocks/nodes at the outer level. When the split point's
 *  face configuration matches a recognized special-split topology (GitHub issue #487), the node
 *  block is titled with the semantic node name (`"[Corridor: ...]"`) instead of `"[Node N: ...]"` —
 *  `cfg` is needed for that face-topology recognition; pass `null` to skip it (always "Node N"). */
export function buildCellInspection(
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  x: number,
  y: number,
  floorLevel: number,
  start: number | null,
  finish: number | null,
  cfg: TessellationConfig | null = null,
): string {
  const coordLabel = `x:${x}, y:${y}`;

  const nodesHere = Array.from(nodeById.values())
    .filter((n) => n.x === x && n.y === y && (n.level ?? 0) === floorLevel)
    .sort((a, b) => a.i - b.i);

  if (nodesHere.length === 0) return coordLabel;

  if (nodesHere.length === 1) {
    const lines = buildNodeMarkerLines(nodesHere[0], nodeById, edges, start, finish, cfg);
    return lines.length === 0 ? coordLabel : [coordLabel, ...lines].join(" | ");
  }

  // Semantic per-node names when this split point's face configuration matches a recognized
  // special-split topology (bridge, GitHub issue #487) — `null` otherwise, "Node N" for every node.
  let semanticNames: ReturnType<typeof splitNodeSemanticNamesFromKinds> = null;
  if (cfg) {
    const floorNodes = Array.from(nodeById.values()).filter((n) => (n.level ?? 0) === floorLevel);
    const byTile = new Map<string, NodeDto[]>();
    for (const n of floorNodes) {
      const k = `${n.x}:${n.y}`;
      const list = byTile.get(k);
      if (list) list.push(n); else byTile.set(k, [n]);
    }
    const directed = new Set(edges.filter((e) => e.kind !== "teleport").map((e) => `${e.from}->${e.to}`));
    semanticNames = splitNodeSemanticNamesFromKinds(splitPointFaceKindsByNode(nodesHere, byTile, directed, cfg));
  }

  const blocks = nodesHere.map((n, index) => {
    const lines = buildNodeMarkerLines(n, nodeById, edges, start, finish, cfg);
    const body = lines.length === 0 ? m["status.cell_empty"]() : lines.join("; ");
    return `[${semanticNames?.[index]?.full ?? m["status.cell_node"]({ number: n.i + 1 })}: ${body}]`;
  });
  return [coordLabel, ...blocks].join(" | ");
}
