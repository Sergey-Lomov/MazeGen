import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { TILE_SIZE, NODE_RADIUS, NODE_START_COLOR, NODE_FINISH_COLOR, DEBUG_ACTIVE_COLOR, DEBUG_CURRENT_SRC_COLOR, DEBUG_ACTIVE_ALPHA, DEBUG_ACTIVE_RADIUS, DEBUG_CURRENT_SRC_RADIUS } from "./constants";
import { hexCenter, hexVertices } from "./hexGeometry";
import type { Pos } from "./hexGeometry";
import { squareCenter, squareVertices } from "./squareGeometry";
import { triCenter, triVertices } from "./triGeometry";
import type { TriOrientation } from "./triGeometry";

const WALL_THICKNESS = 3;
const WALL_COLOR = 0xcccccc;
const FLOOR_COLOR = 0x2a2a2a;
const ONE_WAY_COLOR = 0xffaa00;

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

export function drawOneWayTriangle(g: Graphics, wallCx: number, wallCy: number, pointingDx: number, pointingDy: number): void {
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

// Neighbor (dq,dr) for the shared edge between v[i] and v[(i+1)%6], per orientation.
// hexVertices: startAngle=0 (flat_top), π/2 (pointy_top), y-inverted screen coords.
// Flat-top:   v[0]=right, v[1]=top-right, v[2]=top-left, v[3]=left, v[4]=bottom-left, v[5]=bottom-right
// Pointy-top: v[0]=top,   v[1]=top-left,  v[2]=bottom-left, v[3]=bottom, v[4]=bottom-right, v[5]=top-right
const HEX_NEIGHBOR_OFFSETS_FLAT: [number, number][] = [
  [1, 0],   // E  — edge v[0]→v[1]
  [0, 1],   // SE — edge v[1]→v[2]
  [-1, 1],  // SW — edge v[2]→v[3]
  [-1, 0],  // W  — edge v[3]→v[4]
  [0, -1],  // NW — edge v[4]→v[5]
  [1, -1],  // NE — edge v[5]→v[0]
];
// Pointy-top (startAngle=π/2): v[0]=top, v[1]=top-left, v[2]=bottom-left, v[3]=bottom, v[4]=bottom-right, v[5]=top-right
const HEX_NEIGHBOR_OFFSETS_POINTY: [number, number][] = [
  [-1, 1],  // SW — edge v[0]→v[1]
  [-1, 0],  // W  — edge v[1]→v[2]
  [0, -1],  // NW — edge v[2]→v[3]
  [1, -1],  // NE — edge v[3]→v[4]
  [1, 0],   // E  — edge v[4]→v[5]
  [0, 1],   // SE — edge v[5]→v[0]
];

function renderSquare(
  nodes: NodeDto[],
  edges: EdgeDto[],
  start: number | null,
  finish: number | null,
  tilesContainer: Container,
  wallsContainer: Container,
  markersContainer: Container,
): void {
  const passages = buildPassageMap(nodes, edges);
  const nodeCoords = new Set<string>();
  const nodeById = new Map<number, NodeDto>();
  const floors = new Graphics();
  for (const node of nodes) {
    nodeCoords.add(`${node.x},${node.y}`);
    nodeById.set(node.id, node);
    const { x: cx, y: cy } = squareCenter(node.x, node.y);
    const verts = squareVertices(cx, cy);
    floors.poly(verts.flatMap(v => [v.x, v.y])).fill(FLOOR_COLOR);
  }
  tilesContainer.addChild(floors);

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

    if (!nodeCoords.has(`${node.x},${node.y - 1}`)) {
      wallsG.moveTo(bl.x, bl.y).lineTo(br.x, br.y).stroke(wallStyle);
    }

    if (!nodeCoords.has(`${node.x - 1},${node.y}`)) {
      wallsG.moveTo(tl.x, tl.y).lineTo(bl.x, bl.y).stroke(wallStyle);
    }
  }

  wallsContainer.addChild(wallsG);
  wallsContainer.addChild(oneWayG);

  const markersG = new Graphics();
  const startNode = start !== null ? nodeById.get(start) : undefined;
  const finishNode = finish !== null ? nodeById.get(finish) : undefined;
  if (startNode) {
    const { x: cx, y: cy } = squareCenter(startNode.x, startNode.y);
    markersG.circle(cx, cy, NODE_RADIUS).fill(NODE_START_COLOR);
  }
  if (finishNode) {
    const { x: cx, y: cy } = squareCenter(finishNode.x, finishNode.y);
    markersG.circle(cx, cy, NODE_RADIUS).fill(NODE_FINISH_COLOR);
  }
  markersContainer.addChild(markersG);
}

