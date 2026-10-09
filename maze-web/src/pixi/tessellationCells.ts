import { triTriangleRaw, triHexagonRaw, triCenterOffset } from "./triShapeHelpers";
import { cellsInsideShape, shapeForPrimitive, type ShapeOrigin } from "./shapeSelection";
import { primitiveCells } from "./primitiveGeometry";
import { makeProjection } from "./tessellationProjection";
import { TILE_SIZE } from "./constants";
import type { FieldConfig as TessellationConfig, ResolvedField } from "../fieldConfig";

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
    case "hex_triangle": return { ox: 0, oy: 0 };
    case "hex_hexagon":
      return { ox: 0, oy: 0 };
    case "triangle_rect": {
      // Each configured column contains two adjacent opposite-orientation triangles.
      return { ox: cfg.cols, oy: Math.floor(cfg.rows / 2) };
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
    case "cairo":
    case "cairo_circle":
    case "cairo_triangle":
    case "cairo_hexagon":
    case "cairo_custom": return { ox: 0, oy: 0 };
  }
}

export function configAllCells(cfg: TessellationConfig): [number, number][] {
  switch (cfg.type) {
    case "square": {
      const base = { type: "square", width: 0, height: 0 } as TessellationConfig;
      return cellsInsideShape(base, shapeForPrimitive("rectangle", base, { width: cfg.width, height: cfg.height }), "center", centeredOrigin(base, cfg.width, cfg.height));
    }
    case "square_circle": {
      const base = { type: "square", width: 0, height: 0 } as TessellationConfig;
      return cellsInsideShape(base, shapeForPrimitive("circle", base, { width: 0, height: 0, radius: cfg.radius }));
    }
    case "square_triangle": {
      const base = { type: "square", width: 0, height: 0 } as TessellationConfig;
      return cellsInsideShape(base, shapeForPrimitive("triangle", base, { width: 0, height: 0, side: cfg.side }));
    }
    case "hex_rectangle": {
      return hexRectangleCells(cfg.cols, cfg.rows, cfg.orientation ?? "flat_top");
    }
    case "hex_parallelogram": {
      return axialRectangleCells(cfg.cols, cfg.rows);
    }
    case "hex_circle": {
      const base = { type: "hex_hexagon", radius: 0, orientation: cfg.orientation } as TessellationConfig;
      return cellsInsideShape(base, shapeForPrimitive("circle", base, { width: 0, height: 0, radius: cfg.radius }));
    }
    case "hex_triangle": {
      const base = { type: "hex_hexagon", radius: 0, orientation: cfg.orientation } as TessellationConfig;
      return cellsInsideShape(base, shapeForPrimitive("triangle", base, { width: 0, height: 0, side: cfg.side }));
    }
    case "hex_hexagon": {
      const base = { type: "hex_hexagon", radius: 0, orientation: cfg.orientation } as TessellationConfig;
      const frameSide = cfg.radius * 4;
      const dragDistance = Math.max(0, (frameSide - 1) * TILE_SIZE / 2);
      return primitiveCells("hexagon", {
        startGrid: { x: 0, y: 0 },
        endGrid: { x: 0, y: 0 },
        startWorld: { x: 0, y: 0 },
        endWorld: { x: dragDistance, y: dragDistance },
        gridRadius: cfg.radius,
        kind: "hex",
        config: base,
        latticeRadius: cfg.radius,
        symmetric: true,
        constrainSquare: true,
      });
    }
    case "triangle_rect": {
      return triangularRectangleCells(cfg.cols, cfg.rows);
    }
    case "triangle_triangle": {
      const base = { type: "triangle_rect", cols: 0, rows: 0, orientation: cfg.orientation } as TessellationConfig;
      return primitiveCells("equilateral_triangle", {
        startGrid: { x: 0, y: 0 },
        endGrid: { x: 0, y: 0 },
        gridRadius: cfg.side,
        kind: "triangle",
        config: base,
        latticeSide: cfg.side,
      });
    }
    case "triangle_circle": {
      const base = { type: "triangle_rect", cols: 0, rows: 0, orientation: cfg.orientation } as TessellationConfig;
      return primitiveCells("circle", {
        startGrid: { x: 0, y: 0 },
        endGrid: { x: 0, y: 0 },
        gridRadius: cfg.radius,
        kind: "triangle",
        config: base,
        latticeRadius: cfg.radius,
        symmetric: true,
      });
    }
    case "triangle_hexagon": {
      const base = { type: "triangle_rect", cols: 0, rows: 0, orientation: cfg.orientation } as TessellationConfig;
      const frameSide = cfg.radius * 4;
      const dragDistance = Math.max(0, (frameSide - 1) * TILE_SIZE / 2);
      return primitiveCells("hexagon", {
        startGrid: { x: 0, y: 0 },
        endGrid: { x: 0, y: 0 },
        startWorld: { x: 0, y: 0 },
        endWorld: { x: dragDistance, y: dragDistance },
        gridRadius: cfg.radius,
        kind: "triangle",
        config: base,
        latticeRadius: cfg.radius,
        symmetric: true,
        constrainSquare: true,
      });
    }
    case "cairo": {
      return cairoRectangleCells(cfg.cols, cfg.rows);
    }
    case "cairo_circle": {
      const base = { type: "cairo", cols: 0, rows: 0 } as TessellationConfig;
      return cellsInsideShape(base, shapeForPrimitive("circle", base, { width: 0, height: 0, radius: cfg.radius }));
    }
    case "cairo_triangle": {
      const base = { type: "cairo", cols: 0, rows: 0 } as TessellationConfig;
      return cellsInsideShape(base, shapeForPrimitive("triangle", base, { width: 0, height: 0, side: cfg.side }));
    }
    case "cairo_hexagon": {
      const base = { type: "cairo", cols: 0, rows: 0 } as TessellationConfig;
      return cellsInsideShape(base, shapeForPrimitive("hexagon", base, { width: 0, height: 0, radius: cfg.radius }));
    }
    case "cairo_custom":
      return cfg.points.map(([x, y]) => [x, y]);
    case "square_custom":
    case "hex_custom":
    case "tri_custom":
      return cfg.points.map(([x, y]) => [x, y]);
  }
}

