import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { FieldConfig } from "../../../fieldConfig";
import type { MarkerIndexSettings } from "../../../store/imageExportTypes";
import { getCellCenter } from "../../tessellationGeometry";
import { formatIndexLabel } from "../../renderers/indexLabel";
import { elevatorComponent } from "../../postEditVerticalUtils";
import { NO_MARKER_SCALING, type MarkerScaler } from "../../markerScale";
import { teleportNodePairKey, type TeleportGroup } from "../teleportGroups";

/** Link kind of a cross-floor connection an index label hangs off. */
export type MarkerIndexLinkKind = "teleport" | "vertical" | "elevator";

/** What a link's endpoint marker looks like on the drawn floor — supplied by the mode renderer
 *  (which already resolved every teleport/vertical marker style, group overrides included), so
 *  this selector stays free of per-kind marker-settings knowledge. */
export interface MarkerEndpointVisual {
  /** Marker's visual outer radius in world px (`size / 2 + borderWidth`, `size` being a diameter —
   *  GitHub issue #681). */
  outerRadius: number;
  /** The part of `outerRadius` that marker size adaptation scales (GitHub issue #819) — the fill
   *  radius, i.e. `outerRadius` without the border ring. */
  fillRadius: number;
  /** The whole marker scales, border and gap ring included (vertical connections) — then
   *  `fillRadius` is ignored and `outerRadius`/`borderWidth` both scale. */
  scalesAsWhole?: boolean;
  /** The marker kind's own size-adaptation fraction (GitHub issue #819). */
  sizeAdaptation: number;
  /** Marker border thickness in whole pixels; the index plate mirrors it. */
  borderWidth: number;
  /** Color to use for the plate border when `borderColorFromMarker` is on: the marker's own
   *  border color if it has a border, else its fill color. */
  borderMatchColor: number;
}

/** Resolves the endpoint-marker visual for one node of a link on the drawn floor. The optional
 *  `oneWay` flag is set for one-way vertical passages so the renderer can select their distinct
 *  marker color/style. */
export type ResolveMarkerEndpointVisual = (
  nodeId: number,
  kind: MarkerIndexLinkKind,
  oneWay?: boolean,
) => MarkerEndpointVisual;

/** One index label to draw on the active floor. `pos` is the world-space center of the anchor
 *  cell; `markerOuterRadius` is that endpoint marker's visual outer radius (the plate center sits
 *  `style.offset` below it); `borderMatchColor` feeds `borderColorFromMarker`. */
