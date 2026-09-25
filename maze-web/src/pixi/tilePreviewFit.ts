import { Container, Graphics } from "pixi.js";
import type { Pos } from "./tessellationGeometry";

/** Shared by `SplitPointPixiPreview`/`PresetSplitPointPixiPreview` (GitHub issue #609) — both are
 * tiny single-tile Pixi previews built from a selector that resolves the *whole floor's* split
 * geometry (`buildSplitPassages`/`buildPresetSplitPassages`, since a split point's faces resolve
 * against its neighbours' nodes), so a neighbouring split point's own geometry is drawn right
 * alongside this point's — without clipping, it bleeds into the preview whenever it happens to
 * fall within the canvas's pixel bounds. `fitTileToWorld` scales/positions `world` so `verts`
 * (plus `center`, for a margin that accounts for the tile's own hub point) fills the canvas;
 * `clipToTile` then masks a `content` container (added as `world`'s child, meant to hold every
 * drawn layer) to `verts`' own polygon, so only this tile's own shape is ever visible. */
export function fitTileToWorld(world: Container, verts: Pos[], center: Pos, size: number, pad = 6): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of [...verts, center]) {
    minX = Math.min(minX, v.x); minY = Math.min(minY, v.y);
    maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y);
  }
  const w = maxX - minX + pad * 2, h = maxY - minY + pad * 2;
  const scale = Math.min(size / w, size / h);
  world.scale.set(scale);
  world.position.set(
    (size - w * scale) / 2 - (minX - pad) * scale,
    (size - h * scale) / 2 - (minY - pad) * scale,
  );
  return scale;
}

/** Masks `content` (a child of the same `world` `verts` is expressed in) to `verts`' own polygon —
 * see `fitTileToWorld`'s doc comment. A no-op if `verts` is empty (point has no resolvable tile
 * geometry, e.g. off-field). */
export function clipToTile(content: Container, verts: Pos[]): void {
  if (verts.length === 0) return;
  const clip = new Graphics();
  clip.poly(verts.flatMap((v) => [v.x, v.y])).fill({ color: 0xffffff });
  content.mask = clip;
  content.addChild(clip);
}
