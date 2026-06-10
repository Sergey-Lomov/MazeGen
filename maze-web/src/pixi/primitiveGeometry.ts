import { triTriangleRaw, triHexagonRaw, triCenterOffset } from "./triShapeHelpers";
import type { FieldPrimitive, TessellationKind } from "../store/mazeStore";

export type { TessellationKind };

export interface PrimitiveContext {
  startGrid: { x: number; y: number };
  endGrid: { x: number; y: number };
  gridRadius: number;
  kind: TessellationKind;
}

export type ShapePrimitive = Exclude<FieldPrimitive, "point">;

function squareRectCells(ctx: PrimitiveContext): [number, number][] {
  const minX = Math.min(ctx.startGrid.x, ctx.endGrid.x);
  const maxX = Math.max(ctx.startGrid.x, ctx.endGrid.x);
  const minY = Math.min(ctx.startGrid.y, ctx.endGrid.y);
  const maxY = Math.max(ctx.startGrid.y, ctx.endGrid.y);
  const cells: [number, number][] = [];
  for (let x = minX; x <= maxX; x++)
    for (let y = minY; y <= maxY; y++)
      cells.push([x, y]);
  return cells;
}

function hexParallelogramCells(ctx: PrimitiveContext): [number, number][] {
  const minQ = Math.min(ctx.startGrid.x, ctx.endGrid.x);
  const maxQ = Math.max(ctx.startGrid.x, ctx.endGrid.x);
  const minR = Math.min(ctx.startGrid.y, ctx.endGrid.y);
  const maxR = Math.max(ctx.startGrid.y, ctx.endGrid.y);
  const cells: [number, number][] = [];
  for (let q = minQ; q <= maxQ; q++)
    for (let r = minR; r <= maxR; r++)
      cells.push([q, r]);
  return cells;
}

function hexHexagonCells(ctx: PrimitiveContext): [number, number][] {
  const q0 = ctx.startGrid.x;
  const r0 = ctx.startGrid.y;
  const radius = ctx.gridRadius;
  const cells: [number, number][] = [];
  for (let q = q0 - radius; q <= q0 + radius; q++) {
    for (let r = r0 - radius; r <= r0 + radius; r++) {
      if (Math.abs(q - q0) <= radius && Math.abs(r - r0) <= radius && Math.abs((q - q0) + (r - r0)) <= radius)
        cells.push([q, r]);
    }
  }
  return cells;
}

function triRectCells(ctx: PrimitiveContext): [number, number][] {
  const minCol = Math.min(ctx.startGrid.x, ctx.endGrid.x);
  const maxCol = Math.max(ctx.startGrid.x, ctx.endGrid.x);
  const minRow = Math.min(ctx.startGrid.y, ctx.endGrid.y);
  const maxRow = Math.max(ctx.startGrid.y, ctx.endGrid.y);
  const cells: [number, number][] = [];
  for (let col = minCol; col <= maxCol; col++)
    for (let row = minRow; row <= maxRow; row++)
      cells.push([col, row]);
  return cells;
}

function triTriangleCells(ctx: PrimitiveContext): [number, number][] {
  const raw = triTriangleRaw(ctx.gridRadius);
  const { ox, oy } = triCenterOffset(raw);
  let offsetX = ctx.startGrid.x;
  let offsetY = ctx.startGrid.y;
  if ((offsetX + offsetY) % 2 !== 0) offsetY -= 1;
  return raw.map(([x, y]) => [x - ox + offsetX, y - oy + offsetY]);
}

function triHexagonCells(ctx: PrimitiveContext): [number, number][] {
  const raw = triHexagonRaw(ctx.gridRadius);
  const { ox, oy } = triCenterOffset(raw);
  let offsetX = ctx.startGrid.x;
  let offsetY = ctx.startGrid.y;
  if ((offsetX + offsetY) % 2 !== 0) offsetY -= 1;
  return raw.map(([x, y]) => [x - ox + offsetX, y - oy + offsetY]);
}

const primitiveFns: Record<ShapePrimitive, (ctx: PrimitiveContext) => [number, number][]> = {
  square_rect:       squareRectCells,
  hex_parallelogram: hexParallelogramCells,
  hex_hexagon:       hexHexagonCells,
  tri_rect:          triRectCells,
  tri_triangle:      triTriangleCells,
  tri_hexagon:       triHexagonCells,
};

export function primitiveCells(primitive: ShapePrimitive, ctx: PrimitiveContext): [number, number][] {
  return primitiveFns[primitive](ctx);
}

export function cfgKind(cfgType: string): TessellationKind {
  if (cfgType.startsWith("hex")) return "hex";
  if (cfgType.startsWith("tri")) return "triangle";
  return "square";
}