export interface MarkerIndexLabel {
  pos: [number, number];
  /** Which link kind this label annotates — lets the marker layout (GitHub issue #735) move it with its marker. */
  kind: MarkerIndexLinkKind;
  label: string;
  markerOuterRadius: number;
  markerBorderWidth: number;
  borderMatchColor: number;
  /** Marker-layout shrink factor (GitHub issue #735) — the plate (size, offset, border, gap, text) shrinks with its marker. `undefined` = 1. */
  scale?: number;
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
  /** Whether a vertical passage has no reverse directed edge. */
  oneWay?: boolean;
  /** Teleport link standing for a whole teleport group (GitHub issue #871). */
  grouped?: boolean;
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
 *  `teleportGroups` (GitHub issue #871) are the project-wide teleport groups
 *  (`buildProjectTeleportGroups`, merge mode included): all teleports of one group take one index
 *  and one plate per cell. Without groups every teleport pair is its own link.
 *
 *  An elevator fan with several nodes in one cell of one floor yields a single plate there
 *  (dedup by `(level, x, y)`). Distinct links sharing a cell (a teleport and a staircase, say)
 *  stack — the issue only requires distinguishing elevators. */
export function buildMarkerIndexLabels(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: FieldConfig,
  activeFloorIndex: number,
  style: MarkerIndexSettings,
  resolveEndpointVisual: ResolveMarkerEndpointVisual,
  scaler: MarkerScaler = NO_MARKER_SCALING,
  teleportGroups: TeleportGroup[] = [],
): MarkerIndexLabelSet {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const levelOf = (id: number) => nodeById.get(id)?.level ?? 0;
  const cov = style.coverage;

  // --- Build links ---
  const links: Link[] = [];

  // teleport + vertical_passage: unordered endpoint pair, deduped across both directed edges.
  const groupKeyByEdge = new Map<string, string>();
  for (const g of teleportGroups) for (const k of g.edgeKeys) groupKeyByEdge.set(k, g.key);
  const groupLinks = new Map<string, Link>();
  const seenPair = new Map<string, Link>();
  const verticalPairs = new Set(
    edges.filter((e) => e.kind === "vertical_passage").map((e) => `${e.from}->${e.to}`),
  );
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
    // A teleport sharing a group with others (GitHub issue #871) joins the group's single link, so
    // every teleport of the group takes the same index.
    const groupKey = kind === "teleport" ? groupKeyByEdge.get(teleportNodePairKey(lo, hi)) : undefined;
    const grouped = groupKey !== undefined ? groupLinks.get(groupKey) : undefined;
    if (grouped) {
      for (const id of [lo, hi]) if (!grouped.nodeIds.includes(id)) grouped.nodeIds.push(id);
      seenPair.set(pairKey, grouped);
      continue;
    }
    const link: Link = {
      kind,
      nodeIds: [lo, hi],
      oneWay: kind === "vertical" && !verticalPairs.has(`${e.to}->${e.from}`),
      grouped: groupKey !== undefined,
    };
    if (groupKey !== undefined) groupLinks.set(groupKey, link);
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
      if (link.kind === "elevator" || link.grouped) {
        const cellKey = `${link.grouped ? i : "e"}:${node.level ?? 0}:${node.x},${node.y}`;
        if (dedup.has(cellKey)) continue;
        dedup.add(cellKey);
      }
      const center = getCellCenter(node.x, node.y, cfg);
      const visual = resolveEndpointVisual(id, link.kind, link.oneWay);
      const pos: [number, number] = [center.x, center.y];
      const factor = scaler.factorAt(pos, visual.sizeAdaptation);
      labels.push({
        pos,
        kind: link.kind,
        label,
        markerOuterRadius: visual.scalesAsWhole ? visual.outerRadius * factor : visual.outerRadius + visual.fillRadius * (factor - 1),
        markerBorderWidth: visual.scalesAsWhole ? visual.borderWidth * factor : visual.borderWidth,
        borderMatchColor: visual.borderMatchColor,
      });
    }
  });

  return { allLabelStrings, labels };
}

/** Plate body rectangle of one index label (before its border), in world px. */
export interface MarkerIndexPlateBox {
  x: number;
  y: number;
  w: number;
  h: number;
  cornerRadius: number;
  /** Whole pixels; the border is drawn *outside* the body rectangle. */
  borderWidth: number;
  /** Marker-layout shrink factor (GitHub issue #735) already applied to this box; the renderer also
   *  shrinks the gap ring and the caption text by it. */
  scale: number;
}

/** Where `MarkerIndexRenderer` draws `label`'s plate: a fixed `style.width` x `style.height`
 *  rectangle centered horizontally on the anchor, its center `style.offset` below the marker's
 *  outer edge. Shared with the export warnings, which test the plate against other geometry. */
export function markerIndexPlateBox(label: MarkerIndexLabel, style: MarkerIndexSettings): MarkerIndexPlateBox {
  const [cx, cy] = label.pos;
  const s = label.scale ?? 1;
  const w = style.width * s;
  const h = style.height * s;
  // `offset` is the distance from the marker's outer edge to the plate's *center*.
  const plateCenterY = cy + label.markerOuterRadius * s + style.offset * s;
  return {
    x: cx - w / 2,
    y: plateCenterY - h / 2,
    w,
    h,
    cornerRadius: style.cornerRadius * s,
    borderWidth: Math.max(0, Math.round((style.borderWidthFromMarker ? label.markerBorderWidth : style.borderWidth) * s)),
    scale: s,
  };
}