function renderHex(
  nodes: NodeDto[],
  edges: EdgeDto[],
  start: number | null,
  finish: number | null,
  orientation: "flat_top" | "pointy_top",
  tilesContainer: Container,
  wallsContainer: Container,
  markersContainer: Container,
): void {
  const nodeById = new Map<number, NodeDto>();
  // nodeCoords maps "q,r" → NodeDto for neighbor lookup
  const nodeCoords = new Map<string, NodeDto>();
  for (const n of nodes) {
    nodeById.set(n.id, n);
    nodeCoords.set(`${n.x},${n.y}`, n);
  }

  // Build directed edge set keyed by axial coords (topology-agnostic, reuses buildPassageMap logic)
  const directed = new Set<string>();
  for (const e of edges) {
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to) continue;
    directed.add(`${from.x},${from.y}->${to.x},${to.y}`);
  }

  const floors = new Graphics();
  const wallsG = new Graphics();
  const oneWayG = new Graphics();
  const markersG = new Graphics();

  const wallStyle = { width: WALL_THICKNESS, color: WALL_COLOR, cap: "round" as const, join: "round" as const };
  const neighborOffsets = orientation === "flat_top" ? HEX_NEIGHBOR_OFFSETS_FLAT : HEX_NEIGHBOR_OFFSETS_POINTY;

  for (const node of nodes) {
    const { x: cx, y: cy } = hexCenter(node.x, node.y, orientation);
    const verts = hexVertices(cx, cy, orientation);
    const flatVerts = verts.flatMap(v => [v.x, v.y]);
    floors.poly(flatVerts).fill(FLOOR_COLOR);

    for (let i = 0; i < 6; i++) {
      const [dq, dr] = neighborOffsets[i];
      const nq = node.x + dq;
      const nr = node.y + dr;
      const neighbor = nodeCoords.get(`${nq},${nr}`);

      const v0 = verts[i];
      const v1 = verts[(i + 1) % 6];

      if (!neighbor) {
        // External boundary — always draw
        wallsG.moveTo(v0.x, v0.y).lineTo(v1.x, v1.y).stroke(wallStyle);
      } else {
        // Shared edge — draw only if this node owns it (lexicographically smaller (q,r)).
        // Ownership check is valid only for non-wrapped fields.
        const ownsEdge = node.x < nq || (node.x === nq && node.y < nr);
        if (!ownsEdge) continue;

        const fwd = directed.has(`${node.x},${node.y}->${nq},${nr}`);
        const bwd = directed.has(`${nq},${nr}->${node.x},${node.y}`);

        if (fwd && bwd) {
          // Bidirectional passage — no wall
        } else if (!fwd && !bwd) {
          // No passage — draw wall
          wallsG.moveTo(v0.x, v0.y).lineTo(v1.x, v1.y).stroke(wallStyle);
        } else {
          // One-way passage — draw wall + marker
          wallsG.moveTo(v0.x, v0.y).lineTo(v1.x, v1.y).stroke(wallStyle);

          const midX = (v0.x + v1.x) / 2;
          const midY = (v0.y + v1.y) / 2;

          // Normal to edge v0→v1 (perpendicular, pointing outward from center)
          const edgeDx = v1.x - v0.x;
          const edgeDy = v1.y - v0.y;
          let normalX = -edgeDy;
          let normalY = edgeDx;

          // Sign: dot product with from→to direction
          // "forward" means node→neighbor; "backward" means neighbor→node
          const { x: ncx, y: ncy } = hexCenter(nq, nr, orientation);
          const toDx = fwd ? ncx - cx : cx - ncx;
          const toDy = fwd ? ncy - cy : cy - ncy;
          const dot = normalX * toDx + normalY * toDy;
          if (dot < 0) { normalX = -normalX; normalY = -normalY; }

          const len = Math.sqrt(normalX * normalX + normalY * normalY);
          drawOneWayTriangle(oneWayG, midX, midY, normalX / len, normalY / len);
        }
      }
    }
  }

  tilesContainer.addChild(floors);
  wallsContainer.addChild(wallsG);
  wallsContainer.addChild(oneWayG);

  // Start/finish markers
  const startNode = start !== null ? nodeById.get(start) : undefined;
  const finishNode = finish !== null ? nodeById.get(finish) : undefined;
  if (startNode) {
    const { x: cx, y: cy } = hexCenter(startNode.x, startNode.y, orientation);
    markersG.circle(cx, cy, NODE_RADIUS).fill(NODE_START_COLOR);
  }
  if (finishNode) {
    const { x: cx, y: cy } = hexCenter(finishNode.x, finishNode.y, orientation);
    markersG.circle(cx, cy, NODE_RADIUS).fill(NODE_FINISH_COLOR);
  }
  markersContainer.addChild(markersG);
}

