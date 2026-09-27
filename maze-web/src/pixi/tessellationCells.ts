import { triTriangleRaw, triHexagonRaw, triCircleRaw, triCenterOffset } from "./triShapeHelpers";
import { squareCircleRaw, squareTriangleRaw } from "./squareShapeHelpers";
import { hexCircleRaw, hexRectangleRaw } from "./hexShapeHelpers";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

export function configOriginOffset(cfg: TessellationConfig): { ox: number; oy: number } {
  switch (cfg.type) {
    case "square":
      return { ox: Math.floor(cfg.width / 2), oy: Math.floor(cfg.height / 2) };
    case "square_circle":
    case "square_triangle": return { ox: 0, oy: 0 };
    case "hex_rectangle": return { ox: 0, oy: 0 };
    case "hex_parallelogram":
      return { ox: Math.floor(cfg.cols / 2), oy: Math.floor(cfg.rows / 2) };
    case "hex_circle": return { ox: 0, oy: 0 };
    case "hex_hexagon":
      return { ox: 0, oy: 0 };
    case "triangle_rect": {
      let ox = Math.floor(cfg.cols / 2);
      let oy = Math.floor(cfg.rows / 2);
      if ((ox + oy) % 2 !== 0) oy = Math.max(0, oy - 1);
      return { ox, oy };
    }
    case "triangle_triangle": {
      const { ox, oy } = triCenterOffset(triTriangleRaw(cfg.side));
      return { ox, oy };
    }
    case "triangle_circle": return { ox: 0, oy: 0 };
    case "triangle_hexagon": {
      const { ox, oy } = triCenterOffset(triHexagonRaw(cfg.radius));
      return { ox, oy };
    }
    case "square_custom":
    case "hex_custom":
    case "tri_custom": return { ox: 0, oy: 0 };
  }
}

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
    case "square_circle": {
      return squareCircleRaw(cfg.radius);
    }
    case "square_triangle": {
      return squareTriangleRaw(cfg.side);
    }
    case "hex_rectangle": {
      return hexRectangleRaw(cfg.cols, cfg.rows, cfg.orientation);
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
    case "hex_circle": {
      return hexCircleRaw(cfg.radius, cfg.orientation);
    }
    case "hex_hexagon": {
      const cells: [number, number][] = [];
      for (let x = -cfg.radius; x <= cfg.radius; x++)
        for (let y = -cfg.radius; y <= cfg.radius; y++)
          if (Math.abs(x + y) <= cfg.radius) cells.push([x, y]);
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
    case "triangle_circle": {
      return triCircleRaw(cfg.radius);
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
