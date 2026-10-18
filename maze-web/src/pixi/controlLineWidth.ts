const MINIMUM_SCREEN_STROKE_WIDTH = 1.25;

/** Keeps editor controls usable when their world-space layer is zoomed out. */
export function controlLineWidth(width: number, viewportScale: number): number {
  return Math.max(width, MINIMUM_SCREEN_STROKE_WIDTH / Math.max(viewportScale, Number.EPSILON));
}