// Neighbor offsets for triangle rendering (col + row parity).
// up(parity=0):   [Left=(-1,0), Right=(+1,0), Base=(0,-1)]  → vert pairs [v0↔v2, v0↔v1, v1↔v2]
// down(parity=1): [Left=(-1,0), Right=(+1,0), Base=(0,+1)]  → vert pairs [v0↔v2, v1↔v2, v0↔v1]
const TRI_NEIGHBOR_OFFSETS_UP:   [number, number][] = [[-1, 0], [1, 0], [0, -1]];
const TRI_NEIGHBOR_OFFSETS_DOWN: [number, number][] = [[-1, 0], [1, 0], [0,  1]];
const TRI_EDGE_VERTS_UP:   [number, number][] = [[0, 2], [0, 1], [1, 2]];
const TRI_EDGE_VERTS_DOWN: [number, number][] = [[0, 2], [1, 2], [0, 1]];

function renderTriangle(
  nodes: NodeDto[],
  edges: EdgeDto[],
  start: number | null,
  finish: number | null,
  orientation: TriOrientation,
  tilesContainer: Container,
  wallsContainer: Container,
  markersContainer: Container,
): void {
  const nodeById = new Map<number, NodeDto>();
  const nodeCoords = new Map<string, NodeDto>();
  for (const n of nodes) {
    nodeById.set(n.id, n);
    nodeCoords.set(`${n.x},${n.y}`, n);
  }

  const directed = new Set<string>();
  for (const e of edges) {
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to) continue;
    directed.add(`${from.x},${from.y}->${to.x},${to.y}`);
  }

  const floors = new Graphics();
  const wallsG = new Graphics();
  const oneWayG = new Graphics();
  const markersG = new Graphics();

  const wallStyle = { width: WALL_THICKNESS, color: WALL_COLOR, cap: "round" as const, join: "round" as const };

  for (const node of nodes) {
    const pointingUp = (node.x + node.y) % 2 === 0;
    const { x: cx, y: cy } = triCenter(node.x, node.y, orientation);
    const verts = triVertices(node.x, node.y, orientation);
    floors.poly(verts.flatMap(v => [v.x, v.y])).fill(FLOOR_COLOR);

    const neighborOffsets = pointingUp ? TRI_NEIGHBOR_OFFSETS_UP : TRI_NEIGHBOR_OFFSETS_DOWN;
    const edgeVerts = pointingUp ? TRI_EDGE_VERTS_UP : TRI_EDGE_VERTS_DOWN;

    for (let i = 0; i < 3; i++) {
      const [dq, dr] = neighborOffsets[i];
      const nq = node.x + dq;
      const nr = node.y + dr;
      const neighbor = nodeCoords.get(`${nq},${nr}`);

      const [vi, vj] = edgeVerts[i];
      const v0 = verts[vi];
      const v1 = verts[vj];

      if (!neighbor) {
        wallsG.moveTo(v0.x, v0.y).lineTo(v1.x, v1.y).stroke(wallStyle);
      } else {
        const ownsEdge = node.x < nq || (node.x === nq && node.y < nr);
        if (!ownsEdge) continue;

        const fwd = directed.has(`${node.x},${node.y}->${nq},${nr}`);
        const bwd = directed.has(`${nq},${nr}->${node.x},${node.y}`);

        if (fwd && bwd) {
          // bidirectional — no wall
        } else if (!fwd && !bwd) {
          wallsG.moveTo(v0.x, v0.y).lineTo(v1.x, v1.y).stroke(wallStyle);
        } else {
          wallsG.moveTo(v0.x, v0.y).lineTo(v1.x, v1.y).stroke(wallStyle);

          const midX = (v0.x + v1.x) / 2;
          const midY = (v0.y + v1.y) / 2;

          const edgeDx = v1.x - v0.x;
          const edgeDy = v1.y - v0.y;
          let normalX = -edgeDy;
          let normalY = edgeDx;

          const { x: ncx, y: ncy } = triCenter(nq, nr, orientation);
          const toDx = fwd ? ncx - cx : cx - ncx;
          const toDy = fwd ? ncy - cy : cy - ncy;
          const dot = normalX * toDx + normalY * toDy;
          if (dot < 0) { normalX = -normalX; normalY = -normalY; }

          const len = Math.sqrt(normalX * normalX + normalY * normalY);
          drawOneWayTriangle(oneWayG, midX, midY, normalX / len, normalY / len);
        }
      }
    }
  }

  tilesContainer.addChild(floors);
  wallsContainer.addChild(wallsG);
  wallsContainer.addChild(oneWayG);

  const startNode = start !== null ? nodeById.get(start) : undefined;
  const finishNode = finish !== null ? nodeById.get(finish) : undefined;
  if (startNode) {
    const { x: cx, y: cy } = triCenter(startNode.x, startNode.y, orientation);
    markersG.circle(cx, cy, NODE_RADIUS).fill(NODE_START_COLOR);
  }
  if (finishNode) {
    const { x: cx, y: cy } = triCenter(finishNode.x, finishNode.y, orientation);
    markersG.circle(cx, cy, NODE_RADIUS).fill(NODE_FINISH_COLOR);
  }
  markersContainer.addChild(markersG);
}

