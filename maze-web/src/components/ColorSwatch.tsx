import React, { useRef } from "react";
import { ui } from "../styles/theme";

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
 *  it opens the native color-picker via a hidden, zero-size `input[type=color]` triggered
 *  programmatically. Height matches `Switch` (18px) so a color row and a toggle row line up in the
 *  same settings list. */
export function ColorSwatch({ color, onChange, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
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
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  swatch: { width: 40, height: 18, border: `2px solid ${ui.border.strong}`, borderRadius: 3, cursor: "default", boxSizing: "border-box" },
  swatchDisabled: { opacity: 0.4, cursor: "default" },
  hiddenInput: { position: "absolute", width: 0, height: 0, padding: 0, border: "none", opacity: 0, pointerEvents: "none" },
};
