import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import type { NodeDto, EdgeDto } from "../wasm/types";
import { TILE_SIZE, NODE_RADIUS, NODE_START_COLOR, NODE_FINISH_COLOR } from "./constants";

const WALL_THICKNESS = 3;
const WALL_COLOR = 0xcccccc;
const FLOOR_COLOR = 0x2a2a2a;
const ONE_WAY_COLOR = 0xffaa00;

interface Pos { x: number; y: number; }

export type PassageKind = "both" | "forward" | "backward" | "none";

export function buildPassageMap(nodes: NodeDto[], edges: EdgeDto[]): Map<string, PassageKind> {
  const nodeById = new Map<number, NodeDto>();
  for (const n of nodes) nodeById.set(n.id, n);

  const directed = new Set<string>();
  for (const e of edges) {
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to) continue;
    directed.add(`${from.x},${from.y}->${to.x},${to.y}`);
  }

  const result = new Map<string, PassageKind>();

  // Each pair key "x1,y1:x2,y2" is written by the node with smaller coords (east/north owner).
  // West and south edges are owned by the respective neighbor, so no duplicate writes occur
  // as long as nodes[] covers a complete rectangular grid (guaranteed by SquareField).
  for (const n of nodes) {
    const eKey = `${n.x},${n.y}:${n.x + 1},${n.y}`;
    if (!result.has(eKey)) {
      const fwd = directed.has(`${n.x},${n.y}->${n.x + 1},${n.y}`);
      const bwd = directed.has(`${n.x + 1},${n.y}->${n.x},${n.y}`);
      result.set(eKey, fwd && bwd ? "both" : fwd ? "forward" : bwd ? "backward" : "none");
    }
    const nKey = `${n.x},${n.y}:${n.x},${n.y + 1}`;
    if (!result.has(nKey)) {
      const fwd = directed.has(`${n.x},${n.y}->${n.x},${n.y + 1}`);
      const bwd = directed.has(`${n.x},${n.y + 1}->${n.x},${n.y}`);
      result.set(nKey, fwd && bwd ? "both" : fwd ? "forward" : bwd ? "backward" : "none");
    }
  }

  return result;
}

function tileTopLeft(node: NodeDto): Pos {
  return { x: node.x * TILE_SIZE, y: -node.y * TILE_SIZE - TILE_SIZE };
}

function drawOneWayTriangle(g: Graphics, wallCx: number, wallCy: number, pointingDx: number, pointingDy: number): void {
  const size = TILE_SIZE * 0.18;
  const px = -pointingDy;
  const py = pointingDx;
  const tipX = wallCx + pointingDx * size;
  const tipY = wallCy + pointingDy * size;
  const baseX = wallCx - pointingDx * size * 0.5;
  const baseY = wallCy - pointingDy * size * 0.5;
  g.poly([
    tipX, tipY,
    baseX + px * size * 0.6, baseY + py * size * 0.6,
    baseX - px * size * 0.6, baseY - py * size * 0.6,
  ]);
  g.fill(ONE_WAY_COLOR);
}

export class MazeTileRenderer {
  private viewport: Container;
  private tilesContainer: Container;
  private wallsContainer: Container;
  private markersContainer: Container;

  private unsubscribe: (() => void) | null = null;

  constructor(viewport: Container) {
    this.viewport = viewport;

    this.tilesContainer = new Container();
    this.wallsContainer = new Container();
    this.markersContainer = new Container();
    this.viewport.addChild(this.tilesContainer);
    this.viewport.addChild(this.wallsContainer);
    this.viewport.addChild(this.markersContainer);

    this.subscribeToStore();
  }

  private subscribeToStore(): void {
    let prev = useMazeStore.getState();
    this.unsubscribe = useMazeStore.subscribe((state) => {
      const mazeChanged = state.nodes !== prev.nodes || state.edges !== prev.edges
        || state.start !== prev.start || state.finish !== prev.finish;

      if (mazeChanged) {
        this.render(state.nodes, state.edges, state.start, state.finish);
      }

      prev = state;
    });

    const s = useMazeStore.getState();
    if (s.nodes.length > 0) {
      this.render(s.nodes, s.edges, s.start, s.finish);
    }
  }

