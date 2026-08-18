import type { TeleportEdge } from "./types";
import { getConnectorAxes, SQUARE_AXES, type Axis } from "./teleportConnectorAxes";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { getCellVertices, type Pos } from "../tessellationGeometry";
import type { RoutedConnector } from "./teleportConnectorRouting";
import { chooseOrthogonalPaths, segmentsOverlap, type Segment } from "./teleportPathSelection";

export { axisIntersection, pointToSegmentDistance } from "./teleportGeometryUtils";

/** Structural cache key for one `route()` call — cheap (O(edge count)) relative to the routing
 *  itself (O(edge count² × axis count²) for the first pass alone), so building it fresh on every
 *  call and comparing by value is not a meaningful cost even at realistic teleport counts (see
 *  GitHub issue #297 follow-up discussion): a caller that rebuilds its own `TeleportEdge[]` array
 *  from scratch every render (a fresh object, same content) still gets a cache hit here, without
 *  requiring that caller to keep a stable array reference itself. */
function cacheKey(
  edges: TeleportEdge[],
  gap: number,
  maxEndpointOffset: number,
  cfg: TessellationConfig | undefined,
  endpointStyle: EndpointMarkerStyle | undefined,
  waypoints: [number, number][],
  avoidFieldExit: boolean,
  fieldCells: [number, number][],
): string {
  const cfgKey = cfg === undefined ? "" : `${cfg.type}:${(cfg as { orientation?: string }).orientation ?? ""}`;
  const endpointStyleKey =
    endpointStyle === undefined
      ? ""
      : `${endpointStyle.markerRadius},${endpointStyle.markerBorderWidth},${endpointStyle.connectorGapWidth},${endpointStyle.connectorWidth}`;
  let edgesKey = "";
  for (const e of edges) {
    edgesKey += `${e.from[0]},${e.from[1]},${e.to[0]},${e.to[1]},${e.oneWay ? 1 : 0}|`;
  }
  let waypointsKey = "";
  for (const w of waypoints) waypointsKey += `${w[0]},${w[1]}|`;
  let fieldCellsKey = "";
  if (avoidFieldExit) {
    for (const c of fieldCells) fieldCellsKey += `${c[0]},${c[1]}|`;
  }
  return `${gap}|${maxEndpointOffset}|${cfgKey}|${endpointStyleKey}|${edgesKey}|${waypointsKey}|${avoidFieldExit ? 1 : 0}|${fieldCellsKey}`;
}

/** The style knobs `endpointCollisionRadius` derives its radius from — everything that visually
 *  contributes to a teleport marker's own on-screen footprint (GitHub issue #297 follow-up): the
 *  marker's fill radius, its own border, the connector line's gap, and half the connector
 *  line's own width (a stroke extends outward from its centerline by half its width). */
export type EndpointMarkerStyle = {
  markerRadius: number;
  markerBorderWidth: number;
  connectorGapWidth: number;
  connectorWidth: number;
};

/** The effective radius (world-space units) a connector path is considered to "cut through" a
 *  teleport marker within — sum of every style knob that visually extends the marker's footprint
 *  (see `EndpointMarkerStyle`), then padded 25% (GitHub issue #297 follow-up: a purely additive sum
 *  under-reads as "just touching" the marker's own edge, not a visually-clean pass-by; the extra
 *  margin keeps a colliding path from ever looking like it's grazing the marker's exact boundary). */
function endpointCollisionRadius(style: EndpointMarkerStyle): number {
  return (style.markerRadius + style.markerBorderWidth + style.connectorGapWidth + style.connectorWidth / 2) * 1.25;
}

/** Half the connector line's own drawn width (GitHub issue #300 follow-up) — `connectorWidth / 2 +
 *  connectorGapWidth`, the distance from the centerline out to the visible outer edge of its
 *  gap (see `TeleportRenderer`'s own `connectorWidth + connectorGapWidth * 2` full-width draw
 *  call). Used by `candidateLeavesField` so "leaves the field" means the *drawn* line's own edge
 *  crosses the field boundary, not just its infinitely-thin centerline. */
function fieldExitLineHalfWidth(style: EndpointMarkerStyle | undefined): number {
  return style === undefined ? 0 : style.connectorWidth / 2 + style.connectorGapWidth;
}

