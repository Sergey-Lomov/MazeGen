import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import type { NodeDto, TessellationConfig } from "../wasm/types";
import { TILE_SIZE } from "./constants";
import { hexVertices, hexCenter } from "./hexGeometry";

const MASK_ALPHA = 0.45;

// Quantized hue palette: 12 steps of 30°, pre-ordered by golden-angle jumps
// so consecutive indices are maximally separated on the color wheel.
const HUE_PALETTE = [0, 210, 30, 270, 90, 330, 150, 60, 240, 120, 300, 180];

// Lightness levels per pass over the palette. Each pass uses a different L
// so that when all 12 hues are exhausted, the next 12 are visually distinct
// from the first (darker), preventing exact color duplicates.
const LIGHTNESS_PASSES = [0.65, 0.48, 0.78];

export function hslToRgb(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}

export function buildPalette(count: number): number[] {
  const S = 0.65;
  const result: number[] = [];
  // Single array reset at the start of each pass — no need to keep all passes in memory.
  let usedHues: number[] = [];
  let currentPass = 0;

  for (let i = 0; i < count; i++) {
    const pass = Math.floor(i / HUE_PALETTE.length);
    if (pass !== currentPass) {
      usedHues = [];
      currentPass = pass;
    }
    const L = LIGHTNESS_PASSES[pass % LIGHTNESS_PASSES.length];

    let best = HUE_PALETTE[0];
    let bestDist = -1;
    for (const candidate of HUE_PALETTE) {
      const minDist = usedHues.reduce((d, u) => {
        const diff = Math.abs(candidate - u);
        return Math.min(d, diff, 360 - diff);
      }, 360);
      if (minDist > bestDist) {
        bestDist = minDist;
        best = candidate;
      }
    }

    usedHues.push(best);
    result.push(hslToRgb(best, S, L));
  }

  return result;
}

export class ComponentRenderer {
  private container: Container;
  private graphics: Graphics;
  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.container = container;
    this.graphics = new Graphics();
    this.container.addChild(this.graphics);
    this.subscribe();
  }

  private subscribe(): void {
    let prev = useMazeStore.getState();
    this.unsubscribe = useMazeStore.subscribe((state) => {
      if (state.nodes !== prev.nodes || state.components !== prev.components
          || state.activeTessellationConfig !== prev.activeTessellationConfig) {
        prev = state;
        this.render(state.nodes, state.components, state.activeTessellationConfig);
      } else {
        prev = state;
      }
    });
  }

  private render(nodes: NodeDto[], components: number[][], cfg: TessellationConfig): void {
    this.graphics.clear();
    if (nodes.length === 0 || components.length === 0) return;

    const nodeById = new Map<number, NodeDto>();
    for (const n of nodes) nodeById.set(n.id, n);

    const palette = buildPalette(components.length);
    for (let compIdx = 0; compIdx < components.length; compIdx++) {
      const color = palette[compIdx];
      for (const nodeId of components[compIdx]) {
        const node = nodeById.get(nodeId);
        if (!node) continue;
        if (cfg.type === "square") {
          const x = node.x * TILE_SIZE;
          const y = -node.y * TILE_SIZE - TILE_SIZE;
          this.graphics.rect(x, y, TILE_SIZE, TILE_SIZE).fill({ color, alpha: MASK_ALPHA });
        } else if (cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon") {
          const orientation = cfg.orientation ?? "flat_top";
          const { x: cx, y: cy } = hexCenter(node.x, node.y, orientation);
          const verts = hexVertices(cx, cy, orientation);
          this.graphics.poly(verts.flatMap(v => [v.x, v.y])).fill({ color, alpha: MASK_ALPHA });
        } else {
          cfg satisfies never;
        }
      }
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.graphics.destroy();
  }
}