  private render(nodes: NodeDto[], edges: EdgeDto[], start: number | null, finish: number | null): void {
    this.tilesContainer.destroy({ children: true });
    this.wallsContainer.destroy({ children: true });
    this.markersContainer.destroy({ children: true });
    this.tilesContainer = new Container();
    this.wallsContainer = new Container();
    this.markersContainer = new Container();
    this.viewport.addChild(this.tilesContainer);
    this.viewport.addChild(this.wallsContainer);
    this.viewport.addChild(this.markersContainer);

    if (nodes.length === 0) return;

    const passages = buildPassageMap(nodes, edges);
    // Single pass: build nodeCoords for wall ownership and nodeById for markers,
    // while drawing floor tiles.
    const nodeCoords = new Set<string>();
    const nodeById = new Map<number, NodeDto>();
    const floors = new Graphics();
    for (const node of nodes) {
      nodeCoords.add(`${node.x},${node.y}`);
      nodeById.set(node.id, node);
      const tl = tileTopLeft(node);
      floors.rect(tl.x, tl.y, TILE_SIZE, TILE_SIZE);
      floors.fill(FLOOR_COLOR);
    }
    this.tilesContainer.addChild(floors);

    // Draw walls as stroked line segments with round caps.
    // Each shared edge is owned by the node with smaller (x,y) to avoid duplicates:
    //   - horizontal wall (top of node): owned by the node below it (i.e. current node draws its own top edge)
    //   - vertical wall (right of node): owned by the node to the left (i.e. current node draws its own right edge)
    // Outer border walls are drawn by boundary nodes only.
    const wallsG = new Graphics();
    const oneWayG = new Graphics();

    const wallStyle = { width: WALL_THICKNESS, color: WALL_COLOR, cap: "round" as const, join: "round" as const };

    for (const node of nodes) {
      const tl = tileTopLeft(node);
      const tr = { x: tl.x + TILE_SIZE, y: tl.y };
      const bl = { x: tl.x, y: tl.y + TILE_SIZE };
      const br = { x: tl.x + TILE_SIZE, y: tl.y + TILE_SIZE };

      // --- TOP edge: shared with north neighbor ---
      const northKey = `${node.x},${node.y}:${node.x},${node.y + 1}`;
      const northPassage = passages.get(northKey) ?? "none";
      const hasNorth = nodeCoords.has(`${node.x},${node.y + 1}`);

      if (!hasNorth || northPassage === "none") {
        wallsG.moveTo(tl.x, tl.y).lineTo(tr.x, tr.y).stroke(wallStyle);
      } else if (northPassage !== "both") {
        wallsG.moveTo(tl.x, tl.y).lineTo(tr.x, tr.y).stroke(wallStyle);
        const wallCx = tl.x + TILE_SIZE / 2;
        const wallCy = tl.y;
        const dy = northPassage === "forward" ? -1 : 1;
        drawOneWayTriangle(oneWayG, wallCx, wallCy, 0, dy);
      }

      // --- RIGHT edge: shared with east neighbor ---
      const eastKey = `${node.x},${node.y}:${node.x + 1},${node.y}`;
      const eastPassage = passages.get(eastKey) ?? "none";
      const hasEast = nodeCoords.has(`${node.x + 1},${node.y}`);

      if (!hasEast || eastPassage === "none") {
        wallsG.moveTo(tr.x, tr.y).lineTo(br.x, br.y).stroke(wallStyle);
      } else if (eastPassage !== "both") {
        wallsG.moveTo(tr.x, tr.y).lineTo(br.x, br.y).stroke(wallStyle);
        const wallCx = tr.x;
        const wallCy = tr.y + TILE_SIZE / 2;
        const dx = eastPassage === "forward" ? 1 : -1;
        drawOneWayTriangle(oneWayG, wallCx, wallCy, dx, 0);
      }

      // --- BOTTOM edge: only outer border (no south neighbor) ---
      if (!nodeCoords.has(`${node.x},${node.y - 1}`)) {
        wallsG.moveTo(bl.x, bl.y).lineTo(br.x, br.y).stroke(wallStyle);
      }

      // --- LEFT edge: only outer border (no west neighbor) ---
      if (!nodeCoords.has(`${node.x - 1},${node.y}`)) {
        wallsG.moveTo(tl.x, tl.y).lineTo(bl.x, bl.y).stroke(wallStyle);
      }
    }

    this.wallsContainer.addChild(wallsG);
    this.wallsContainer.addChild(oneWayG);

    // Draw start/finish circles over tiles, matching graph node style
    const markersG = new Graphics();
    const startNode = start !== null ? nodeById.get(start) : undefined;
    const finishNode = finish !== null ? nodeById.get(finish) : undefined;
    if (startNode) {
      const cx = startNode.x * TILE_SIZE + TILE_SIZE / 2;
      const cy = -startNode.y * TILE_SIZE - TILE_SIZE / 2;
      markersG.circle(cx, cy, NODE_RADIUS).fill(NODE_START_COLOR);
    }
    if (finishNode) {
      const cx = finishNode.x * TILE_SIZE + TILE_SIZE / 2;
      const cy = -finishNode.y * TILE_SIZE - TILE_SIZE / 2;
      markersG.circle(cx, cy, NODE_RADIUS).fill(NODE_FINISH_COLOR);
    }
    this.markersContainer.addChild(markersG);
  }

  destroy(): void {
    this.unsubscribe?.();
    this.tilesContainer.destroy({ children: true });
    this.wallsContainer.destroy({ children: true });
    this.markersContainer.destroy({ children: true });
  }
}
