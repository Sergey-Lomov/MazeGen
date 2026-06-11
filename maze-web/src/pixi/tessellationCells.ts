import { triTriangleRaw, triHexagonRaw, triCenterOffset } from "./triShapeHelpers";
import type { TessellationConfig } from "../wasm/types";

export function configAllCells(cfg: TessellationConfig): [number, number][] {
  switch (cfg.type) {
    case "square": {
      const ox = Math.floor(cfg.width / 2);
      const oy = Math.floor(cfg.height / 2);
      const cells: [number, number][] = [];
      for (let x = 0; x < cfg.width; x++)
        for (let y = 0; y < cfg.height; y++)
          cells.push([x - ox, y - oy]);
      return cells;
    }
    case "hex_parallelogram": {
      const ox = Math.floor(cfg.cols / 2);
      const oy = Math.floor(cfg.rows / 2);
      const cells: [number, number][] = [];
      for (let x = 0; x < cfg.cols; x++)
        for (let y = 0; y < cfg.rows; y++)
          cells.push([x - ox, y - oy]);
      return cells;
    }
    case "hex_hexagon": {
      const r = cfg.radius;
      const cells: [number, number][] = [];
      for (let x = -r; x <= r; x++)
        for (let y = -r; y <= r; y++)
          if (Math.abs(x + y) <= r) cells.push([x, y]);
      return cells;
    }
    case "triangle_rect": {
      let ox = Math.floor(cfg.cols / 2);
      let oy = Math.floor(cfg.rows / 2);
      if ((ox + oy) % 2 !== 0) oy = Math.max(0, oy - 1);
      const cells: [number, number][] = [];
      for (let x = 0; x < cfg.cols; x++)
        for (let y = 0; y < cfg.rows; y++)
          cells.push([x - ox, y - oy]);
      return cells;
    }
    case "triangle_triangle": {
      const raw = triTriangleRaw(cfg.side);
      const { ox, oy } = triCenterOffset(raw);
      return raw.map(([x, y]) => [x - ox, y - oy]);
    }
    case "triangle_hexagon": {
      const raw = triHexagonRaw(cfg.radius);
      const { ox, oy } = triCenterOffset(raw);
      return raw.map(([x, y]) => [x - ox, y - oy]);
    }
    case "square_custom":
    case "hex_custom":
    case "tri_custom":
      return cfg.points.map(([x, y]) => [x, y]);
  }
}
