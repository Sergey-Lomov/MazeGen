import React, { useRef } from "react";
import { ui, controlRowHeight } from "../styles/theme";

interface Props {
  color: number;
  onChange: (color: number) => void;
  disabled?: boolean;
}

function colorToCss(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function cssToColor(css: string): number {
  return parseInt(css.slice(1), 16);
}

/** Reusable color-value indicator/picker. The visible swatch is a plain `div` (native
 *  `input[type=color]` renders its own browser-chrome swatch that doesn't clip cleanly to
 *  `border-radius` and shows its own focus ring, both defects no CSS reset fully fixes) — clicking
 *  it opens the native color-picker via a hidden `input[type=color]` triggered programmatically.
 *  The hidden input is absolutely positioned to exactly overlay the swatch (not collapsed to a
 *  zero-size point) — Chrome anchors the native picker popup to the input's own rect, and a
 *  zero-size input drifted the popup far below the swatch once other settings sections expanded
 *  above it shifted the panel's scroll offset (GitHub issue #325). Height matches
 *  `Switch`/`sharedStyles.selectSm` (`controlRowHeight`) so every param row lines up at the same
 *  height regardless of control type. */
export function ColorSwatch({ color, onChange, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div style={styles.wrapper}>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        style={{ ...styles.swatch, background: colorToCss(color), ...(disabled ? styles.swatchDisabled : {}) }}
        onClick={() => { if (!disabled) inputRef.current?.click(); }}
        onKeyDown={(e) => { if (!disabled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); inputRef.current?.click(); } }}
      />
      <input
        ref={inputRef}
        type="color"
        value={colorToCss(color)}
        onChange={(e) => onChange(cssToColor(e.target.value))}
        disabled={disabled}
        style={styles.hiddenInput}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: { position: "relative", width: 40, height: controlRowHeight, flexShrink: 0 },
  swatch: { width: 40, height: controlRowHeight, border: `2px solid ${ui.border.strong}`, borderRadius: 3, cursor: "default", boxSizing: "border-box" },
  swatchDisabled: { opacity: 0.4, cursor: "default" },
  hiddenInput: { position: "absolute", inset: 0, width: "100%", height: "100%", padding: 0, border: "none", opacity: 0, pointerEvents: "none" },
};