export class MazeTileRenderer {
  private viewport: Container;
  private tilesContainer: Container;
  private wallsContainer: Container;
  private markersContainer: Container;
  private debugOverlayContainer: Container;

  private unsubscribe: (() => void) | null = null;

  constructor(viewport: Container) {
    this.viewport = viewport;

    this.tilesContainer = new Container();
    this.wallsContainer = new Container();
    this.markersContainer = new Container();
    this.debugOverlayContainer = new Container();
    this.viewport.addChild(this.tilesContainer);
    this.viewport.addChild(this.wallsContainer);
    this.viewport.addChild(this.markersContainer);
    this.viewport.addChild(this.debugOverlayContainer);

    this.subscribeToStore();
  }

  private subscribeToStore(): void {
    let prev = useMazeStore.getState();
    this.unsubscribe = useMazeStore.subscribe((state) => {
      const renderNodes = state.debugMode && state.debugSnapshot
        ? state.debugSnapshot.nodes
        : state.nodes;
      const renderEdges = state.debugMode && state.debugSnapshot
        ? (state.debugSnapshot.steps[state.debugStep]?.edges ?? [])
        : state.edges;

      const prevRenderNodes = prev.debugMode && prev.debugSnapshot
        ? prev.debugSnapshot.nodes
        : prev.nodes;
      const prevRenderEdges = prev.debugMode && prev.debugSnapshot
        ? (prev.debugSnapshot.steps[prev.debugStep]?.edges ?? [])
        : prev.edges;

      const currentStep = state.debugMode && state.debugSnapshot
        ? state.debugSnapshot.steps[state.debugStep]
        : null;
      const prevStep = prev.debugMode && prev.debugSnapshot
        ? prev.debugSnapshot.steps[prev.debugStep]
        : null;

      const debugOverlayChanged = currentStep !== prevStep || state.debugMode !== prev.debugMode;

      const isLastDebugStep = state.debugMode && state.debugSnapshot
        ? state.debugStep === state.debugSnapshot.steps.length - 1
        : true;
      const renderStart  = (state.debugMode && state.debugSnapshot && !isLastDebugStep) ? null : state.start;
      const renderFinish = (state.debugMode && state.debugSnapshot && !isLastDebugStep) ? null : state.finish;

      const prevIsLastDebugStep = prev.debugMode && prev.debugSnapshot
        ? prev.debugStep === prev.debugSnapshot.steps.length - 1
        : true;
      const prevRenderStart  = (prev.debugMode && prev.debugSnapshot && !prevIsLastDebugStep) ? null : prev.start;
      const prevRenderFinish = (prev.debugMode && prev.debugSnapshot && !prevIsLastDebugStep) ? null : prev.finish;

      const mazeChanged = renderNodes !== prevRenderNodes || renderEdges !== prevRenderEdges
        || renderStart !== prevRenderStart || renderFinish !== prevRenderFinish
        || state.activeTessellationConfig !== prev.activeTessellationConfig;

      if (mazeChanged) {
        this.render(renderNodes, renderEdges, renderStart, renderFinish, state.activeTessellationConfig);
      }
      if (mazeChanged || debugOverlayChanged) {
        this.renderDebugOverlay(
          renderNodes,
          currentStep?.active_nodes ?? [],
          currentStep?.current_src ?? null,
          state.debugMode && !!currentStep,
          state.activeTessellationConfig,
        );
      }

      prev = state;
    });

    const s = useMazeStore.getState();
    if (s.nodes.length > 0) {
      this.render(s.nodes, s.edges, s.start, s.finish, s.activeTessellationConfig);
    }
  }

