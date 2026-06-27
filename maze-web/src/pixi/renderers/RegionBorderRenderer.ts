import { Container, Graphics } from "pixi.js";
import { getCellVertices, getNeighborData } from "../tessellationGeometry";
import type { Pos } from "../tessellationGeometry";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";

export type RegionBorderGroup = { cells: [number, number][]; color: number; width: number; inset: number };

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

export class RegionBorderRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: RegionBorderGroup | RegionBorderGroup[], cfg?: TessellationConfig): void {
    this.g.clear();
    if (!cfg) return;
    const groups = Array.isArray(data) ? data : [data];
    for (const group of groups) {
      const cellSet = new Set(group.cells.map(([x, y]) => cellKey(x, y)));
      const edges = collectBoundaryEdges(group.cells, cellSet, cfg);
      const loops = traceLoops(edges);
      for (const loop of loops) {
        const simplified = simplifyLoop(loop);
        const shrunk = insetLoop(simplified, group.inset);
        this.g.poly(shrunk.flatMap(v => [v.x, v.y])).stroke({ color: group.color, width: group.width, alpha: 1, join: "miter" });
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}

function posKey(p: Pos): string {
  return `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
}

// Collects every cell edge that borders a cell outside the group (a different
// region, or no region), as directed segments walking counter-clockwise around
// the group's outer boundary (and the boundary of any holes).
function collectBoundaryEdges(cells: [number, number][], cellSet: Set<string>, cfg: TessellationConfig): [Pos, Pos][] {
  const edges: [Pos, Pos][] = [];
  for (const [x, y] of cells) {
    const verts = getCellVertices(x, y, cfg);
    if (!verts) continue;
    const { offsets, edgeVerts } = getNeighborData(cfg, x, y);
    for (let i = 0; i < offsets.length; i++) {
      const nx = x + offsets[i][0];
      const ny = y + offsets[i][1];
      if (cellSet.has(cellKey(nx, ny))) continue;
      const [vi, vj] = edgeVerts[i];
      edges.push([verts[vi], verts[vj]]);
    }
  }
  return edges;
}

// Traces directed boundary edges into closed loops by chaining each edge's end
// point to the next edge starting there. Cell edges are wound consistently, so
// boundary edges concatenate into clean loops without per-cell corner seams.
function traceLoops(edges: [Pos, Pos][]): Pos[][] {
  const byStart = new Map<string, [Pos, Pos][]>();
  for (const e of edges) {
    const k = posKey(e[0]);
    const list = byStart.get(k);
    if (list) list.push(e);
    else byStart.set(k, [e]);
  }
  const used = new Set<[Pos, Pos]>();
  const loops: Pos[][] = [];
  for (const e of edges) {
    if (used.has(e)) continue;
    const loop: Pos[] = [e[0]];
    let cur = e;
    while (!used.has(cur)) {
      used.add(cur);
      loop.push(cur[1]);
      const candidates = byStart.get(posKey(cur[1]));
      const next = candidates?.find(c => !used.has(c));
      if (!next) break;
      cur = next;
    }
    loop.pop();
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// Drops vertices where the incoming and outgoing edges are collinear, so a
// straight wall shared by many cells becomes a single long edge instead of a
// chain of tiny collinear segments (which made insetLoop zigzag along it).
function simplifyLoop(loop: Pos[]): Pos[] {
  const n = loop.length;
  if (n < 3) return loop;
  const result: Pos[] = [];
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const cur = loop[i];
    const next = loop[(i + 1) % n];
    const d1x = cur.x - prev.x, d1y = cur.y - prev.y;
    const d2x = next.x - cur.x, d2y = next.y - cur.y;
    const cross = d1x * d2y - d1y * d2x;
    const len1 = Math.hypot(d1x, d1y) || 1;
    const len2 = Math.hypot(d2x, d2y) || 1;
    if (Math.abs(cross) / (len1 * len2) > 1e-6) result.push(cur);
  }
  return result.length >= 3 ? result : loop;
}

// Offsets a closed loop inward by moving every edge along its normal, then
// re-deriving each vertex as the intersection of its two adjacent shifted
// edges, so corners stay sharp and consistent regardless of angle.
function insetLoop(loop: Pos[], inset: number): Pos[] {
  const n = loop.length;
  const lines: { p: Pos; d: Pos }[] = [];
  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    lines.push({ p: { x: a.x + nx * inset, y: a.y + ny * inset }, d: { x: dx, y: dy } });
  }
  const result: Pos[] = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i - 1 + n) % n];
    const cur = lines[i];
    result.push(intersectLines(prev.p, prev.d, cur.p, cur.d) ?? loop[i]);
  }
  return result;
}

function intersectLines(p1: Pos, d1: Pos, p2: Pos, d2: Pos): Pos | null {
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / denom;
  return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
}
