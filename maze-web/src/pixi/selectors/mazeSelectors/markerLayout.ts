import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../../fieldConfig";
import type { MarkerData, TeleportEdge, VerticalConnectionMarker } from "../../renderers/types";
import { buildNodePositions } from "../../tessellationGeometry";
import { TILE_SIZE } from "../../constants";
import type { MarkerIndexLabel, MarkerIndexLinkKind } from "./markerIndex";

/** Marker positioning layer (GitHub issue #735) — arranges several markers hosted by the same cell
 *  (or the same split-tile node) so they no longer stack on one point. See `Specs/marker-layout.md`. */
export type MarkerLayoutMode = "auto" | "row" | "grid" | "radial" | "overlap";

export const MARKER_LAYOUT_MODES: readonly MarkerLayoutMode[] = ["auto", "row", "grid", "radial", "overlap"];

/** Fixed gap (px) between the outer edges of neighboring laid-out markers — deliberately not a user
 *  setting: markers are rarely small enough for it to matter. */
export const MARKER_LAYOUT_SPACING = 2;

/** Defaults for the layout mode / shrink factor — used by the export settings defaults and, as fixed
 *  values, by the editor canvases (which expose no layout settings). */
export const DEFAULT_MARKER_LAYOUT_MODE: MarkerLayoutMode = "radial";
export const DEFAULT_MARKER_SCALE = 0.6;

export interface MarkerLayoutOptions {
  mode: MarkerLayoutMode;
  /** Gap (px) between the outer edges of two neighboring markers. */
  spacing: number;
  /** Shrink factor (0..1] for every marker in a host with 2+ markers (GitHub issue #735) — all
   *  components scale together. Omitted = 1. */
  scale?: number;
}

/** Layout bound: how far (from the host center) a laid-out marker's outer edge may reach. A plain
 *  cell hosts markers inside most of its own footprint; a split-tile node only owns a fraction of it. */
export const HOST_EXTENT_CELL = TILE_SIZE * 0.5;
export const HOST_EXTENT_SPLIT_NODE = TILE_SIZE * 0.35;
/** Over-large groups shrink their markers by `FIT_STEP` steps down to this fraction of the requested scale. */
const MIN_FIT_FACTOR = 0.3;
const FIT_STEP = 0.9;

/** Resolves `"auto"` to a concrete layout by marker count: 2 → row, 3–4 → radial, 5+ → grid. */
export function resolveLayoutMode(mode: MarkerLayoutMode, count: number): Exclude<MarkerLayoutMode, "auto"> {
  if (mode !== "auto") return mode;
  if (count <= 2) return "row";
  if (count <= 4) return "radial";
  return "grid";
}

/** Per-marker offsets from the host center, same order as `radii` (each the marker's own visible
 *  footprint radius). One marker (or none) → no offset. When the arranged group would reach past
 *  `maxExtent` from the host center, every offset is scaled toward the center until it fits (markers
 *  may then overlap slightly, but never leave the host). */
export function computeLayoutOffsets(
  radii: number[],
  mode: MarkerLayoutMode,
  spacing: number,
  maxExtent: number = Infinity,
): [number, number][] {
  const n = radii.length;
  if (n <= 1 || mode === "overlap") return radii.map(() => [0, 0]);
  const pitch = 2 * Math.max(...radii) + Math.max(spacing, 0);
  const resolved = resolveLayoutMode(mode, n);
  let offsets: [number, number][];
  if (resolved === "row") {
    offsets = radii.map((_, i) => [(i - (n - 1) / 2) * pitch, 0]);
  } else if (resolved === "grid") {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    offsets = radii.map((_, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      // A short last row is centered on its own, not left-aligned.
      const inRow = row === rows - 1 ? n - row * cols : cols;
      return [(col - (inRow - 1) / 2) * pitch, (row - (rows - 1) / 2) * pitch];
    });
  } else {
    // Ring radius such that neighboring markers on the circle are `pitch` apart (chord = pitch).
    const ring = pitch / (2 * Math.sin(Math.PI / n));
    // Start at the top and go clockwise (screen y grows downward).
    offsets = radii.map((_, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      return [Math.cos(a) * ring, Math.sin(a) * ring];
    });
  }
  let reach = 0;
  for (let i = 0; i < n; i++) reach = Math.max(reach, Math.hypot(offsets[i][0], offsets[i][1]) + radii[i]);
  if (reach > maxExtent && reach > 0) {
    // Only the offsets shrink, not the radii, so scale the center distances to fit the outer edge.
    const maxCenter = Math.max(...offsets.map((o) => Math.hypot(o[0], o[1])));
    const room = Math.max(maxExtent - Math.max(...radii), 0);
    const k = maxCenter > 0 ? Math.min(room / maxCenter, 1) : 1;
    offsets = offsets.map(([x, y]) => [x * k, y * k]);
  }
  return offsets;
}

