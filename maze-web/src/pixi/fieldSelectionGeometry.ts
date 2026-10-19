import { getCellVertices as geometryCellVertices } from "./tessellationGeometry";
import type { FieldConfig } from "../fieldConfig";
import type { WorldPoint } from "./primitiveGeometry";

export type BoundarySegment = [WorldPoint, WorldPoint];

/** Exposed edges of the selected cell union (shared cell edges cancel out) plus, per edge, the id of its edge-connected
 * component. Cells touching only at a corner land in different components, so contour tracing
 * never joins them into a self-intersecting contour (GitHub issue #618). */
export function selectionBoundary(
  cells: [number, number][],
  cfg: FieldConfig,
): { segments: BoundarySegment[]; components: number[] } {
  const parent = cells.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    for (let node = i; parent[node] !== root; ) {
      const next = parent[node];
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const edges = new Map<string, { segment: BoundarySegment; cell: number }>();
  cells.forEach(([x, y], cell) => {
    const vertices = cellVertices(x, y, cfg);
    for (let i = 0; i < vertices.length; i++) {
      const from = vertices[i];
      const to = vertices[(i + 1) % vertices.length];
      const fromKey = pointKey(from);
      const toKey = pointKey(to);
      const key = fromKey < toKey ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`;
      const existing = edges.get(key);
      if (existing) {
        parent[find(cell)] = find(existing.cell);
        edges.delete(key);
      } else {
        edges.set(key, { segment: [from, to], cell });
      }
    }
  });
  const exposed = [...edges.values()];
  return {
    segments: exposed.map(({ segment }) => segment),
    components: exposed.map(({ cell }) => find(cell)),
  };
}

function cellVertices(x: number, y: number, cfg: FieldConfig): WorldPoint[] {
  return geometryCellVertices(x, y, cfg).map((point) => ({ x: point.x, y: -point.y }));
}

function pointKey(point: WorldPoint): string {
  return `${Math.round(point.x * 1e6)},${Math.round(point.y * 1e6)}`;
}
