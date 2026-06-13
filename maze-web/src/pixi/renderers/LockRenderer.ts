import { Container, Graphics } from "pixi.js";
import type { LockEntry } from "./types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { getCellCenter } from "../tessellationGeometry";
import { TILE_SIZE } from "../constants";
import { LOCK_COLOR, FLOOR_COLOR } from "../colorUtils";

export class LockRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { locks: LockEntry[] }, cfg: TessellationConfig): void {
    this.g.clear();
    for (const lock of data.locks) {
      const c = getCellCenter(lock.x, lock.y, cfg);
      drawLockIcon(this.g, c.x, c.y, lock.type);
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}

function drawLockIcon(g: Graphics, cx: number, cy: number, type: "in" | "out" | "both"): void {
  const bw = TILE_SIZE * 0.46;
  const bh = TILE_SIZE * 0.36;
  const arcR = bw * 0.30;
  const totalH = arcR + bh;
  const bodyTop = cy - totalH / 2 + arcR;
  const bodyCy = bodyTop + bh / 2;

  g.roundRect(cx - bw / 2, bodyTop, bw, bh, bw * 0.12).fill(LOCK_COLOR);

  g.setStrokeStyle({ width: bw * 0.14, color: LOCK_COLOR, cap: "round" as const });
  g.moveTo(cx - arcR, bodyTop);
  g.arc(cx, bodyTop, arcR, Math.PI, 0);
  g.stroke();

  if (type !== "both") {
    const s = bw * 0.28;
    const h = s * Math.sqrt(3) / 2;
    const offset = bw * 0.22;

    if (type === "out") {
      g.poly([cx - offset, bodyCy - s / 2, cx - offset, bodyCy + s / 2, cx - offset - h, bodyCy]).fill(FLOOR_COLOR);
      g.poly([cx + offset, bodyCy - s / 2, cx + offset, bodyCy + s / 2, cx + offset + h, bodyCy]).fill(FLOOR_COLOR);
    } else {
      g.poly([cx - offset - h, bodyCy - s / 2, cx - offset - h, bodyCy + s / 2, cx - offset, bodyCy]).fill(FLOOR_COLOR);
      g.poly([cx + offset + h, bodyCy - s / 2, cx + offset + h, bodyCy + s / 2, cx + offset, bodyCy]).fill(FLOOR_COLOR);
    }
  }
}