/** Stable host identity for a world position — every marker kind resolves its node's position
 *  through the same `buildNodePositions`, so two markers on one node share this key exactly. */
export function hostKey(pos: [number, number]): string {
  return `${pos[0].toFixed(2)},${pos[1].toFixed(2)}`;
}

/** Position keys of hosts that are split-tile nodes (a cell holding more than one node) — their
 *  hub points differ from the plain cell center and own only part of the tile, so the layout bounds
 *  them to `HOST_EXTENT_SPLIT_NODE`. */
export function buildSplitHostKeys(
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  cfg: TessellationConfig,
): Set<string> {
  const nodes = Array.from(nodeById.values());
  const perCell = new Map<string, number>();
  for (const nd of nodes) {
    const k = `${nd.level ?? 0}:${nd.x},${nd.y}`;
    perCell.set(k, (perCell.get(k) ?? 0) + 1);
  }
  if (![...perCell.values()].some((c) => c > 1)) return new Set();
  const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
  const nodePos = buildNodePositions(nodes, cfg, directedPairs);
  const out = new Set<string>();
  for (const nd of nodes) {
    if ((perCell.get(`${nd.level ?? 0}:${nd.x},${nd.y}`) ?? 0) <= 1) continue;
    const p = nodePos.get(nd.id);
    if (p) out.add(hostKey([p.x, p.y]));
  }
  return out;
}

/** Visible footprint radius of one `MarkerData` (fill + border + gap), same convention as
 *  `markerWidenPatches`. */
export function markerFootprint(m: Pick<MarkerData, "radius" | "borderWidth" | "gapWidth">): number {
  return m.radius + (m.borderWidth ?? 0) + (m.gapWidth ?? 0);
}

export interface MarkerLayoutInput {
  /** Start/finish markers (order matters: earlier ones take earlier slots). */
  markers: MarkerData[];
  teleportEdges: TeleportEdge[];
  verticalMarkers: VerticalConnectionMarker[];
  /** Footprint radius of an ordinary teleport point / of a vertical marker (by index). */
  teleportRadius: number;
  verticalRadius: (m: VerticalConnectionMarker) => number;
  splitHostKeys?: Set<string>;
}

export interface MarkerLayoutResult {
  markers: MarkerData[];
  teleportEdges: TeleportEdge[];
  verticalMarkers: VerticalConnectionMarker[];
  /** Hosts that ended up with 2+ markers: laid-out centers + footprints, for the corridor widen's
   *  bridge patches (`buildGroupBridgeMarkers`). */
  groups: { host: [number, number]; items: { pos: [number, number]; radius: number }[] }[];
  /** Applied offset per `shiftKey(kind, original position)` — lets the marker index labels (which
   *  anchor on the plain node position) follow the marker they annotate (`shiftMarkerIndexLabels`). */
  shifts: Map<string, [number, number]>;
  /** Shrink factor per `shiftKey` (only entries with scale < 1) — lets the index plate shrink with its marker. */
  scales: Map<string, number>;
}

/** Key into `MarkerLayoutResult.shifts` — `kind` is a marker-index link kind. */
export function shiftKey(kind: MarkerIndexLinkKind, pos: [number, number]): string {
  return `${kind}:${hostKey(pos)}`;
}

