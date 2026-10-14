type Point = { x: number; y: number };

/** Signed distance from `point` to the nearest face line of a convex polygon (either winding):
 *  negative inside, positive outside. */
export function convexPolygonOutsideDistance(point: Point, polygon: readonly Point[]): number {
  const area = polygon.reduce((sum, a, index) => {
    const b = polygon[(index + 1) % polygon.length];
    return sum + a.x * b.y - b.x * a.y;
  }, 0);
  return Math.max(...polygon.map((a, index) => {
    const b = polygon[(index + 1) % polygon.length];
    const cross = ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y);
    return area > 0 ? -cross : cross;
  }));
}
