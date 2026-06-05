import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import type { NodeDto } from "../wasm/types";
import { TILE_SIZE } from "./constants";

const MASK_ALPHA = 0.45;

// Quantized hue palette: 12 steps of 30°, pre-ordered by golden-angle jumps
// so consecutive indices are maximally separated on the color wheel.
// Skips 60° (yellow) and 120° (yellow-green) which look similar to neighbours.
const HUE_PALETTE = [0, 210, 30, 270, 90, 330, 150, 60, 240, 120, 300, 180];

function hslToRgb(h: number, s: number, l: number): number {
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

function buildPalette(count: number): number[] {
  const S = 0.65;
  const L = 0.65;
  const used: number[] = [];

  for (let i = 0; i < count; i++) {
    // Pick next hue from palette not too close to any already used
    let best = HUE_PALETTE[i % HUE_PALETTE.length];
    let bestDist = 0;
    for (const candidate of HUE_PALETTE) {
      const minDist = used.reduce((d, u) => {
        const diff = Math.abs(candidate - u);
        return Math.min(d, diff, 360 - diff);
      }, 360);
      if (minDist > bestDist) {
        bestDist = minDist;
        best = candidate;
      }
      if (bestDist >= 30) break;
    }
    used.push(best);
  }

  return used.map(h => hslToRgb(h, S, L));
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
    let prevNodes = useMazeStore.getState().nodes;
    let prevComponents = useMazeStore.getState().components;
    this.unsubscribe = useMazeStore.subscribe((state) => {
      if (state.nodes !== prevNodes || state.components !== prevComponents) {
        prevNodes = state.nodes;
        prevComponents = state.components;
        this.render(state.nodes, state.components);
      }
    });
  }

  private render(nodes: NodeDto[], components: number[][]): void {
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
        const x = node.x * TILE_SIZE;
        const y = -node.y * TILE_SIZE - TILE_SIZE;
        this.graphics.rect(x, y, TILE_SIZE, TILE_SIZE).fill({ color, alpha: MASK_ALPHA });
      }
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.graphics.destroy();
  }
}