/** Same-kind markers on one host share a `shiftKey`; the n-th repeat (in marker/label order) gets a
 *  `#n` suffix so each keeps its own shift. The first occurrence keeps the bare key. */
function nextOccurrence(): (key: string) => string {
  const seen = new Map<string, number>();
  return (key) => {
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? key : `${key}#${n}`;
  };
}

/** Moves each marker index label by its marker's layout offset (see `MarkerLayoutResult.shifts`).
 *  Labels with no matching shifted marker are returned unchanged. */
export function shiftMarkerIndexLabels(labels: MarkerIndexLabel[], shifts: Map<string, [number, number]>, scales?: Map<string, number>): MarkerIndexLabel[] {
  if (shifts.size === 0) return labels;
  const nth = nextOccurrence();
  return labels.map((l) => {
    const key = nth(shiftKey(l.kind, l.pos));
    const d = shifts.get(key);
    if (!d) return l;
    const scale = scales?.get(key);
    return { ...l, pos: [l.pos[0] + d[0], l.pos[1] + d[1]], ...(scale !== undefined ? { scale } : {}) };
  });
}

/** Scales every size component of a marker (radius, border, gap, caption text) by `scale`. */
function scaleMarkerData(m: MarkerData, scale: number): MarkerData {
  if (scale >= 1) return m;
  return {
    ...m,
    radius: m.radius * scale,
    borderWidth: m.borderWidth === undefined ? undefined : m.borderWidth * scale,
    gapWidth: m.gapWidth === undefined ? undefined : m.gapWidth * scale,
    textSize: m.textSize === undefined ? undefined : m.textSize * scale,
  };
}

type Slot = { kind: "marker" | "teleport" | "vertical"; index: number; radius: number };

/** Applies the marker positioning layer. Markers sharing a host (same node position) get distinct
 *  slots in this order: start/finish, the teleport point, vertical markers. Pure — inputs are not
 *  mutated, untouched items are returned by reference. Cross-floor teleport badge ends are left in
 *  place (they carry their own collision relocation, issue #480). A teleport point shared by several
 *  edges (one node, many teleports) is one slot and moves as one. */
