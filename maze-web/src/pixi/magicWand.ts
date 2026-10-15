import type { FieldConfig } from "../fieldConfig";
import { decodePoint, encodePoint } from "./tessellationProjection";
import { getCellNeighborOffsets } from "./tessellationGeometry";

export type MagicWandCells = [number, number][];

export function connectedMagicWandCells(
  start: [number, number],
  cfg: FieldConfig,
  occupied: Set<number>,
): MagicWandCells | null {
  const startKey = encodePoint(start[0], start[1]);
  const targetOccupied = occupied.has(startKey);
  if (!targetOccupied && occupied.size === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  if (!targetOccupied) {
    for (const key of occupied) {
      const [x, y] = decodePoint(key);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  const queue: [number, number][] = [start];
  const visited = new Set<number>([startKey]);
  const result: MagicWandCells = [];

  for (let index = 0; index < queue.length; index++) {
    const [x, y] = queue[index];
    result.push([x, y]);

    for (const [dx, dy] of getCellNeighborOffsets(cfg, x, y)) {
      const nextX = x + dx;
      const nextY = y + dy;
      const nextKey = encodePoint(nextX, nextY);
      if (visited.has(nextKey) || occupied.has(nextKey) !== targetOccupied) continue;

      if (!targetOccupied
        && (nextX < minX - 1 || nextX > maxX + 1 || nextY < minY - 1 || nextY > maxY + 1)) {
        return null;
      }

      visited.add(nextKey);
      queue.push([nextX, nextY]);
    }
  }

  return result;
}