/**
 * Converts the editor's detailed shape configuration into the only representation runtime code
 * needs. Keep all `*_circle`/`*_triangle`/`*_custom` knowledge in this module.
 */
export function resolveFieldConfig(cfg: TessellationConfig): ResolvedField {
  const cells = configAllCells(cfg);
  if (cfg.type.startsWith("square")) return { type: "square", width: 0, height: 0, kind: "square", cells };
  if (cfg.type.startsWith("hex")) {
    return { type: "hex_parallelogram", cols: 0, rows: 0, kind: "hex", orientation: (("orientation" in cfg ? cfg.orientation : undefined) ?? "flat_top") as "flat_top" | "pointy_top", cells };
  }
  if (cfg.type.startsWith("cairo")) return { type: "cairo", cols: 0, rows: 0, kind: "cairo", cells };
  return { type: "triangle_rect", cols: 0, rows: 0, kind: "triangle", orientation: (("orientation" in cfg ? cfg.orientation : undefined) ?? "r0") as "r0" | "r90" | "r180" | "r270", cells };
}

/** A centered Cairo rectangle with the same fundamental-square layout as maze-core's
 * `CairoTessellation::rect`. Each 4×4 block contributes the two valid pentagons selected by its
 * checkerboard parity; translating the complete block rectangle by its midpoint keeps the field
 * around the editor origin without changing the lattice topology. */
function cairoRectangleCells(cols: number, rows: number): [number, number][] {
  if (cols <= 0 || rows <= 0) return [];
  const [originX, originY] = cairoRectangleOrigin(cols, rows);
  const cells: [number, number][] = [];
  for (let cellY = 0; cellY < rows; cellY++) {
    for (let cellX = 0; cellX < cols; cellX++) {
      cells.push(...cairoFundamentalSquareCells(cellX, cellY, originX, originY));
    }
  }
  return cells;
}

