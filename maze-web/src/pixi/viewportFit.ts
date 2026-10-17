import { TILE_SIZE, VIEWPORT_FIT_PADDING } from "./constants";
import { getCellCenter } from "./tessellationGeometry";
import type { FieldConfig } from "../fieldConfig";

/** Computes the viewport transform that fits generated maze nodes onto the screen (GitHub issue
 * #373). Unifies the auto-fit rule across every maze-showing feature: the target scale is driven
 * by the *largest* floor's own bounding box (max width, max height independently — possibly from
 * two different floors), not by the active floor's own size or by a union bbox across floors,
 * so switching floors or features never changes the zoom level, only what's centered. `nodes`
 * must carry every floor's nodes (unscoped) with `level` set; `levelConfigs[i]` is the
 * `FieldConfig` for floor index `i` (`node.level ?? 0`), since a floor's own field shape
 * can differ from its neighbors'. The viewport is centered on `activeLevel`'s own bbox center. */
export function fitMazeViewport(
  levelConfigs: FieldConfig[],
  nodes: { x: number; y: number; id: number; level?: number }[],
  activeLevel: number,
  screenW: number,
  screenH: number,
): { x: number; y: number; scale: number } {
  const byLevel = new Map<number, { x: number; y: number }[]>();
  for (const n of nodes) {
    const level = n.level ?? 0;
    const cfg = levelConfigs[level] ?? levelConfigs[0];
    const center = getCellCenter(n.x, n.y, cfg);
    let list = byLevel.get(level);
    if (!list) { list = []; byLevel.set(level, list); }
    list.push(center);
  }

  let maxW = 0, maxH = 0;
  let activeBounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const [level, centers] of byLevel) {
    const bounds = centersBounds(centers, TILE_SIZE);
    maxW = Math.max(maxW, bounds.maxX - bounds.minX);
    maxH = Math.max(maxH, bounds.maxY - bounds.minY);
    if (level === activeLevel) activeBounds = bounds;
  }
  if (maxW <= 0 || maxH <= 0) {
    return { x: screenW / 2, y: screenH / 2, scale: 1 };
  }

  const scale = Math.min(VIEWPORT_FIT_PADDING * screenW / maxW, VIEWPORT_FIT_PADDING * screenH / maxH);
  // Active floor has no nodes of its own (e.g. an empty floor) — still apply the correctly-sized
  // scale, just centered at the world origin instead of a nonexistent active-floor bbox center.
  const cx = activeBounds ? (activeBounds.minX + activeBounds.maxX) / 2 : 0;
  const cy = activeBounds ? (activeBounds.minY + activeBounds.maxY) / 2 : 0;

  return {
    scale,
    x: screenW / 2 - scale * cx,
    y: screenH / 2 - scale * cy,
  };
}

/** Bounding box of `centers`, expanded by `pad` on every side. */
function centersBounds(centers: { x: number; y: number }[], pad: number): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of centers) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}