  private renderDebugOverlay(
    nodes: NodeDto[],
    activeNodes: number[],
    currentSrc: number | null,
    visible: boolean,
    cfg: TessellationConfig,
  ): void {
    this.debugOverlayContainer.removeChildren().forEach(c => c.destroy());

    if (!visible || nodes.length === 0) return;

    const nodeById = new Map<number, NodeDto>();
    for (const n of nodes) nodeById.set(n.id, n);

    const g = new Graphics();
    const activeSet = new Set(activeNodes);

    const getCenter = (node: NodeDto): { x: number; y: number } => {
      if (cfg.type === "square" || cfg.type === "square_custom") return squareCenter(node.x, node.y);
      if (cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon" || cfg.type === "hex_custom")
        return hexCenter(node.x, node.y, (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top");
      return triCenter(node.x, node.y, (cfg as { orientation?: "r0" | "r90" | "r180" | "r270" }).orientation ?? "r0");
    };

    for (const nodeId of activeSet) {
      const node = nodeById.get(nodeId);
      if (!node) continue;
      const { x: cx, y: cy } = getCenter(node);
      g.circle(cx, cy, DEBUG_ACTIVE_RADIUS)
        .fill({ color: DEBUG_ACTIVE_COLOR, alpha: DEBUG_ACTIVE_ALPHA });
    }

    if (currentSrc !== null && activeNodes.length > 0) {
      const srcNode = nodeById.get(currentSrc);
      if (srcNode) {
        const { x: cx, y: cy } = getCenter(srcNode);
        g.circle(cx, cy, DEBUG_CURRENT_SRC_RADIUS)
          .fill({ color: DEBUG_CURRENT_SRC_COLOR, alpha: 0.8 });
      }
    }

    this.debugOverlayContainer.addChild(g);
  }

  private render(nodes: NodeDto[], edges: EdgeDto[], start: number | null, finish: number | null, cfg: TessellationConfig): void {
    this.tilesContainer.destroy({ children: true });
    this.wallsContainer.destroy({ children: true });
    this.markersContainer.destroy({ children: true });
    this.tilesContainer = new Container();
    this.wallsContainer = new Container();
    this.markersContainer = new Container();
    this.viewport.addChildAt(this.tilesContainer, 0);
    this.viewport.addChildAt(this.wallsContainer, 1);
    this.viewport.addChildAt(this.markersContainer, 2);
    // debugOverlayContainer stays at index 3 (added once in constructor, never re-created)

    if (nodes.length === 0) return;

    if (cfg.type === "square" || cfg.type === "square_custom") {
      renderSquare(nodes, edges, start, finish, this.tilesContainer, this.wallsContainer, this.markersContainer);
    } else if (cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon" || cfg.type === "hex_custom") {
      renderHex(nodes, edges, start, finish, (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top", this.tilesContainer, this.wallsContainer, this.markersContainer);
    } else if (cfg.type === "triangle_rect" || cfg.type === "triangle_triangle" || cfg.type === "triangle_hexagon" || cfg.type === "tri_custom") {
      renderTriangle(nodes, edges, start, finish, (cfg as { orientation?: "r0" | "r90" | "r180" | "r270" }).orientation ?? "r0", this.tilesContainer, this.wallsContainer, this.markersContainer);
    } else {
      cfg satisfies never;
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.tilesContainer.destroy({ children: true });
    this.wallsContainer.destroy({ children: true });
    this.markersContainer.destroy({ children: true });
    this.debugOverlayContainer.destroy({ children: true });
  }
}
