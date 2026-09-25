import { base, hexToNumber } from "../styles/palette";

const CONTRAST_DARK = hexToNumber("#2a2a2a");
const CONTRAST_LIGHT = hexToNumber("#e0e0e0");

/** Picks a dark- or light-gray color that reads clearly against `backgroundColor` (0xRRGGBB) —
 * relative luminance (ITU-R BT.601 weights, same coefficients used for perceived-brightness
 * grayscale conversion), light background gets the dark gray and vice versa. Used for UI drawn
 * directly on the Pixi canvas whose backing color isn't fixed (e.g. `ExportFrameOverlay`'s print
 * frame, which must stay visible against any user-configured mode background). */
export function contrastGray(backgroundColor: number): number {
  const r = (backgroundColor >> 16) & 0xff;
  const g = (backgroundColor >> 8) & 0xff;
  const b = backgroundColor & 0xff;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? CONTRAST_DARK : CONTRAST_LIGHT;
}

// Canvas color tokens, namespaced by render entity (mirrors `ui.*` on the DOM side).
export const canvas = {
  node: {
    default: hexToNumber(base.canvasAccent),
    hover: hexToNumber(base.nodeHover),
    selected: hexToNumber(base.nodeSelected),
    start: hexToNumber(base.nodeStart),
    finish: hexToNumber(base.nodeFinish),
    split: hexToNumber(base.nodeSplit),
    splitSlots: [hexToNumber(base.splitSlot0), hexToNumber(base.splitSlot1), hexToNumber(base.splitSlot2)] as const,
  },

  edge: {
    default: hexToNumber(base.edge),
    oneWay: hexToNumber(base.oneWay),
  },

  wall: {
    default: hexToNumber(base.textSecondary),
    undecided: hexToNumber(base.textDisabled),
  },

  floor: {
    default: hexToNumber(base.bgSurfaceRaised),
  },

  stage: {
    background: hexToNumber(base.bgApp),
  },

  lock: {
    default: hexToNumber(base.edge),
  },

  preset: {
    invalid: hexToNumber(base.invalid),
  },

  fieldEditor: {
    hover: hexToNumber(base.canvasHover),
    // Manage split nodes panel target (GitHub issue #606): a transparent fill with a yellow frame
    // distinguishes the edited cell from the cursor hover while using the same full-cell geometry.
    panelTarget: hexToNumber(base.warning),
    activeCell: hexToNumber(base.textDisabled),
    // Reset tool's hover highlight (GitHub issue #327) — red instead of the ordinary hover color,
    // matching `ui.text.error`/the DOM-side "toggle-danger" button variant, so a destructive tool
    // reads as destructive on the canvas too.
    danger: hexToNumber(base.error),
  },

  grid: {
    line: hexToNumber(base.borderDefault),
  },

  origin: {
    default: hexToNumber(base.origin),
  },

  teleport: {
    default: hexToNumber(base.teleport),
  },

  vertical: {
    default: hexToNumber(base.vertical),
  },

  // Region class overlay — fixed per-class colors (not the rotating component palette)
  region: {
    path: hexToNumber(base.nodeStart),
    alternative: hexToNumber(base.canvasAccent),
    unreachable: hexToNumber(base.edge),
    trap: hexToNumber(base.nodeFinish),
  },

  debug: {
    active: hexToNumber(base.debugActive),
    currentSrc: hexToNumber(base.debugCurrentSrc),
    refHighlight: hexToNumber(base.debugRefHighlight),
    // Issue-kind ref highlight (GitHub issue #203) — red instead of `refHighlight`'s cyan,
    // matching Analytics' own issue-highlight red (`IssueHighlightOverlay`'s `base.error`).
    issueHighlight: hexToNumber(base.error),
  },
} as const;
