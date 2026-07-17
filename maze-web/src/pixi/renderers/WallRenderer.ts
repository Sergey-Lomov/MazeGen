import { Container, Graphics } from "pixi.js";
import type { WallEdge } from "./types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { getCellVertices, getNeighborData } from "../tessellationGeometry";
import { drawOneWayTriangle } from "./wallUtils";
import { WALL_THICKNESS } from "../renderConstants";
import { canvas } from "../colorTokens";

const WALL_STYLES = {
  solid:      { color: canvas.wall.default,     cap: "round" as const, join: "round" as const },
  faint:      { color: canvas.wall.undecided,   cap: "round" as const, join: "round" as const },
  background: { color: canvas.stage.background, cap: "round" as const, join: "round" as const },
};

export class WallRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { edges: WallEdge[] }, cfg?: TessellationConfig): void {
    this.g.clear();
    for (const edge of data.edges) {
      if (!cfg) continue;
      const seg = this.getEdgeSegment(edge, cfg);
      if (!seg) continue;

      const styleBase = WALL_STYLES[edge.style];
      this.g
        .moveTo(seg.v0.x, seg.v0.y)
        .lineTo(seg.v1.x, seg.v1.y)
        .stroke({ width: WALL_THICKNESS, ...styleBase });

      if (edge.oneWayDir) {
        const midX = (seg.v0.x + seg.v1.x) / 2;
        const midY = (seg.v0.y + seg.v1.y) / 2;
        drawOneWayTriangle(this.g, midX, midY, edge.oneWayDir.dx, edge.oneWayDir.dy);
      }
    }
  }

  private getEdgeSegment(
    edge: WallEdge,
    cfg: TessellationConfig,
  ): { v0: { x: number; y: number }; v1: { x: number; y: number } } | null {
    const [ax, ay] = edge.a;
    const [bx, by] = edge.b;
    const less = ax < bx || (ax === bx && ay < by);
    const [fx, fy] = less ? [ax, ay] : [bx, by];
    const [tx, ty] = less ? [bx, by] : [ax, ay];

    const verts = getCellVertices(fx, fy, cfg);
    if (!verts) return null;

    const { offsets, edgeVerts } = getNeighborData(cfg, fx, fy);
    const dx = tx - fx;
    const dy = ty - fy;
    for (let i = 0; i < offsets.length; i++) {
      if (offsets[i][0] === dx && offsets[i][1] === dy) {
        const [vi, vj] = edgeVerts[i];
        return { v0: verts[vi], v1: verts[vj] };
      }
    }
    return null;
  }

  destroy(): void {
    this.g.destroy();
  }
}
