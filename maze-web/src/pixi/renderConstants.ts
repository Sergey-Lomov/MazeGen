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

/** Settings-slider range for every label font size (px) — marker captions, elevator badges and
 *  teleport floor badges share it. */
export const TEXT_SIZE_RANGE = { min: 6, max: 32, step: 0.5 } as const;
