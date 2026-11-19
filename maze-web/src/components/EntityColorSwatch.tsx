import type React from "react";
import { ui } from "../styles/theme";

/** The colour a list entry (a glue, a zone) is drawn in on the canvas: a small square with rounded
 *  corners next to its title, sized to the font (`1em`). Not a colour setting: it only shows a colour and cannot be edited. */
export function EntityColorSwatch({ color, style, ...rest }: { color: string } & Omit<React.HTMLAttributes<HTMLSpanElement>, "color">) {
  // The neutral border keeps a light or dark colour readable against the panel on either theme.
  return (
    <span
      {...rest}
      style={{
        width: "1em", height: "1em", borderRadius: "0.2em", flexShrink: 0, boxSizing: "border-box",
        background: color, border: `1px solid ${ui.border.default}`, ...style,
      }}
    />
  );
}

/** `0xRRGGBB` as a CSS colour. */
export function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}
