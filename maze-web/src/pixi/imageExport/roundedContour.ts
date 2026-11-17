export type Point = [number, number];

/** One softened corner: the contour runs straight to `entry`, then bends through `corner` (the quadratic control point) to `exit`. */
export type RoundedCorner = { entry: Point; corner: Point; exit: Point };

/** Softened corners of a closed `polygon`: each corner is cut `radius` back along the edge before it and forward along the edge
 *  after it. The cut-in is capped at half of the shorter neighbouring edge, so the curves of a thin or sharply folded shape (unlike
 *  `roundShape`'s fixed-radius arcs) never run into each other. Fewer than 3 points yield no corners. */
export function roundedContourCorners(polygon: readonly Point[], radius: number): RoundedCorner[] {
  const n = polygon.length;
  if (n < 3) return [];
  const toward = (from: Point, to: Point, distance: number): Point => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    return length < 1e-9 ? from : [from[0] + ((to[0] - from[0]) * distance) / length, from[1] + ((to[1] - from[1]) * distance) / length];
  };
  const edge = (i: number) => Math.hypot(polygon[(i + 1) % n][0] - polygon[i][0], polygon[(i + 1) % n][1] - polygon[i][1]);
  return polygon.map((corner, i) => {
    const previous = polygon[(i + n - 1) % n], next = polygon[(i + 1) % n];
    const cut = Math.min(radius, edge((i + n - 1) % n) / 2, edge(i) / 2);
    return { entry: toward(corner, previous, cut), corner, exit: toward(corner, next, cut) };
  });
}
