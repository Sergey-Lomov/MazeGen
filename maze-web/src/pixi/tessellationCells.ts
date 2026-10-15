import { triTriangleRaw, triHexagonRaw, triCenterOffset } from "./triShapeHelpers";
import { cellsInsideShape, shapeForPrimitive, type ShapeOrigin } from "./shapeSelection";
import { primitiveCells } from "./primitiveGeometry";
import { makeProjection } from "./tessellationProjection";
import { TILE_SIZE } from "./constants";
import { hexOrientationOf, type FieldConfig, type ResolvedField } from "../fieldConfig";

export function configOriginOffset(cfg: FieldConfig): { ox: number; oy: number } {
  const { shape } = cfg;
  switch (cfg.tessellation.kind) {
    case "square":
      return shape.shape === "rect" ? { ox: Math.floor(shape.cols / 2), oy: Math.floor(shape.rows / 2) } : { ox: 0, oy: 0 };
    case "hex":
      return shape.shape === "parallelogram" ? { ox: Math.floor(shape.cols / 2), oy: Math.floor(shape.rows / 2) } : { ox: 0, oy: 0 };
    case "tri":
      // Each configured column contains two adjacent opposite-orientation triangles.
      if (shape.shape === "rect") return { ox: shape.cols, oy: Math.floor(shape.rows / 2) };
      if (shape.shape === "triangle") return triCenterOffset(triTriangleRaw(shape.side));
      if (shape.shape === "hexagon") return triCenterOffset(triHexagonRaw(shape.radius));
      return { ox: 0, oy: 0 };
    case "cairo":
      return { ox: 0, oy: 0 };
  }
}

/** Hex/tri hexagon presets: a symmetric, square-constrained hexagon primitive of `radius`. */
function latticeHexagonCells(cfg: FieldConfig, radius: number): [number, number][] {
  const frameSide = radius * 4;
  const dragDistance = Math.max(0, (frameSide - 1) * TILE_SIZE / 2);
  return primitiveCells("hexagon", {
    startGrid: { x: 0, y: 0 },
    endGrid: { x: 0, y: 0 },
    startWorld: { x: 0, y: 0 },
    endWorld: { x: dragDistance, y: dragDistance },
    gridRadius: radius,
    kind: cfg.tessellation.kind,
    config: cfg,
    latticeRadius: radius,
    symmetric: true,
    constrainSquare: true,
  });
}

export function configAllCells(cfg: FieldConfig): [number, number][] {
  const { shape } = cfg;
  if (shape.shape === "custom") return shape.points.map(([x, y]) => [x, y]);
  const base: FieldConfig = { ...cfg, shape: { shape: "custom", points: [] } };
  const kind = cfg.tessellation.kind;
  switch (shape.shape) {
    case "rect":
      if (kind === "square") {
        return cellsInsideShape(base, shapeForPrimitive("rectangle", base, { width: shape.cols, height: shape.rows }), "center", centeredOrigin(base, shape.cols, shape.rows));
      }
      if (kind === "hex") return hexRectangleCells(shape.cols, shape.rows, hexOrientationOf(cfg));
      if (kind === "tri") return triangularRectangleCells(shape.cols, shape.rows);
      return cairoRectangleCells(shape.cols, shape.rows);
    case "parallelogram":
      return axialRectangleCells(shape.cols, shape.rows);
    case "circle":
      if (kind === "tri") {
        return primitiveCells("circle", {
          startGrid: { x: 0, y: 0 },
          endGrid: { x: 0, y: 0 },
          gridRadius: shape.radius,
          kind,
          config: base,
          latticeRadius: shape.radius,
          symmetric: true,
        });
      }
      return cellsInsideShape(base, shapeForPrimitive("circle", base, { width: 0, height: 0, radius: shape.radius }));
    case "triangle":
      if (kind === "tri") {
        return primitiveCells("equilateral_triangle", {
          startGrid: { x: 0, y: 0 },
          endGrid: { x: 0, y: 0 },
          gridRadius: shape.side,
          kind,
          config: base,
          latticeSide: shape.side,
        });
      }
      return cellsInsideShape(base, shapeForPrimitive("triangle", base, { width: 0, height: 0, side: shape.side }));
    case "hexagon":
      if (kind === "cairo") {
        return cellsInsideShape(base, shapeForPrimitive("hexagon", base, { width: 0, height: 0, radius: shape.radius }));
      }
      return latticeHexagonCells(base, shape.radius);
  }
}

/**
 * Converts the editor's preset shape into the only representation runtime code needs: the same
 * tessellation and orientation with an explicit cell list. Keep all preset-shape knowledge in
 * this module.
 */
export function resolveFieldConfig(cfg: FieldConfig): ResolvedField {
  return { ...cfg, shape: { shape: "custom", points: configAllCells(cfg) } };
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

function centeredOrigin(cfg: FieldConfig, width: number, height: number): ShapeOrigin {
  const projection = makeProjection(cfg);
  const center = projection.gridToScreen(0, 0);
  return {
    x: center.x - (width % 2 === 0 ? TILE_SIZE / 2 : 0),
    y: -center.y - (height % 2 === 0 ? TILE_SIZE / 2 : 0),
  };
}
