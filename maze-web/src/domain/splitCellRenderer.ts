import type { TessellationKind } from "../fieldConfig";

/**
 * Selects split-cell rendering rules from both the cell template and tessellation. A template can
 * occur in several tessellations, so template identity alone cannot decide its visual treatment.
 */
export type SplitCellRenderer = {
  /** Fraction of a bridge's length used by each taper. */
  bridgeTaperFrac: number;
};

export const DEFAULT_BRIDGE_TAPER_FRAC = 0.2;

const DEFAULT_RENDERER: SplitCellRenderer = { bridgeTaperFrac: DEFAULT_BRIDGE_TAPER_FRAC };

const SQUARE_OCTAGON_SQUARE_RENDERER: SplitCellRenderer = { bridgeTaperFrac: 0.08 };

/**
 * The 4.8.8 square's bridge silhouette meets seams of its surrounding octagons. A short taper
 * gives the deck a distinct shape before it reaches those seams.
 */
export function selectSplitCellRenderer(
  tessellation: TessellationKind,
  shape: string | undefined,
): SplitCellRenderer {
  if (tessellation === "square_octagon" && shape === "regular:4") {
    return SQUARE_OCTAGON_SQUARE_RENDERER;
  }
  return DEFAULT_RENDERER;
}