export function applyMarkerLayout(input: MarkerLayoutInput, opts: MarkerLayoutOptions): MarkerLayoutResult {
  const hosts = new Map<string, { pos: [number, number]; slots: Slot[] }>();
  const slotsOf = (pos: [number, number]) => {
    const k = hostKey(pos);
    let h = hosts.get(k);
    if (!h) { h = { pos, slots: [] }; hosts.set(k, h); }
    return h.slots;
  };

  input.markers.forEach((m, index) => slotsOf(m.pos).push({ kind: "marker", index, radius: markerFootprint(m) }));
  const teleportHostSeen = new Set<string>();
  const teleportEnds: { edge: number; end: "from" | "to" }[] = [];
  input.teleportEdges.forEach((e, edge) => {
    for (const end of ["from", "to"] as const) {
      if ((end === "from" ? e.fromFloor : e.toFloor) !== undefined) continue;
      const pos = e[end];
      const k = hostKey(pos);
      teleportEnds.push({ edge, end });
      if (teleportHostSeen.has(k)) continue;
      teleportHostSeen.add(k);
      slotsOf(pos).push({ kind: "teleport", index: -1, radius: input.teleportRadius });
    }
  });
  input.verticalMarkers.forEach((m, index) => slotsOf(m.pos).push({ kind: "vertical", index, radius: input.verticalRadius(m) }));

  const markers = [...input.markers];
  const verticalMarkers = [...input.verticalMarkers];
  const teleportShift = new Map<string, [number, number]>();
  const teleportScale = new Map<string, number>();
  const groups: MarkerLayoutResult["groups"] = [];
  const shifts = new Map<string, [number, number]>();
  const scales = new Map<string, number>();

  const nthVertical = nextOccurrence();
  const baseScale = Math.min(Math.max(opts.scale ?? 1, 0.01), 1);
  for (const [key, host] of hosts) {
    if (host.slots.length < 2 || opts.mode === "overlap") continue;
    const extent = input.splitHostKeys?.has(key) ? HOST_EXTENT_SPLIT_NODE : HOST_EXTENT_CELL;
    // A group that doesn't fit its host shrinks its markers further (down to `MIN_FIT_FACTOR`) before
    // `computeLayoutOffsets` has to squeeze the centers together, so markers don't pile up on a tight
    // host such as a split-tile node.
    let scale = baseScale;
    const reachAt = (sc: number) => {
      const radii = host.slots.map((s) => s.radius * sc);
      const raw = computeLayoutOffsets(radii, opts.mode, opts.spacing);
      return Math.max(...raw.map(([x, y], i) => Math.hypot(x, y) + radii[i]));
    };
    while (scale > baseScale * MIN_FIT_FACTOR && reachAt(scale) > extent) scale = Math.max(scale * FIT_STEP, baseScale * MIN_FIT_FACTOR);
    const offsets = computeLayoutOffsets(host.slots.map((s) => s.radius * scale), opts.mode, opts.spacing, extent);
    const items: { pos: [number, number]; radius: number }[] = [];
    host.slots.forEach((slot, i) => {
      const [dx, dy] = offsets[i];
      const pos: [number, number] = [host.pos[0] + dx, host.pos[1] + dy];
      items.push({ pos, radius: slot.radius * scale });
      if (slot.kind === "marker") markers[slot.index] = scaleMarkerData({ ...markers[slot.index], pos }, scale);
      else if (slot.kind === "vertical") {
        const vm = input.verticalMarkers[slot.index];
        verticalMarkers[slot.index] = scale < 1 ? { ...vm, pos, scale } : { ...vm, pos };
        const sk = nthVertical(shiftKey(vm.kind === "elevator" ? "elevator" : "vertical", host.pos));
        shifts.set(sk, [dx, dy]);
        if (scale < 1) scales.set(sk, scale);
      } else {
        teleportShift.set(key, [dx, dy]);
        if (scale < 1) teleportScale.set(key, scale);
        shifts.set(shiftKey("teleport", host.pos), [dx, dy]);
        if (scale < 1) scales.set(shiftKey("teleport", host.pos), scale);
      }
    });
    groups.push({ host: host.pos, items });
  }

  let teleportEdges = input.teleportEdges;
  if (teleportShift.size > 0) {
    teleportEdges = input.teleportEdges.map((e) => ({ ...e }));
    for (const { edge, end } of teleportEnds) {
      const k = hostKey(input.teleportEdges[edge][end]);
      const shift = teleportShift.get(k);
      if (!shift) continue;
      const p = input.teleportEdges[edge][end];
      teleportEdges[edge][end] = [p[0] + shift[0], p[1] + shift[1]];
      const sc = teleportScale.get(k);
      if (sc !== undefined) teleportEdges[edge][end === "from" ? "fromScale" : "toScale"] = sc;
    }
  }
  return { markers, teleportEdges, verticalMarkers, groups, shifts, scales };
}

/** Extra circular "bridge" markers for the corridor widen patch (GitHub issue #735): each pair of
 *  neighboring laid-out markers in a group gets one at their midpoint, so the widened corridor stays
 *  one continuous band through the group instead of separate bulges with a narrow neck between. A pair
 *  counts as neighbors when its center distance is within 1.01 × the group's closest pair distance. */
export function buildGroupBridgeMarkers(groups: MarkerLayoutResult["groups"]): MarkerData[] {
  const out: MarkerData[] = [];
  for (const g of groups) {
    const { items } = g;
    let nearest = Infinity;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        nearest = Math.min(nearest, Math.hypot(items[i].pos[0] - items[j].pos[0], items[i].pos[1] - items[j].pos[1]));
      }
    }
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const d = Math.hypot(items[i].pos[0] - items[j].pos[0], items[i].pos[1] - items[j].pos[1]);
        if (d > nearest * 1.01) continue;
        out.push({
          pos: [(items[i].pos[0] + items[j].pos[0]) / 2, (items[i].pos[1] + items[j].pos[1]) / 2],
          radius: Math.min(items[i].radius, items[j].radius),
          color: 0,
          shape: "circle",
        });
      }
    }
  }
  return out;
}
