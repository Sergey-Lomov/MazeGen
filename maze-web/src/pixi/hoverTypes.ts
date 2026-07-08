export interface HoverInfo {
  x: number;
  y: number;
}

export interface HoverProvider {
  /** canvasX/canvasY are raw DOM pointer-event coordinates (canvas-space, before viewport
   * pan/zoom is undone) — each provider does its own transform into world/grid space.
   * Returns null only when hover info cannot be determined at all (no active projection/viewport
   * for the current card) — NOT when the cursor is over grid coordinates outside the current
   * field/graph bounds; those still return a valid HoverInfo with whatever x,y the grid math
   * produces. */
  getHoverInfo(canvasX: number, canvasY: number): HoverInfo | null;
}