/** Routes teleport connectors that bend along a single perpendicular corner (GitHub issue #293's
 *  `"orthogonal"` `TeleportConnectorStyle`), avoiding collisions between connectors that share a
 *  corridor (GitHub issue #297: bend axes follow the active tessellation's own face normals, not a
 *  fixed 90°). Owns the whole collision-avoidance computation (candidate generation, greedy
 *  selection + refinement passes, corridor clustering/offset) as a single entity so every caller
 *  goes through the same routing + the same result cache, instead of each `TeleportRenderer`
 *  instance (or a plain module-level function) recomputing from scratch on every `render()` call
 *  even when nothing about the connectors actually changed. */
export class TeleportConnectorRouter {
  private lastKey: string | null = null;
  private lastResult: RoutedConnector[] = [];

  /** Routes every `edges` entry as a single-bend orthogonal path (see `chooseOrthogonalPaths`), then
   *  offsets each segment perpendicular to itself by `gap * (localIndex - (localCount - 1) / 2)`,
   *  where `localIndex`/`localCount` come from clustering same-axis, same-`fixed`-coordinate,
   *  overlapping-span segments across every connector via union-find — segments that don't overlap
   *  anything stay in a cluster of size 1 (zero offset), so the vast majority of connectors (which
   *  don't share a corridor with anything) draw exactly on-grid, only genuinely colliding runs fan
   *  out. Each connector's own bend point is nudged to the average of its two segments' individual
   *  offsets so the two segments still visually connect (their own offsets can differ since they
   *  belong to different clusters). `maxEndpointOffset` (the teleport marker's own drawn radius, when
   *  given) clamps only the start/end points' own nudge — a large cluster can otherwise offset a
   *  connector's endpoint far enough to visibly drift outside its teleport marker's shape; the bend
   *  point (mid-path, no marker to stay inside) is never clamped. `cfg` drives the tessellation's own
   *  candidate bend directions (see `getConnectorAxes`, GitHub issue #297) — square's original 2-axis
   *  (horizontal/vertical) behavior when omitted, for callers that don't have a `TessellationConfig`
   *  in hand. `endpointStyle` (when given) weights a candidate that would cut through another
   *  connector's own marker (see `endpointCollisionRadius`) at `ENDPOINT_COLLISION_WEIGHT`× an
   *  ordinary mid-path collision — omitted entirely (falls back to a zero radius, so no candidate
   *  is ever weighted up, since `candidateCutsThroughEndpoint` is only checked when `endpointRadius >
   *  0`) for callers that don't have marker style in hand. `waypoints` (GitHub issue #300, world
   *  positions of the start/finish markers) are always weighted the same way as another connector's
   *  own endpoint, independent of `avoidFieldExit`. `avoidFieldExit` (GitHub issue #300), when on,
   *  adds a top-priority penalty (outranking every other weight) to any candidate that leaves the
   *  maze field's own cell footprint — `fieldCells` (the maze's own node cell coordinates) is what
   *  that check is built from; omitted/empty with `avoidFieldExit` on is the same as leaving the
   *  toggle off (nothing to be outside of). The check is against the connector's own *drawn* line
   *  width, not an infinitely-thin centerline (GitHub issue #300 follow-up) — `fieldExitLineHalfWidth`
   *  derives that half-width (`connectorWidth / 2 + connectorGapWidth`) from the same
   *  `endpointStyle` passed in, so a caller that omits `endpointStyle` gets a centerline-only check.
   *
   *  Caches the result against a structural key (`cacheKey`, cheap relative to the routing itself)
   *  of `(edges, gap, maxEndpointOffset, cfg, endpointStyle, waypoints, avoidFieldExit, fieldCells)`
   *  — a repeat call with an equal-by-value input (even a freshly-rebuilt `edges` array, same
   *  content) reuses the previous result rather than re-running collision routing. */
  route(
    edges: TeleportEdge[],
    gap: number,
    maxEndpointOffset = Infinity,
    cfg?: TessellationConfig,
    endpointStyle?: EndpointMarkerStyle,
    waypoints: [number, number][] = [],
    avoidFieldExit = false,
    fieldCells: [number, number][] = [],
  ): RoutedConnector[] {
    const key = cacheKey(edges, gap, maxEndpointOffset, cfg, endpointStyle, waypoints, avoidFieldExit, fieldCells);
    if (key === this.lastKey) return this.lastResult;

    const result = this.computeRoute(edges, gap, maxEndpointOffset, cfg, endpointStyle, waypoints, avoidFieldExit, fieldCells);
    this.lastKey = key;
    this.lastResult = result;
    return result;
  }

