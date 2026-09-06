import type React from "react";
import { spacing, radius, ui } from "../styles/theme";

/** Shared geometry for the color-picker model editors' 2D area + vertical strip (`HslModelEditor`,
 *  `OklchModelEditor`). Each editor supplies its own track / area background inline. */

export const PICKER_AREA_HEIGHT = 140;

export const pickerAreaStyles: Record<string, React.CSSProperties> = {
  pickers: { display: "flex", gap: spacing.groupGap },
  area: {
    position: "relative",
    flex: 1,
    height: PICKER_AREA_HEIGHT,
    borderRadius: radius.sm,
    border: `1px solid ${ui.border.default}`,
    touchAction: "none",
    cursor: "crosshair",
  },
  crosshair: {
    position: "absolute",
    width: 14,
    height: 14,
    borderRadius: "50%",
    border: "2px solid #fff",
    boxShadow: "0 0 0 2px #1b1b1b",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
    boxSizing: "border-box",
  },
  hueStrip: {
    position: "relative",
    width: 18,
    height: PICKER_AREA_HEIGHT,
    flexShrink: 0,
    borderRadius: radius.sm,
    border: `1px solid ${ui.border.default}`,
    touchAction: "none",
    cursor: "pointer",
  },
  hueMarker: {
    position: "absolute",
    left: -2,
    right: -2,
    height: 6,
    borderRadius: 3,
    border: "2px solid #fff",
    boxShadow: "0 0 0 2px #1b1b1b",
    transform: "translateY(-50%)",
    pointerEvents: "none",
    boxSizing: "border-box",
  },
};
