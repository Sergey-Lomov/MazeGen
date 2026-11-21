export const TILE_SIZE = 40;

/** Shared padding ratio for every "fit to screen" viewport computation (GitHub issue #373 follow-up)
 * — `fitMazeViewport`/`fitFieldViewport` both scale their target bbox down by this factor so the
 * content never touches the screen edge. One constant keeps every auto-fit feature at the same
 * zoom percentage instead of drifting apart. */
export const VIEWPORT_FIT_PADDING = 0.9;
