import { getCellNeighborOffsets, getTileDiagram } from "./tessellationGeometry";
import { originCellOf } from "./splitPatternTile";
import { parseNodeShapeKey } from "./nodeShapeKey";
import type { EdgeDto, NodeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";

/** A pair of faces matches a turn when their angle differs from it by at most this many degrees. */
const ANGLE_TOLERANCE_DEG = 1.5;

/** Interior angle (`0..=180`) between two contact directions, as core's `pass_angle_degrees`. */
function interiorAngleDeg(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const cos = (a.x * b.x + a.y * b.y) / ((Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)) || 1);
  return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
}

/** Face indices (of `cell`, the origin tile by default) that draw a `NodeShape::key()` — `dead_end` one face,
 *  `straight`/`turn_<deg>` the first pair whose contact points enclose that angle at the cell
 *  centre, `junction_<sides>_<ranks>` the faces whose angular rank (`faceRanks`, from core) is
 *  listed — the ranks of a canonical layout are a valid rotation of it. `null` for an unknown key,
 *  a junction without `faceRanks`, or when the tessellation has no such pair. Mirrors
 *  `Field::pass_angle_degrees`, so an icon matches what the check counts. */
export function shapeFaceIndices(
  key: string, cfg: FieldConfig, cell: readonly [number, number] = originCellOf(cfg),
  faceRanks: readonly number[] = [],
): number[] | null {
  const [x, y] = cell;
  const diagram = getTileDiagram(x, y, cfg);
  if (!diagram) return null;
  const { sides } = diagram;
  const shape = parseNodeShapeKey(key);
  if (!shape) return null;
  if (shape.type === "dead_end") return sides.length > 0 ? [sides[0].index] : null;
  if (shape.type === "junction") {
    if (shape.ranks) {
      const faces = shape.ranks.map((rank) => faceRanks.indexOf(rank));
      const indices = faces.filter((face) => sides.some((s) => s.index === face));
      return indices.length === faces.length ? indices : null;
    }
    return shape.degree <= sides.length ? sides.slice(0, shape.degree).map((s) => s.index) : null;
  }
  const angle = shape.type === "straight" ? 180 : shape.angle;
  for (let i = 0; i < sides.length; i++) {
    for (let j = i + 1; j < sides.length; j++) {
      if (Math.abs(interiorAngleDeg(sides[i].contact, sides[j].contact) - angle) <= ANGLE_TOLERANCE_DEG) {
        return [sides[i].index, sides[j].index];
      }
    }
  }
  return null;
}

/** A mini maze holding `cell` (the origin tile by default) and a neighbour across each face of the shape, joined by
 *  passages — fed to the maze's own wall pipeline (`buildMazeWalls`), the faces left out become
 *  walls, exactly as in a generated maze. */
export function shapeMiniMaze(
  faceIndices: readonly number[], cfg: FieldConfig, cell: readonly [number, number] = originCellOf(cfg),
): { nodes: NodeDto[]; edges: EdgeDto[] } {
  const [x, y] = cell;
  const offsets = getCellNeighborOffsets(cfg, x, y);
  const nodes: NodeDto[] = [{ id: 0, x, y, i: 0 }];
  const edges: EdgeDto[] = [];
  faceIndices.forEach((face, i) => {
    const offset = offsets[face];
    if (!offset) return;
    const id = i + 1;
    nodes.push({ id, x: x + offset[0], y: y + offset[1], i: id });
    edges.push({ from: 0, to: id, kind: "basic" }, { from: id, to: 0, kind: "basic" });
  });
  return { nodes, edges };
}
