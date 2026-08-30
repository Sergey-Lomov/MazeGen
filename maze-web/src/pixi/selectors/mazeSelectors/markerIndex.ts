import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../../fieldConfig";
import type { MarkerIndexSettings } from "../../../store/imageExportTypes";
import { getCellCenter } from "../../tessellationGeometry";
import { formatIndexLabel } from "../../renderers/indexLabel";
import { elevatorComponent } from "../../postEditVerticalUtils";

/** Link kind of a cross-floor connection an index label hangs off. */
export type MarkerIndexLinkKind = "teleport" | "vertical" | "elevator";

/** What a link's endpoint marker looks like on the drawn floor — supplied by the mode renderer
 *  (which already resolved every teleport/vertical marker style, group overrides included), so
 *  this selector stays free of per-kind marker-settings knowledge. */
export interface MarkerEndpointVisual {
  /** Marker's visual outer radius in world px (`size * TILE_SIZE + borderWidth`). */
  outerRadius: number;
  /** Color to use for the plate border when `borderColorFromMarker` is on: the marker's own
   *  border color if it has a border, else its fill color. */
  borderMatchColor: number;
}

/** Resolves the endpoint-marker visual for one node of a link on the drawn floor. */
export type ResolveMarkerEndpointVisual = (
  nodeId: number,
  kind: MarkerIndexLinkKind,
) => MarkerEndpointVisual;

/** One index label to draw on the active floor. `pos` is the world-space center of the anchor
 *  cell; `markerOuterRadius` is that endpoint marker's visual outer radius (the plate center sits
 *  `style.offset` below it); `borderMatchColor` feeds `borderColorFromMarker`. */
export interface MarkerIndexLabel {
  pos: [number, number];
  label: string;
  markerOuterRadius: number;
  borderMatchColor: number;
}

export interface MarkerIndexLabelSet {
  /** Every project index label string, `1..N` formatted — the renderer sizes the (uniform) plate
   *  width to the widest of these so a given index looks identical on every floor. */
  allLabelStrings: string[];
  /** Labels to draw on the currently active floor. */
  labels: MarkerIndexLabel[];
}

interface Link {
  kind: MarkerIndexLinkKind;
  /** Every node id that is an endpoint of this link. */
  nodeIds: number[];
}

/** Canonical sort key for a link: its kind, then its endpoints sorted by `(level, nodeId)`.
 *  Direction-independent and stable under any input reordering. */
function linkSortKey(link: Link, levelOf: (id: number) => number): (number | string)[] {
  const kindRank = link.kind === "teleport" ? 0 : link.kind === "vertical" ? 1 : 2;
  const sorted = [...link.nodeIds].sort((a, b) => (levelOf(a) - levelOf(b)) || (a - b));
  const key: (number | string)[] = [kindRank];
  for (const id of sorted) {
    key.push(levelOf(id), id);
  }
  return key;
}

