export const NODE_RADIUS = 6;
export const WALL_THICKNESS = 3;
export const GRID_LINE_ALPHA = 1.0;
export const ACTIVE_CELL_ALPHA = 0.7;
export const COMPONENT_MASK_ALPHA = 0.45;
export const REGION_CLASS_MASK_ALPHA = 0.45;
export const DEBUG_ACTIVE_ALPHA = 0.5;

/** Default label font sizes in px (marker/badge text size is an absolute value, not a fraction of
 *  the marker diameter). */
export const DEFAULT_MARKER_TEXT_SIZE = 17;
export const DEFAULT_ELEVATOR_BADGE_TEXT_SIZE = 10;
export const DEFAULT_TELEPORT_BADGE_TEXT_SIZE = 10;

/** Marker-index plate limits in px (GitHub issue #725): fixed width range and minimum height. */
export const MARKER_INDEX_WIDTH_RANGE = { min: 8, max: 20 } as const;
export const MARKER_INDEX_MIN_HEIGHT = 8;

/** Settings-slider range for every label font size (px) — marker captions, elevator badges,
 *  teleport floor badges and marker indices share it. */
export const TEXT_SIZE_RANGE = { min: 6, max: 32, step: 0.5 } as const;

/** Floor-label font size range (floor labels may be substantially larger than marker captions). */
export const FLOOR_LABEL_TEXT_SIZE_RANGE = { min: 6, max: 72, step: 0.5 } as const;

/** Floor-label backplate width range in px. */
export const FLOOR_LABEL_WIDTH_RANGE = { min: 20, max: 250, step: 1 } as const;

/** Text margin (px): how far a label's glyph ink must stay from its plate edge. Drives the overflow
 *  warnings and auto-fit for every text; shared by all label-bearing consumers. */
export const DEFAULT_TEXT_MARGIN = 1;
export const TEXT_MARGIN_RANGE = { min: 0, max: 10, step: 0.5 } as const;
