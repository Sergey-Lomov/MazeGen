import { base, hexToNumber } from "../styles/palette";

// Canvas color tokens, namespaced by render entity (mirrors `ui.*` on the DOM side).
export const canvas = {
  node: {
    default: hexToNumber(base.canvasAccent),
    hover: hexToNumber(base.nodeHover),
    selected: hexToNumber(base.nodeSelected),
    start: hexToNumber(base.nodeStart),
    finish: hexToNumber(base.nodeFinish),
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
    activeCell: hexToNumber(base.textDisabled),
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
