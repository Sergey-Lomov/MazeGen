import { Container, Graphics, GraphicsContext } from "pixi.js";
import type { CorridorPoint } from "./vectorByCorridorsContour";

/** One tile to place: `key` names its shape (equal keys draw equal shapes), `offset` its position. */
export type CorridorTileInstance = { cellId: string | number; key: string; offset: CorridorPoint };

/** Draws the corridor network as one `Graphics` per cell (GitHub issue #736). Every distinct shape
 *  key is traced once into a white `GraphicsContext`, so Pixi triangulates it once; every tile with
 *  that key shares it, positioned at its offset and tinted with the corridor color.
 *
 *  `update` is incremental: a cell whose key and offset are unchanged keeps its `Graphics` as is, a
 *  changed cell swaps context/position in place, and only added/removed cells create/destroy
 *  objects. Contexts no tile uses any more are destroyed after each update. */
export class CorridorTileLayer {
  readonly container = new Container();
  private readonly contexts = new Map<string, GraphicsContext>();
  private readonly tiles = new Map<string | number, { key: string; offset: CorridorPoint; graphics: Graphics }>();
  private tint = 0xffffff;

  update<T extends CorridorTileInstance>(instances: readonly T[], trace: (instance: T, context: GraphicsContext) => void): void {
    const seen = new Set<string | number>();
    for (const instance of instances) {
      seen.add(instance.cellId);
      let context = this.contexts.get(instance.key);
      if (!context) {
        context = new GraphicsContext();
        trace(instance, context);
        this.contexts.set(instance.key, context);
      }
      const tile = this.tiles.get(instance.cellId);
      if (!tile) {
        const graphics = new Graphics(context);
        graphics.position.set(instance.offset.x, instance.offset.y);
        graphics.tint = this.tint;
        this.container.addChild(graphics);
        this.tiles.set(instance.cellId, { key: instance.key, offset: instance.offset, graphics });
        continue;
      }
      if (tile.key !== instance.key) {
        tile.graphics.context = context;
        tile.key = instance.key;
      }
      if (tile.offset.x !== instance.offset.x || tile.offset.y !== instance.offset.y) {
        tile.graphics.position.set(instance.offset.x, instance.offset.y);
        tile.offset = instance.offset;
      }
    }
    for (const [cellId, tile] of this.tiles) {
      if (seen.has(cellId)) continue;
      tile.graphics.destroy();
      this.tiles.delete(cellId);
    }
    const used = new Set<string>();
    for (const tile of this.tiles.values()) used.add(tile.key);
    for (const [key, context] of this.contexts) {
      if (used.has(key)) continue;
      context.destroy();
      this.contexts.delete(key);
    }
  }

  setTint(color: number): void {
    if (color === this.tint) return;
    this.tint = color;
    for (const tile of this.tiles.values()) tile.graphics.tint = color;
  }

  destroy(): void {
    for (const tile of this.tiles.values()) tile.graphics.destroy();
    for (const context of this.contexts.values()) context.destroy();
    this.tiles.clear();
    this.contexts.clear();
    this.container.destroy();
  }
}
