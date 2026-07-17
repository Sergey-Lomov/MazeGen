export const NODE_RADIUS = 6;
export const WALL_THICKNESS = 3;

// Compensation only kicks in for vpScale in this range — clamped before the division so it
// doesn't shrink further once zoomed in past 1x (screen size already ample) and doesn't grow
// unbounded once zoomed out past MIN_ADAPTIVE_VPSCALE (many cells visible — issue #119).
const MAX_ADAPTIVE_VPSCALE = 1;
const MIN_ADAPTIVE_VPSCALE = 0.25;

/** Keeps a stroke/marker at a constant on-screen size across a bounded zoom range — world-space
 *  size is divided by a clamped `vpScale` so that after the viewport's own scale transform is
 *  applied, the rendered pixel size stays `baseWidth` between `MIN_ADAPTIVE_VPSCALE` and
 *  `MAX_ADAPTIVE_VPSCALE`, and is left at its zoom-1x/zoom-MIN size beyond either bound. */
export function adaptiveLineWidth(vpScale: number, baseWidth: number): number {
  const clamped = Math.min(MAX_ADAPTIVE_VPSCALE, Math.max(MIN_ADAPTIVE_VPSCALE, vpScale));
  return baseWidth / clamped;
}
