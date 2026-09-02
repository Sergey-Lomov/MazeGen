import React, { useState } from "react";
import { ui, controlRowHeight } from "../styles/theme";
import { ColorPickerPanel } from "./ColorPickerPanel";
import { colorToHex } from "./colorFormat";

interface Props {
  color: number;
  onChange: (color: number) => void;
  disabled?: boolean;
}

/** Reusable color-value indicator/picker. The visible swatch is a plain `div` (native
 *  `input[type=color]` rendered its own browser-chrome swatch that didn't clip cleanly to
 *  `border-radius` and showed its own focus ring). Clicking it opens `ColorPickerPanel`
 *  (GitHub issue #499) — a `SidePanel` overlay docked to the canvas edge — seeded with the current
 *  color; the swatch is only updated when the panel commits via "Apply". Height matches
 *  `Switch`/`sharedStyles.selectSm` (`controlRowHeight`) so every param row lines up at the same
 *  height regardless of control type.
 *
 *  Public props (`color` + `onChange`) are unchanged: the picker reads `color` on open and calls
 *  `onChange` on Apply, knowing nothing about whether that setter writes a plain store value or a
 *  Shared-Style override patch (GitHub issue #322). */
export function ColorSwatch({ color, onChange, disabled }: Props) {
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
          onApply={(next) => { onChange(next); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
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
