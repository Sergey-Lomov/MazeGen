export const NODE_RADIUS = 6;
export const WALL_THICKNESS = 3;
export const GRID_LINE_ALPHA = 1.0;
export const ACTIVE_CELL_ALPHA = 0.7;
export const COMPONENT_MASK_ALPHA = 0.45;
export const REGION_CLASS_MASK_ALPHA = 0.45;

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
export const TEXT_SIZE_RANGE = { min: 6, max: 40, step: 0.5 } as const;

/** Floor-label font size range (floor labels may be substantially larger than marker captions). */
export const FLOOR_LABEL_TEXT_SIZE_RANGE = { min: 6, max: 72, step: 0.5 } as const;

/** Floor-label backplate width range in px. */
export const FLOOR_LABEL_WIDTH_RANGE = { min: 20, max: 250, step: 1 } as const;

/** Text margin (px): how far a label's glyph ink must stay from its plate edge. Drives the overflow
 *  warnings and auto-fit for every text; shared by all label-bearing consumers. */
export const DEFAULT_TEXT_MARGIN = 1;
/** Ranges of the export crease style (GitHub issue #900): the settings sliders and the project-file validator share them. */
export const CREASE_LINE_WIDTH_RANGE = { min: 1, max: 20 } as const;
export const CREASE_MARK_SIZE_RANGE = { min: 2, max: 20 } as const;
export const CREASE_MARK_TIP_LENGTH_RANGE = { min: 0, max: 40 } as const;
/** Ranges of the export glue-tab style (GitHub issue #901): the settings sliders and the project-file validator share them. */
export const GLUE_TAB_INSET_RANGE = { min: 0, max: 40 } as const;
export const GLUE_TAB_WIDTH_RANGE = { min: 2, max: 80 } as const;
export const GLUE_TAB_LINE_WIDTH_RANGE = { min: 0, max: 10 } as const;
/** Range of the edge marker diameter (GitHub issue #902). */
/** The base colour of the automatic hue distribution (GitHub issue #903): glue colours, and the default base colour of the
 *  export's edge alignment markers, so markers that sit on glues get the glues' colours. */
export const AUTO_HUE_BASE_COLOR = 0x2873bd;
/** Lightness added to a hovered glue's colour (OKLCH L). */
export const GLUE_HOVER_LIGHTNESS = 10;
export const EDGE_MARKER_SIZE_RANGE ={ min: 2, max: 40 } as const;
export const TEXT_MARGIN_RANGE = { min: 0, max: 10, step: 0.5 } as const;

/** Corner radius (display units) of a highlighted warning polygon (topology warnings, connector warnings). */
export const POLYGON_HIGHLIGHT_RADIUS = 3;

/** Cell-fill highlight color for a hovered export warning (GitHub issue #298 follow-up) — same
 *  yellow as `styles/palette.ts`'s `warning` token, duplicated here since the pixi render layer
 *  must not import the web-styling layer. */
export const WARNING_HIGHLIGHT_COLOR = 0xffaa44;
