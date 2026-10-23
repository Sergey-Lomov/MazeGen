import type { FieldConfig } from "../fieldConfig";
import { getCellCenter, nearestCellCoord } from "./tessellationGeometry";

export interface TessellationProjection {
  // viewport-space coords (after viewport transform) → grid coords
  screenToGrid(vx: number, vy: number): { x: number; y: number };
  gridToScreen(x: number, y: number): { x: number; y: number };
  gridBounds(vpX: number, vpY: number, vpW: number, vpH: number, scale: number): {
    minX: number; maxX: number; minY: number; maxY: number;
  };
}

// Assumes coords fit in [-32768, 32767]. JS bitwise ops are 32-bit signed.
export function encodePoint(x: number, y: number): number {
  return ((x & 0xFFFF) << 16) | (y & 0xFFFF);
}

export function decodePoint(key: number): [number, number] {
  const x = key >> 16;
  const y = ((key & 0xFFFF) << 16) >> 16;
  return [x, y];
}

/// Cells at or beyond a viewport's corners are visible too, so the grid range is padded.
const GRID_BOUNDS_PAD = 3;

/// The projection of any tessellation: pointer positions resolve to cells through core's point
/// query, cell positions come from the snapshot, both through the display transform.
class SnapshotProjection implements TessellationProjection {
  constructor(private readonly cfg: FieldConfig) {}

  screenToGrid(vx: number, vy: number) {
    const [x, y] = nearestCellCoord(vx, vy, this.cfg);
    return { x, y };
  }

  gridToScreen(x: number, y: number) {
    return getCellCenter(x, y, this.cfg);
  }

  gridBounds(vpX: number, vpY: number, vpW: number, vpH: number, scale: number) {
    const corners = [
      this.screenToGrid(-vpX / scale, -vpY / scale),
      this.screenToGrid((-vpX + vpW) / scale, -vpY / scale),
      this.screenToGrid(-vpX / scale, (-vpY + vpH) / scale),
      this.screenToGrid((-vpX + vpW) / scale, (-vpY + vpH) / scale),
    ];
    return {
      minX: Math.min(...corners.map((c) => c.x)) - GRID_BOUNDS_PAD,
      maxX: Math.max(...corners.map((c) => c.x)) + GRID_BOUNDS_PAD,
      minY: Math.min(...corners.map((c) => c.y)) - GRID_BOUNDS_PAD,
      maxY: Math.max(...corners.map((c) => c.y)) + GRID_BOUNDS_PAD,
    };
  }
}

export function makeProjection(cfg: FieldConfig): TessellationProjection {
  return new SnapshotProjection(cfg);
}
