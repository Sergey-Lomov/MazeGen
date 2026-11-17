import type { NodeDto } from "../../../wasm/types";
import type { FieldConfig } from "../../../fieldConfig";
import { openingCutsWall, type WaypointOpeningMode } from "../../../store/imageExportTypes";
import type { WallEdge } from "../../renderers/types";
import { getCellCenter, getFaceEdgeSegment, getSharedEdgeSegment, getCellNeighborOffsets } from "../../tessellationGeometry";
import { getSeamModel } from "../seams";

/** One side of a cell that lies on the field's outer border (GitHub issue #330): no neighbour cell in
 *  the field and no glued partner across it. Mirrors the boundary-wall rule of `buildMazeWalls`. */
export interface OuterFace {
  /** Index of the side in the cell's neighbour offsets. */
  face: number;
  /** The cell the side leads to — outside the field; equals the cell itself for a side with no neighbour at all. */
  neighbor: [number, number];
  /** Where the wall segment of this side crosses the line from the cell centre outward. */
  contact: { x: number; y: number };
  /** The unit normal of the side pointing out of the field. */
  outward: { x: number; y: number };
  /** The side's flattened path — a curve for a curved tessellation's side — in the same space as `contact`. */
  polyline: readonly [number, number][];
  /** The on-screen direction of the side as seen from the cell (a side below the cell is "bottom"), to the nearest of eight — labels the side in the panel. */
  compass: OuterFaceCompass;
}

export type OuterFaceCompass = "right" | "bottom_right" | "bottom" | "bottom_left" | "left" | "top_left" | "top" | "top_right";
/** Indexed by the angle from the cell centre in 45° steps, clockwise on screen from "right" (display space is the screen: y grows downward, row 0 is at the bottom). */
const COMPASS: readonly OuterFaceCompass[] = ["right", "bottom_right", "bottom", "bottom_left", "left", "top_left", "top", "top_right"];

/** Every outer side of `cell`, in face order. `cellSet` holds the floor's cells as `"x,y"` keys. */
export function listOuterFaces(cell: [number, number], cellSet: Set<string>, cfg: FieldConfig): OuterFace[] {
  const seams = getSeamModel(cfg);
  const out: OuterFace[] = [];
  for (const [face, [dx, dy]] of getCellNeighborOffsets(cfg, cell[0], cell[1]).entries()) {
    const neighborless = dx === 0 && dy === 0;
    const neighbor: [number, number] = [cell[0] + dx, cell[1] + dy];
    if (seams.halfEdgeAt(cell, face)) continue;
    if (!neighborless && cellSet.has(cellKey(neighbor[0], neighbor[1]))) continue;
    const seg = neighborless ? getFaceEdgeSegment(cell, face, cfg) : getSharedEdgeSegment(cell, neighbor, cfg);
    if (!seg) continue;
    const center = getCellCenter(cell[0], cell[1], cfg);
    const sector = Math.round(Math.atan2(seg.contact.y - center.y, seg.contact.x - center.x) / (Math.PI / 4));
    const edgeX = seg.v1.x - seg.v0.x;
    const edgeY = seg.v1.y - seg.v0.y;
    const edgeLen = Math.hypot(edgeX, edgeY) || 1;
    const toContact = (seg.contact.x - center.x) * -edgeY + (seg.contact.y - center.y) * edgeX;
    const flip = toContact < 0 ? -1 : 1;
    out.push({
      face, neighbor, contact: seg.contact, polyline: seg.polyline,
      outward: { x: (flip * -edgeY) / edgeLen, y: (flip * edgeX) / edgeLen },
      compass: COMPASS[((sector % 8) + 8) % 8],
    });
  }
  return out;
}

/** The key a floor cell has in the floor's cell set. */
export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

const cellSetCache = new WeakMap<readonly { x: number; y: number }[], { length: number; set: Set<string> }>();

/** The floor's cells as `"x,y"` keys, kept per cell list so the several readers of one floor build the set once.
 *  A list that changed its length since it was cached (edited in place) is read again. */
export function floorCellSet(cells: readonly { x: number; y: number }[]): Set<string> {
  const cached = cellSetCache.get(cells);
  if (cached && cached.length === cells.length) return cached.set;
  const set = new Set(cells.map((c) => cellKey(c.x, c.y)));
  cellSetCache.set(cells, { length: cells.length, set });
  return set;
}