  private computeRoute(
    edges: TeleportEdge[],
    gap: number,
    maxEndpointOffset: number,
    cfg: TessellationConfig | undefined,
    endpointStyle: EndpointMarkerStyle | undefined,
    waypoints: [number, number][],
    avoidFieldExit: boolean,
    fieldCells: [number, number][],
  ): RoutedConnector[] {
    const axes = cfg !== undefined ? getConnectorAxes(cfg) : SQUARE_AXES;
    // Computed once per `route()` call (not once per candidate/pass comparison) — see this
    // constructor's own doc comment about the caller-requested "don't recompute every time".
    const endpointRadius = endpointStyle !== undefined ? endpointCollisionRadius(endpointStyle) : 0;
    const cellPolygons: Pos[][] =
      avoidFieldExit && cfg !== undefined
        ? fieldCells.map(([x, y]) => getCellVertices(x, y, cfg)).filter((v): v is Pos[] => v !== null)
        : [];
    const fieldExitHalfWidth = fieldExitLineHalfWidth(endpointStyle);
    const paths = chooseOrthogonalPaths(edges, axes, endpointRadius, waypoints, avoidFieldExit, cellPolygons, fieldExitHalfWidth);

    // Flatten to one entry per (connector, segment-within-path) for clustering.
    type Entry = { connectorIndex: number; segIndex: 0 | 1; segment: Segment };
    const entries: Entry[] = [];
    paths.forEach((path, connectorIndex) => {
      path.segments.forEach((segment, i) => entries.push({ connectorIndex, segIndex: i as 0 | 1, segment }));
    });

    const parent = entries.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (entries[i].connectorIndex === entries[j].connectorIndex) continue;
        if (segmentsOverlap(entries[i].segment, entries[j].segment)) union(i, j);
      }
    }

    const clusterMembers = new Map<number, number[]>();
    entries.forEach((_, i) => {
      const root = find(i);
      const members = clusterMembers.get(root) ?? [];
      members.push(i);
      clusterMembers.set(root, members);
    });

    // Stable per-cluster ordering (by connectorIndex) so the same input always assigns the same
    // offsets, independent of Map/array iteration order.
    const offsetByEntry = new Map<number, number>();
    for (const members of clusterMembers.values()) {
      const sorted = [...members].sort((a, b) => entries[a].connectorIndex - entries[b].connectorIndex);
      sorted.forEach((entryIndex, localIndex) => {
        offsetByEntry.set(entryIndex, gap * (localIndex - (sorted.length - 1) / 2));
      });
    }

    // A point's coordinate nudged perpendicular to `axis` (its own CCW normal, `(-uy, ux)`) by that
    // axis's own connector offset — generalizes the old square-only "h offsets y, v offsets x".
    const nudge = (x: number, y: number, axis: Axis, offset: number): [number, number] =>
      [x - axis.uy * offset, y + axis.ux * offset];

    return paths.map((path, connectorIndex) => {
      const [fx, fy] = edges[connectorIndex].from;
      const [tx, ty] = edges[connectorIndex].to;
      // `entries` was built by `paths.forEach` above, pushing exactly 2 entries (segIndex 0 then 1)
      // per connector in order — so a connector's own entry indices are always `connectorIndex * 2`
      // and `connectorIndex * 2 + 1`, no need to search `entries` for them.
      const offset0 = offsetByEntry.get(connectorIndex * 2) ?? 0;
      const offset1 = offsetByEntry.get(connectorIndex * 2 + 1) ?? 0;
      const axis0 = path.segments[0].axis;
      const axis1 = path.segments[1].axis;
      const clampedOffset0 = Math.max(-maxEndpointOffset, Math.min(maxEndpointOffset, offset0));
      const clampedOffset1 = Math.max(-maxEndpointOffset, Math.min(maxEndpointOffset, offset1));

      // `start` only belongs to segment 0, `end` only to segment 1 — each nudged by its own
      // segment's offset (clamped to stay within the endpoint's own teleport marker). `bend` is
      // shared by both segments, so it's nudged by both in sequence (each along its own segment's
      // axis normal) using the *unclamped* offset — it has no marker to stay inside.
      const [startX, startY] = nudge(fx, fy, axis0, clampedOffset0);
      const [endX, endY] = nudge(tx, ty, axis1, clampedOffset1);
      const [bendX0, bendY0] = nudge(path.bend[0], path.bend[1], axis0, offset0);
      const [bendX, bendY] = nudge(bendX0, bendY0, axis1, offset1);

      return { points: [startX, startY, bendX, bendY, endX, endY] };
    });
  }
}
