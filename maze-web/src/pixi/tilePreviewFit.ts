import { Container, Graphics } from "pixi.js";
import type { Pos } from "./tessellationGeometry";
import { WALL_THICKNESS } from "./renderConstants";

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

/** Outward margin, in the same world units as `verts`/`WALL_THICKNESS`, applied to the mask polygon
 * before masking (GitHub issue #632) — a passage/wall segment drawn exactly along the tile boundary
 * (every ordinary split face line does) sits precisely on `verts`' own edge, so a mask built from
 * `verts` unmodified clips half its stroke width away via ordinary anti-aliasing/rounding. Half the
 * stroke width is exactly enough to clear that: the other half of the same stroke still lies inside
 * the tile, so nothing of the line is genuinely outside this margin. */
const CLIP_MARGIN = WALL_THICKNESS / 2;

/** Pushes each vertex of a convex polygon outward along the average of its two adjacent edges'
 * outward normals, by `dist` — every tessellation's tile (`squareVertices`/hex/tri) is convex, so
 * this simple per-vertex offset (not a full polygon offset/Minkowski sum) keeps every edge
 * parallel-shifted outward by `dist`. Winding order is NOT assumed consistent across
 * tessellations — `squareVertices`/`triVertices` wind counter-clockwise while `hexVertices` winds
 * clockwise (same screen, Y-down coordinates), confirmed by each's shoelace-formula signed area —
 * so the outward sign is derived from `verts`' own signed area instead of hardcoded, or a
 * clockwise-wound tile (hex) would get pushed inward, clipping its boundary lines even harder. */
export function expandConvexPolygon(verts: Pos[], dist: number): Pos[] {
  const n = verts.length;
  let signedArea = 0;
  for (let i = 0; i < n; i++) {
    const p = verts[i], q = verts[(i + 1) % n];
    signedArea += p.x * q.y - q.x * p.y;
  }
  // Positive signed area (shoelace, Y-down screen coords) = counter-clockwise winding.
  const outwardSign = signedArea >= 0 ? 1 : -1;
  const edgeNormal = (a: Pos, b: Pos): Pos => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: (dy / len) * outwardSign, y: (-dx / len) * outwardSign };
  };
  return verts.map((v, i) => {
    const prev = verts[(i - 1 + n) % n];
    const next = verts[(i + 1) % n];
    const n0 = edgeNormal(prev, v);
    const n1 = edgeNormal(v, next);
    let nx = n0.x + n1.x, ny = n0.y + n1.y;
    const nlen = Math.hypot(nx, ny) || 1;
    nx /= nlen; ny /= nlen;
    // Scale by 1/cos(half the interior angle) so the *edges* (not just this vertex) end up shifted
    // outward by exactly `dist`, not `dist * cos(...)` — the averaged normal is shorter than either
    // individual edge normal whenever the vertex angle isn't straight.
    const cosHalf = nx * n0.x + ny * n0.y;
    const scale = dist / (cosHalf || 1);
    return { x: v.x + nx * scale, y: v.y + ny * scale };
  });
}

/** Masks `content` (a child of the same `world` `verts` is expressed in) to `verts`' own polygon,
 * expanded outward by half a wall stroke's width — see `fitTileToWorld`'s doc comment and
 * `CLIP_MARGIN`. A no-op if `verts` is empty (point has no resolvable tile geometry, e.g.
 * off-field). */
export function clipToTile(content: Container, verts: Pos[]): void {
  if (verts.length === 0) return;
  const expanded = expandConvexPolygon(verts, CLIP_MARGIN);
  const clip = new Graphics();
  clip.poly(expanded.flatMap((v) => [v.x, v.y])).fill({ color: 0xffffff });
  content.mask = clip;
  content.addChild(clip);
}