/** The outer sides of an endpoint's cell, in face order — empty when the endpoint is not on the floor. The one place the
 *  panel, the warnings and the renderer ask "where is this endpoint's external passage". */
export function endpointOuterFaces(node: { x: number; y: number } | undefined, cellSet: Set<string>, cfg: FieldConfig): OuterFace[] {
  return node ? listOuterFaces([node.x, node.y], cellSet, cfg) : [];
}

/** The side an opening uses: the chosen `face` while it is an outer side, else the cell's first outer side. */
export function resolveOpeningFace(faces: readonly OuterFace[], chosen: number | undefined): OuterFace | undefined {
  return faces.find((f) => f.face === chosen) ?? faces[0];
}

/** Whether `edge` is the boundary wall of `cell`'s outer side `outer`. */
export function isOpeningWall(edge: WallEdge, cell: [number, number], outer: OuterFace): boolean {
  if (edge.a[0] !== cell[0] || edge.a[1] !== cell[1] || edge.kind !== "none") return false;
  const neighborless = outer.neighbor[0] === cell[0] && outer.neighbor[1] === cell[1];
  if (neighborless) return edge.face === outer.face;
  return edge.face === undefined && edge.b[0] === outer.neighbor[0] && edge.b[1] === outer.neighbor[1];
}

/** How far past the floor's edge (the wall's centre line) a pointer's gap may go: half the wall's thickness where the
 *  wall stays, so the gap reaches the wall's outer edge; 0 where the wall is cut and the floor's edge is the limit. */
export function openingGapReach(mode: WaypointOpeningMode, wallThickness: number): number {
  return openingCutsWall(mode) ? 0 : wallThickness / 2;
}

export type WaypointOpeningKind = "start" | "finish";

/** A start/finish external passage ready to draw: the wall to leave out and/or the pointer standing there, per `mode`. */
export interface WaypointOpeningData {
  kind: WaypointOpeningKind;
  /** Never `"none"` — an endpoint without an external passage has no data at all. */
  mode: WaypointOpeningMode;
  cell: [number, number];
  outer: OuterFace;
  /** The pointer's centre — the middle of the wall segment — and unit direction: into the cell for the start, out of it for the finish. */
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** The openings switched on for this floor's start and finish, in that order. An endpoint that is not on
 *  the floor, or whose cell has no outer side, has none. */
export function buildWaypointOpenings(
  settings: { startOpening: { mode: WaypointOpeningMode; face?: number }; finishOpening: { mode: WaypointOpeningMode; face?: number } },
  nodeById: ReadonlyMap<number, NodeDto>,
  start: number | null,
  finish: number | null,
  cells: readonly [number, number][],
  cfg: FieldConfig,
): WaypointOpeningData[] {
  const cellSet = new Set(cells.map(([x, y]) => cellKey(x, y)));
  const out: WaypointOpeningData[] = [];
  for (const [kind, id, opening] of [["start", start, settings.startOpening], ["finish", finish, settings.finishOpening]] as const) {
    if (opening.mode === "none" || id === null) continue;
    const data = buildWaypointOpening(kind, opening.mode, nodeById.get(id), opening.face, cellSet, cfg);
    if (data) out.push(data);
  }
  return out;
}

/** The opening of one endpoint, or `null` when its node is not on the floor or the cell has no outer side
 *  (the "Opening has no outer wall" warning covers the latter). */
export function buildWaypointOpening(
  kind: WaypointOpeningKind,
  mode: WaypointOpeningMode,
  node: NodeDto | undefined,
  chosenFace: number | undefined,
  cellSet: Set<string>,
  cfg: FieldConfig,
): WaypointOpeningData | null {
  if (!node) return null;
  const cell: [number, number] = [node.x, node.y];
  const outer = resolveOpeningFace(endpointOuterFaces(node, cellSet, cfg), chosenFace);
  if (!outer) return null;
  const center = getCellCenter(cell[0], cell[1], cfg);
  const inX = center.x - outer.contact.x;
  const inY = center.y - outer.contact.y;
  const len = Math.hypot(inX, inY);
  if (len === 0) return null;
  const sign = kind === "start" ? 1 : -1;
  return { kind, mode, cell, outer, x: outer.contact.x, y: outer.contact.y, dx: (sign * inX) / len, dy: (sign * inY) / len };
}