function compareKeys(a: (number | string)[], b: (number | string)[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

/** "Marker indices" (GitHub issue #471) — links the two endpoints of every cross-floor connection
 *  (teleport / vertical passage / elevator) with a shared numeric index so a player matching
 *  per-floor images can tell where each staircase, elevator or teleport leads.
 *
 *  Link identity is direction-independent: a teleport / vertical passage is its unordered endpoint
 *  node pair (a bidirectional pair of directed edges collapses to one link); an elevator is its
 *  connected component of `elevator` edges (a fan spanning 3+ floors → one index for the whole
 *  elevator). Links are numbered `1..N` by `linkSortKey` (endpoint `node.level`, then `nodeId`),
 *  deterministic regardless of node/edge input order. `style.coverage` filters which kinds are
 *  built at all — a filtered-out kind takes no index (numbering closes up over what remains); a
 *  `teleport` link is `crossFloorTeleport` when its endpoints differ in `node.level`, else
 *  `singleFloorTeleport`.
 *
 *  Takes the *unscoped* `nodes`/`edges` (cross-floor edges never survive `selectFloorScopedMaze`
 *  intact). `activeFloorIndex` is the 0-based `node.level` of the floor being drawn.
 *  `resolveEndpointVisual` is supplied by the mode renderer — it knows each endpoint marker's real
 *  outer radius and border/fill color (group overrides included); this selector does not.
 *
 *  An elevator fan with several nodes in one cell of one floor yields a single plate there
 *  (dedup by `(level, x, y)`). Distinct links sharing a cell (a teleport and a staircase, say)
 *  stack — the issue only requires distinguishing elevators. */
export function buildMarkerIndexLabels(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: TessellationConfig,
  activeFloorIndex: number,
  style: MarkerIndexSettings,
  resolveEndpointVisual: ResolveMarkerEndpointVisual,
): MarkerIndexLabelSet {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const levelOf = (id: number) => nodeById.get(id)?.level ?? 0;
  const cov = style.coverage;

  // --- Build links ---
  const links: Link[] = [];

  // teleport + vertical_passage: unordered endpoint pair, deduped across both directed edges.
  const seenPair = new Map<string, Link>();
  for (const e of edges) {
    if (e.kind !== "teleport" && e.kind !== "vertical_passage") continue;
    if (!nodeById.has(e.from) || !nodeById.has(e.to)) continue;
    const lo = Math.min(e.from, e.to);
    const hi = Math.max(e.from, e.to);
    const kind: MarkerIndexLinkKind = e.kind === "teleport" ? "teleport" : "vertical";
    if (kind === "teleport") {
      const crossFloor = levelOf(lo) !== levelOf(hi);
      if (crossFloor ? !cov.crossFloorTeleport : !cov.singleFloorTeleport) continue;
    } else if (!cov.verticalPassage) {
      continue;
    }
    const pairKey = `${kind}:${lo},${hi}`;
    if (seenPair.has(pairKey)) continue;
    const link: Link = { kind, nodeIds: [lo, hi] };
    seenPair.set(pairKey, link);
    links.push(link);
  }

  // elevator: one link per connected component.
  const elevatorNodeIds = new Set<number>();
  if (cov.elevator) for (const e of edges) {
    if (e.kind !== "elevator") continue;
    if (nodeById.has(e.from)) elevatorNodeIds.add(e.from);
    if (nodeById.has(e.to)) elevatorNodeIds.add(e.to);
  }
  const visited = new Set<number>();
  for (const id of elevatorNodeIds) {
    if (visited.has(id)) continue;
    const component = elevatorComponent(edges, [id]);
    const componentIds: number[] = [];
    for (const cid of component) {
      visited.add(cid);
      if (nodeById.has(cid)) componentIds.push(cid);
    }
    if (componentIds.length > 0) links.push({ kind: "elevator", nodeIds: componentIds });
  }

  // --- Number links 1..N by canonical order ---
  const keyed = links.map((link) => ({ link, key: linkSortKey(link, levelOf) }));
  keyed.sort((a, b) => compareKeys(a.key, b.key));

  const allLabelStrings = keyed.map((_, i) => formatIndexLabel(i, style.labelStyle));

  // --- Labels for the active floor ---
  const labels: MarkerIndexLabel[] = [];
  const dedup = new Set<string>();
  keyed.forEach(({ link }, i) => {
    const label = formatIndexLabel(i, style.labelStyle);
    for (const id of link.nodeIds) {
      const node = nodeById.get(id);
      if (!node || (node.level ?? 0) !== activeFloorIndex) continue;
      if (link.kind === "elevator") {
        const cellKey = `${node.level ?? 0}:${node.x},${node.y}`;
        if (dedup.has(cellKey)) continue;
        dedup.add(cellKey);
      }
      const center = getCellCenter(node.x, node.y, cfg);
      const visual = resolveEndpointVisual(id, link.kind);
      labels.push({
        pos: [center.x, center.y],
        label,
        markerOuterRadius: visual.outerRadius,
        borderMatchColor: visual.borderMatchColor,
      });
    }
  });

  return { allLabelStrings, labels };
}
