import type { GraphicsContext } from "pixi.js";
import { computeSquareCapPatch } from "../renderers/wallUtils";
import { computeMiterJunctionPatch } from "./vectorByCorridorsGeometry";
import type { CorridorPoint, CorridorSegmentInput } from "./vectorByCorridorsContour";

/** One cell of the line-style corridor network ("legacy_line" round, and miter in both rendering
 *  modes), split per cell so identical cells share one drawn shape (GitHub issue #736). `ports` are
 *  relative to the cell centre (`offset`): the midpoint of every corridor segment leaving the cell,
 *  or the segment's split-side end (`v1TouchesSplit`), which belongs to its `v0` cell alone. Tiles
 *  with equal `key` have equal ports. */
export type CorridorLineTile = { cellId: string; key: string; offset: CorridorPoint; ports: CorridorPoint[] };

const KEY_QUANTUM = 1e-6;
const keyPoint = (point: CorridorPoint): string => Math.round(point.x / KEY_QUANTUM) + "," + Math.round(point.y / KEY_QUANTUM);

/** Splits centre-to-centre corridor segments into per-cell tiles. Each segment is cut at its own
 *  midpoint, so the two halves stay collinear and the network draws exactly as the chained stroke
 *  did: a chained path only ever bends at a cell centre. Keys include `width` and `join`, so tiles
 *  drawn with different styles never share a key. */
export function buildCorridorLineTiles(segments: readonly CorridorSegmentInput[], width: number, join: "round" | "miter"): CorridorLineTile[] {
  const keyPrefix = join + "/" + width + "@";
  const tiles = new Map<string, { centre: CorridorPoint; ports: CorridorPoint[] }>();
  const addPort = (centre: CorridorPoint, port: CorridorPoint): void => {
    const id = keyPoint(centre);
    const tile = tiles.get(id) ?? { centre, ports: [] };
    tile.ports.push({ x: port.x - centre.x, y: port.y - centre.y });
    tiles.set(id, tile);
  };
  for (const segment of segments) {
    if (Math.hypot(segment.v1.x - segment.v0.x, segment.v1.y - segment.v0.y) < 1e-6) continue;
    if (segment.v1TouchesSplit) {
      addPort(segment.v0, segment.v1);
    } else {
      const midpoint = { x: (segment.v0.x + segment.v1.x) / 2, y: (segment.v0.y + segment.v1.y) / 2 };
      addPort(segment.v0, midpoint);
      addPort(segment.v1, midpoint);
    }
  }
  return [...tiles].map(([cellId, tile]) => ({
    cellId,
    key: keyPrefix + tile.ports.map(keyPoint).sort().join("|"),
    offset: tile.centre,
    ports: tile.ports,
  }));
}

/** Draws one line tile around the origin in white (tinted by the caller). Equivalent, inside the
 *  cell, to the chained-path stroke the tile replaces:
 *  - `"round"`: every port as a `butt` line from the centre plus a centre disc — the union a round
 *    join (degree 2) or a round free-end/junction cap (any other degree) draws there.
 *  - `"miter"`: a degree-2 cell as one miter-joined polyline; a dead end gets a square cap at the
 *    centre (`computeSquareCapPatch`); a junction of 3+ lines gets `computeMiterJunctionPatch` wedges. */
export function traceCorridorLineTile(context: GraphicsContext, ports: readonly CorridorPoint[], width: number, join: "round" | "miter"): GraphicsContext {
  const origin = { x: 0, y: 0 };
  const stroke = { width, color: 0xffffff, join, cap: "butt" as const };
  if (join === "miter" && ports.length === 2) {
    return context.moveTo(ports[0].x, ports[0].y).lineTo(0, 0).lineTo(ports[1].x, ports[1].y).stroke(stroke);
  }
  for (const port of ports) context.moveTo(0, 0).lineTo(port.x, port.y);
  context.stroke(stroke);
  if (join === "round") return context.circle(0, 0, width / 2).fill(0xffffff);
  if (ports.length === 1) {
    const [p0, p1, p2, p3] = computeSquareCapPatch(origin, ports[0], width);
    return context.moveTo(p0.x, p0.y).lineTo(p1.x, p1.y).lineTo(p2.x, p2.y).lineTo(p3.x, p3.y).closePath().fill(0xffffff);
  }
  // Same ray directions the chained-path renderer used: junction minus the path's next point,
  // i.e. from the port toward the centre.
  for (const wedge of computeMiterJunctionPatch(ports.map((port) => ({ dir: { x: -port.x, y: -port.y }, width })))) {
    context.moveTo(wedge.points[0].x, wedge.points[0].y);
    for (let i = 1; i < wedge.points.length; i++) context.lineTo(wedge.points[i].x, wedge.points[i].y);
    context.closePath().fill(0xffffff);
  }
  return context;
}
