import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { drawOneWayTriangle } from "./MazeTileRenderer";
import { canonicalize, edgeKey, computeInvalidKeysFromCells, resolveCells } from "./presetConnectionsUtils";
import type { FieldEdge } from "./presetConnectionsUtils";
import { encodePoint } from "./tessellationProjection";
import { getCellVertices, getCellCenter, getNeighborData, getSharedEdgeSegment } from "./tessellationGeometry";
import { NODE_RADIUS, NODE_START_COLOR, NODE_FINISH_COLOR } from "./constants";
import type { TessellationConfig } from "../wasm/types";

const WALL_THICKNESS = 3;
const WALL_COLOR = 0xcccccc;
const WALL_COLOR_UNDECIDED = 0x666666;
const FLOOR_COLOR = 0x2a2a2a;
const INVALID_COLOR = 0xddaa00;
const HOVER_COLOR = 0x44aaff;

export class PresetConnectionsRenderer {
  private readonly root: Container;
  private readonly floorsLayer: Graphics;
  private readonly undecidedLayer: Graphics;
  private readonly presetWallsLayer: Graphics;
  private readonly oneWayLayer: Graphics;
  private readonly markersLayer: Graphics;
  private readonly invalidHighlightLayer: Graphics;
  private readonly hoverLayer: Graphics;

  private cfg: TessellationConfig | null = null;
  private cachedCells: [number, number][] = [];
  private cachedCellSet: Set<number> = new Set();

  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.root = container;
    this.floorsLayer = new Graphics();
    this.undecidedLayer = new Graphics();
    this.presetWallsLayer = new Graphics();
    this.oneWayLayer = new Graphics();
    this.markersLayer = new Graphics();
    this.invalidHighlightLayer = new Graphics();
    this.hoverLayer = new Graphics();
    this.root.addChild(this.floorsLayer);
    this.root.addChild(this.undecidedLayer);
    this.root.addChild(this.presetWallsLayer);
    this.root.addChild(this.oneWayLayer);
    this.root.addChild(this.markersLayer);
    this.root.addChild(this.invalidHighlightLayer);
    this.root.addChild(this.hoverLayer);
    this.root.visible = false;

