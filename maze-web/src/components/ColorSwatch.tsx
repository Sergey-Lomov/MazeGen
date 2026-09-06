import React, { useState } from "react";
import { ui, controlRowHeight } from "../styles/theme";
import { ColorPickerPanel } from "./ColorPickerPanel";
import { colorToHex } from "./colorFormat";

interface Props {
  color: number;
  onChange: (color: number) => void;
  disabled?: boolean;
  /** Live-preview handler for the open picker (GitHub issue #513) — called with the working color
   *  on every change, and once with the original color on Cancel / Escape / close. Defaults to
   *  `onChange`, which is right when `onChange` only updates a render; a call site whose `onChange`
   *  marks the maze dirty or pushes a history entry must pass a lighter handler that just repaints,
   *  so a mid-drag preview isn't recorded as an edit. */
  onPreview?: (color: number) => void;
}

/** Reusable color-value indicator/picker. The visible swatch is a plain `div` (native
 *  `input[type=color]` rendered its own browser-chrome swatch that didn't clip cleanly to
 *  `border-radius` and showed its own focus ring). Clicking it opens `ColorPickerPanel`
 *  (GitHub issue #499) — a `SidePanel` overlay docked to the canvas edge — seeded with the current
 *  color; the swatch is only updated when the panel commits via "Apply". While the picker is open
 *  it streams the working color to `onPreview` (default: `onChange`) so the canvas shows the color
 *  live, and restores the original on Cancel / Escape (GitHub issue #513). Height matches
 *  `Switch`/`sharedStyles.selectSm` (`controlRowHeight`) so every param row lines up at the same
 *  height regardless of control type.
 *
 *  The picker reads `color` on open and commits the chosen color through `onChange`, knowing
 *  nothing about whether that setter writes a plain store value or a Shared-Style override patch
 *  (GitHub issue #322). Commit timing depends on `onPreview`: with a distinct `onPreview` channel
 *  the single `onChange` commit fires on Apply; with the default (`onPreview` = `onChange`) the
 *  live stream is the commit and Apply just closes. Cancel / Escape restore the open-time color. */
export function ColorSwatch({ color, onChange, disabled, onPreview }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        style={{ ...styles.swatch, background: colorToHex(color), ...(disabled ? styles.swatchDisabled : {}) }}
        onClick={() => { if (!disabled) setPickerOpen(true); }}
        onKeyDown={(e) => { if (!disabled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setPickerOpen(true); } }}
      />
      {pickerOpen && (
        <ColorPickerPanel
          color={color}
          // When `onPreview` is a distinct channel, Apply is the one and only `onChange` commit.
          // When it defaults to `onChange`, the live stream has already committed the working
          // color, so Apply must not fire a second identical `onChange` (a call site that records
          // history would log the pick twice) — it only closes.
          onApply={(next) => { if (onPreview) onChange(next); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
          onPreview={onPreview ?? onChange}
        />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  swatch: {
    width: 40,
    height: controlRowHeight,
    flexShrink: 0,
    border: `2px solid ${ui.border.strong}`,
    borderRadius: 3,
    cursor: "default",
    boxSizing: "border-box",
  },
  swatchDisabled: { opacity: 0.4, cursor: "default" },
};