/** Returns the cells in the outer two fundamental-square layers of a Cairo rectangle. Cell
 * polygons are affine in this block layout, so this bounded set contains every possible x/y
 * extremum and is sufficient for exact print-fit bounds without materializing the full field. */
export function cairoRectangleBoundaryCells(cols: number, rows: number): [number, number][] {
  if (cols <= 0 || rows <= 0) return [];
  const [originX, originY] = cairoRectangleOrigin(cols, rows);
  const colCandidates = new Set([0, 1, cols - 2, cols - 1].filter((col) => col >= 0 && col < cols));
  const rowCandidates = new Set([0, 1, rows - 2, rows - 1].filter((row) => row >= 0 && row < rows));
  const cells: [number, number][] = [];
  for (const cellY of rowCandidates) {
    for (const cellX of colCandidates) {
      cells.push(...cairoFundamentalSquareCells(cellX, cellY, originX, originY));
    }
  }
  return cells;
}

function cairoRectangleOrigin(cols: number, rows: number): [number, number] {
  // Cairo's checkerboard repeats after two fundamental blocks. Translate by complete blocks only
  // and keep the combined block offset even; otherwise a valid core point lands in an empty
  // position when the rectangle is centred for an odd width/height combination.
  let blockX = Math.floor(cols / 2);
  const blockY = Math.floor(rows / 2);
  if ((blockX + blockY) % 2 !== 0) blockX++;
  return [4 * blockX, 4 * blockY];
}

function cairoFundamentalSquareCells(cellX: number, cellY: number, originX: number, originY: number): [number, number][] {
  const x = cellX * 4;
  const y = cellY * 4;
  const points: [number, number][] = (cellX + cellY) % 2 === 1
    ? [[x + 1, y + 2], [x + 3, y + 2]]
    : [[x + 2, y + 1], [x + 2, y + 3]];
  return points.map(([pointX, pointY]) => [pointX - originX, pointY - originY]);
}

/** Cairo's standard field is a rectangle of fundamental 4×4 coordinate squares; each square
 * contributes the two valid pentagon centres used by maze-core's `CairoTessellation::rect`. */
/** A rectangular triangle-tessellation field is made from complete horizontal pairs of opposite
 * triangles. Each configured column spans two triangle cells, while rows remain visual rows. */
function triangularRectangleCells(cols: number, rows: number): [number, number][] {
  const cellCols = cols * 2;
  const cellRows = rows;
  const originRow = Math.floor(rows / 2);
  const cells: [number, number][] = [];
  for (let row = 0; row < cellRows; row++) {
    for (let col = 0; col < cellCols; col++) {
      cells.push([col - cols, row - originRow]);
    }
  }
  return cells;
}

/** A hex-grid parallelogram is an axial rectangle: each parameter controls one grid axis. */
function axialRectangleCells(cols: number, rows: number): [number, number][] {
  const originX = Math.floor(cols / 2);
  const originY = Math.floor(rows / 2);
  const cells: [number, number][] = [];
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      cells.push([x - originX, y - originY]);
    }
  }
  return cells;
}

/** A hex-grid rectangle has exact dimensions while preserving screen-aligned sides. The half-cell
 * offset alternates between neighboring columns/rows, so this is distinct from an axial
 * parallelogram and every increment adds a complete layer. */
function hexRectangleCells(cols: number, rows: number, orientation: "flat_top" | "pointy_top"): [number, number][] {
  const originCol = Math.floor(cols / 2);
  const originRow = Math.floor(rows / 2);
  const cells: [number, number][] = [];
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      if (orientation === "flat_top") {
        const q = col - originCol;
        cells.push([q, row - originRow - Math.floor(q / 2)]);
      } else {
        const r = row - originRow;
        cells.push([col - originCol - Math.floor(r / 2), r]);
      }
    }
  }
  return cells;
}

function centeredOrigin(cfg: TessellationConfig, width: number, height: number): ShapeOrigin {
  const projection = makeProjection(cfg);
  const center = projection.gridToScreen(0, 0);
  return {
    x: center.x - (width % 2 === 0 ? TILE_SIZE / 2 : 0),
    y: -center.y - (height % 2 === 0 ? TILE_SIZE / 2 : 0),
  };
}