    this.unsubscribe = useMazeStore.subscribe((state, prev) => {
      const openChanged = state.presetConnectionsOpen !== prev.presetConnectionsOpen;

      if (openChanged) {
        this.root.visible = state.presetConnectionsOpen;
        if (state.presetConnectionsOpen) {
          this.cfg = state.tessellationConfig;
          this.rebuildCellCache(state);
          this.redraw(state);
        } else {
          this.clearAll();
        }
      }

      if (!state.presetConnectionsOpen) return;

      if (state.tessellationConfig !== prev.tessellationConfig) {
        this.cfg = state.tessellationConfig;
        this.rebuildCellCache(state);
        this.redraw(state);
        return;
      }

      const fieldChanged = state.fieldPoints !== prev.fieldPoints || state.fieldEditMode !== prev.fieldEditMode;
      if (fieldChanged) {
        this.rebuildCellCache(state);
      }

      if (
        fieldChanged ||
        state.presetConnections !== prev.presetConnections ||
        state.presetStart !== prev.presetStart ||
        state.presetFinish !== prev.presetFinish
      ) {
        this.redraw(state);
      }

      if (state.highlightInvalidPresets !== prev.highlightInvalidPresets) {
        this.redrawInvalidHighlight(state);
      }
    });
  }

  getCachedCells(): [number, number][] {
    return this.cachedCells;
  }

  getCachedCellSet(): Set<number> {
    return this.cachedCellSet;
  }

  onViewportChanged(_x: number, _y: number, _w: number, _h: number, _scale: number): void {
    // Transform synced via syncedLayers in MazeScene — no redraw needed.
  }

  updateHover(edge: FieldEdge | null): void {
    const g = this.hoverLayer;
    g.clear();
    if (!edge || !this.cfg) return;

    const seg = getSharedEdgeSegment(edge.from, edge.to, this.cfg);
    if (!seg) return;

    const w = WALL_THICKNESS * 2;
    g.setStrokeStyle({ width: w, color: HOVER_COLOR, alpha: 1.0, cap: "round" as const });
    g.moveTo(seg.v0.x, seg.v0.y).lineTo(seg.v1.x, seg.v1.y).stroke();
  }

  private clearAll(): void {
    this.floorsLayer.clear();
    this.undecidedLayer.clear();
    this.presetWallsLayer.clear();
    this.oneWayLayer.clear();
    this.markersLayer.clear();
    this.invalidHighlightLayer.clear();
    this.hoverLayer.clear();
  }

  private rebuildCellCache(state: ReturnType<typeof useMazeStore.getState>): void {
    if (!this.cfg) return;
    const customPts = state.fieldEditMode === "custom" && state.fieldPoints.size > 0
      ? state.fieldPoints
      : undefined;
    this.cachedCells = resolveCells(this.cfg, customPts);
    this.cachedCellSet = new Set(this.cachedCells.map(([x, y]) => encodePoint(x, y)));
  }

  private redraw(state: ReturnType<typeof useMazeStore.getState>): void {
    if (!this.cfg) return;
    this.floorsLayer.clear();
    this.undecidedLayer.clear();
    this.presetWallsLayer.clear();
    this.oneWayLayer.clear();
    this.markersLayer.clear();
    this.invalidHighlightLayer.clear();
    this.hoverLayer.clear();

    const cfg = this.cfg;
    const cells = this.cachedCells;
    const cellSet = this.cachedCellSet;

    // Build interior edge key set from cached cells
    const edgeKeySet = new Set<string>();
    {
      const seen = new Set<string>();
      for (const [x, y] of cells) {
        const { offsets } = getNeighborData(cfg, x, y);
        for (const [dx, dy] of offsets) {
          const nx = x + dx, ny = y + dy;
          if (!cellSet.has(encodePoint(nx, ny))) continue;
          const key = edgeKey([x, y], [nx, ny]);
          if (!seen.has(key)) { seen.add(key); edgeKeySet.add(key); }
        }
      }
    }

    const invalidKeys = computeInvalidKeysFromCells(state.presetConnections, cells);

    const wallStyleSolid = { width: WALL_THICKNESS, color: WALL_COLOR, cap: "round" as const, join: "round" as const };
    const wallStyleFaint = { width: WALL_THICKNESS, color: WALL_COLOR_UNDECIDED, cap: "round" as const, join: "round" as const };
    const wallStyleInvalid = { width: WALL_THICKNESS, color: INVALID_COLOR, cap: "round" as const, join: "round" as const };
    const uG = this.undecidedLayer;
    const wG = this.presetWallsLayer;
    const owG = this.oneWayLayer;

    for (const [x, y] of cells) {
      const verts = getCellVertices(x, y, cfg);
      if (!verts) continue;
      this.floorsLayer.poly(verts.flatMap(v => [v.x, v.y])).fill(FLOOR_COLOR);
    }

    const drawnKeys = new Set<string>();

    for (const [x, y] of cells) {
      const verts = getCellVertices(x, y, cfg);
      if (!verts) continue;
      const { offsets, edgeVerts } = getNeighborData(cfg, x, y);

      for (let i = 0; i < offsets.length; i++) {
        const [dx, dy] = offsets[i];
        const nx = x + dx;
        const ny = y + dy;
        const [vi, vj] = edgeVerts[i];
        const v0 = verts[vi];
        const v1 = verts[vj];

        if (!cellSet.has(encodePoint(nx, ny))) {
          wG.moveTo(v0.x, v0.y).lineTo(v1.x, v1.y).stroke(wallStyleSolid);
          continue;
        }

        const key = edgeKey([x, y], [nx, ny]);
        if (drawnKeys.has(key)) continue;
        drawnKeys.add(key);

        if (!edgeKeySet.has(key)) continue;

        const entry = state.presetConnections.get(key);

        if (!entry) {
          uG.moveTo(v0.x, v0.y).lineTo(v1.x, v1.y).stroke(wallStyleFaint);
          continue;
        }

        switch (entry.state) {
          case "wall":
            wG.moveTo(v0.x, v0.y).lineTo(v1.x, v1.y).stroke(wallStyleSolid);
            break;

          case "passage":
            break;

          case "one_way_forward":
          case "one_way_backward": {
            wG.moveTo(v0.x, v0.y).lineTo(v1.x, v1.y).stroke(wallStyleSolid);

            const midX = (v0.x + v1.x) / 2;
            const midY = (v0.y + v1.y) / 2;
            const edgeDx = v1.x - v0.x;
            const edgeDy = v1.y - v0.y;
            let normalX = -edgeDy;
            let normalY = edgeDx;

            const [fa, fb] = canonicalize([x, y], [nx, ny]);
            const cA = getCellCenter(fa[0], fa[1], cfg);
            const cB = getCellCenter(fb[0], fb[1], cfg);
            const isForward = entry.state === "one_way_forward";
            const toDx = isForward ? cB.x - cA.x : cA.x - cB.x;
            const toDy = isForward ? cB.y - cA.y : cA.y - cB.y;
            if (normalX * toDx + normalY * toDy < 0) { normalX = -normalX; normalY = -normalY; }

            const len = Math.sqrt(normalX * normalX + normalY * normalY);
            if (len > 0) drawOneWayTriangle(owG, midX, midY, normalX / len, normalY / len);
            break;
          }
        }
      }
    }

    // Draw invalid preset connections as yellow segments
    for (const key of invalidKeys) {
      const entry = state.presetConnections.get(key);
      if (!entry) continue;
      const seg = getSharedEdgeSegment(entry.from, entry.to, cfg);
      if (seg) {
        wG.moveTo(seg.v0.x, seg.v0.y).lineTo(seg.v1.x, seg.v1.y).stroke(wallStyleInvalid);
      } else {
        const cA = getCellCenter(entry.from[0], entry.from[1], cfg);
        const cB = getCellCenter(entry.to[0], entry.to[1], cfg);
        wG.moveTo(cA.x, cA.y).lineTo(cB.x, cB.y).stroke(wallStyleInvalid);
      }
    }

    const mG = this.markersLayer;
    if (state.presetStart) {
      const c = getCellCenter(state.presetStart[0], state.presetStart[1], cfg);
      mG.circle(c.x, c.y, NODE_RADIUS * 2).fill(NODE_START_COLOR);
    }
    if (state.presetFinish) {
      const c = getCellCenter(state.presetFinish[0], state.presetFinish[1], cfg);
      mG.circle(c.x, c.y, NODE_RADIUS * 2).fill(NODE_FINISH_COLOR);
    }

    this.redrawInvalidHighlight(state);
  }

  private redrawInvalidHighlight(state: ReturnType<typeof useMazeStore.getState>): void {
    const g = this.invalidHighlightLayer;
    g.clear();
    if (!state.highlightInvalidPresets || !this.cfg) return;
    const cfg = this.cfg;

    const invalidKeys = computeInvalidKeysFromCells(state.presetConnections, this.cachedCells);
    if (invalidKeys.size === 0) return;

    const highlightStyle = { width: WALL_THICKNESS * 2.5, color: INVALID_COLOR, alpha: 0.9, cap: "round" as const };

    for (const key of invalidKeys) {
      const entry = state.presetConnections.get(key);
      if (!entry) continue;
      const seg = getSharedEdgeSegment(entry.from, entry.to, cfg);
      if (seg) {
        g.moveTo(seg.v0.x, seg.v0.y).lineTo(seg.v1.x, seg.v1.y).stroke(highlightStyle);
      } else {
        const cA = getCellCenter(entry.from[0], entry.from[1], cfg);
        const cB = getCellCenter(entry.to[0], entry.to[1], cfg);
        g.moveTo(cA.x, cA.y).lineTo(cB.x, cB.y).stroke(highlightStyle);
      }
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.floorsLayer.destroy();
    this.undecidedLayer.destroy();
    this.presetWallsLayer.destroy();
    this.oneWayLayer.destroy();
    this.markersLayer.destroy();
    this.invalidHighlightLayer.destroy();
    this.hoverLayer.destroy();
  }
}
