import { TILE_SIZE } from "./constants";
import { INRADIUS } from "./hexGeometry";
import { TRI_TILE_SIZE } from "./triGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

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

class SquareProjection implements TessellationProjection {
  screenToGrid(vx: number, vy: number) {
    return {
      x: Math.floor(vx / TILE_SIZE),
      y: Math.floor(-vy / TILE_SIZE),
    };
  }

  gridToScreen(x: number, y: number) {
    return {
      x: x * TILE_SIZE + TILE_SIZE / 2,
      y: -y * TILE_SIZE - TILE_SIZE / 2,
    };
  }

  gridBounds(vpX: number, vpY: number, vpW: number, vpH: number, scale: number) {
    const pad = 2;
    const left = -vpX / scale;
    const top = -vpY / scale;
    const right = left + vpW / scale;
    const bottom = top + vpH / scale;
    return {
      minX: Math.floor(left / TILE_SIZE) - pad,
      maxX: Math.ceil(right / TILE_SIZE) + pad,
      minY: Math.floor(-bottom / TILE_SIZE) - pad,
      maxY: Math.ceil(-top / TILE_SIZE) + pad,
    };
  }
}

class HexProjection implements TessellationProjection {
  constructor(private readonly orientation: "flat_top" | "pointy_top") {}

  screenToGrid(vx: number, vy: number) {
    if (this.orientation === "flat_top") {
      const q = vx / (TILE_SIZE * 1.5);
      const r = (-vy - q * INRADIUS) / (INRADIUS * 2);
      return { x: Math.round(q), y: Math.round(r) };
    } else {
      const r = -vy / (TILE_SIZE * 1.5);
      const q = (vx - r * INRADIUS) / (INRADIUS * 2);
      return { x: Math.round(q), y: Math.round(r) };
    }
  }

  gridToScreen(x: number, y: number) {
    if (this.orientation === "flat_top") {
      return {
        x: x * TILE_SIZE * 1.5,
        y: -(y * INRADIUS * 2 + x * INRADIUS),
      };
    } else {
      return {
        x: x * INRADIUS * 2 + y * INRADIUS,
        y: -(y * TILE_SIZE * 1.5),
      };
    }
  }

  gridBounds(vpX: number, vpY: number, vpW: number, vpH: number, scale: number) {
    const pad = 3;
    const corners = [
      this.screenToGrid(-vpX / scale, -vpY / scale),
      this.screenToGrid((-vpX + vpW) / scale, -vpY / scale),
      this.screenToGrid(-vpX / scale, (-vpY + vpH) / scale),
      this.screenToGrid((-vpX + vpW) / scale, (-vpY + vpH) / scale),
    ];
    return {
      minX: Math.min(...corners.map(c => c.x)) - pad,
      maxX: Math.max(...corners.map(c => c.x)) + pad,
      minY: Math.min(...corners.map(c => c.y)) - pad,
      maxY: Math.max(...corners.map(c => c.y)) + pad,
    };
  }
}

class TriProjection implements TessellationProjection {
  constructor(private readonly orientation: "r0" | "r90" | "r180" | "r270") {}

  private unrotate(x: number, y: number): { x: number; y: number } {
    switch (this.orientation) {
      case "r0":   return { x,    y    };
      case "r90":  return { x: -y, y: -x };
      case "r180": return { x: -x, y: -y };
      case "r270": return { x:  y, y:  x };
    }
  }

  screenToGrid(vx: number, vy: number) {
    const { x: fx, y: fy } = this.unrotate(vx, vy);
    const S = TRI_TILE_SIZE;
    const H = S * Math.sqrt(3) / 2;
    const row = Math.floor(-fy / H);
    const col0 = Math.floor(fx / (S / 2));
    // pick nearest centroid among col0-1, col0, col0+1 (triangles have diagonal boundaries)
    let bestCol = col0;
    let bestDist = Infinity;
    for (const c of [col0 - 1, col0, col0 + 1]) {
      const pointingUp = (c + row) % 2 === 0;
      const cx = c * S / 2 + S / 4;
      const cy = pointingUp ? -(row * H + H / 3) : -(row * H + 2 * H / 3);
      const d = (fx - cx) * (fx - cx) + (fy - cy) * (fy - cy);
      if (d < bestDist) { bestDist = d; bestCol = c; }
    }
    return { x: bestCol, y: row };
  }

  gridToScreen(x: number, y: number) {
    const S = TRI_TILE_SIZE;
    const H = S * Math.sqrt(3) / 2;
    const pointingUp = (x + y) % 2 === 0;
    const cx = x * S / 2 + S / 4;
    const cy = pointingUp ? -(y * H + H / 3) : -(y * H + 2 * H / 3);
    switch (this.orientation) {
      case "r0":   return { x: cx,  y: cy  };
      case "r90":  return { x: -cy, y: -cx };
      case "r180": return { x: -cx, y: -cy };
      case "r270": return { x:  cy, y:  cx };
    }
  }

  gridBounds(vpX: number, vpY: number, vpW: number, vpH: number, scale: number) {
    const pad = 3;
    const corners = [
      this.screenToGrid(-vpX / scale, -vpY / scale),
      this.screenToGrid((-vpX + vpW) / scale, -vpY / scale),
      this.screenToGrid(-vpX / scale, (-vpY + vpH) / scale),
      this.screenToGrid((-vpX + vpW) / scale, (-vpY + vpH) / scale),
    ];
    return {
      minX: Math.min(...corners.map(c => c.x)) - pad,
      maxX: Math.max(...corners.map(c => c.x)) + pad,
      minY: Math.min(...corners.map(c => c.y)) - pad,
      maxY: Math.max(...corners.map(c => c.y)) + pad,
    };
  }
}

export function makeProjection(cfg: TessellationConfig): TessellationProjection {
  switch (cfg.type) {
    case "square":
    case "square_circle":
    case "square_triangle":
    case "square_custom":
      return new SquareProjection();
    case "hex_rectangle":
    case "hex_circle":
    case "hex_triangle":
    case "hex_parallelogram":
    case "hex_hexagon":
    case "hex_custom":
      return new HexProjection((cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top");
    case "triangle_rect":
    case "triangle_triangle":
    case "triangle_circle":
    case "triangle_hexagon":
    case "tri_custom":
      return new TriProjection((cfg as { orientation?: "r0" | "r90" | "r180" | "r270" }).orientation ?? "r0");
  }
}
