import type React from "react";
import { typography, muted } from "../styles/theme";

/** Shared clickable "ℹ" icon that opens an info popup for a row/section — mirrors
 *  `LinkStatusIcon`'s own per-field icon convention, so every info entry point renders and
 *  behaves identically instead of each row hand-rolling its own span+styles copy. */
export function InfoIconButton({ onClick, symbol = "ℹ", label = "Info", inList = false, hoverable = true }: {
  onClick: () => void;
  symbol?: React.ReactNode;
  label?: string;
  /** The icon sits in a row of a list that keeps keyboard focus (a `SelectableList`): a click must not
   *  select the row or pull focus off the list, and the icon is not a tab stop. */
  inList?: boolean;
  /** Highlight the icon under the pointer (the shared `hoverable` look). */
  hoverable?: boolean;
}) {
  return (
    <span
      role="button"
      tabIndex={inList ? -1 : 0}
      aria-label={label}
      className={hoverable ? "hoverable" : undefined}
      style={styles.infoIcon}
      onMouseDown={inList ? (e) => e.preventDefault() : undefined}
      onClick={(e) => {
        if (inList) e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onClick();
      }}
    >
      {symbol}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  infoIcon: { ...muted(typography.icon), lineHeight: 1, flexShrink: 0, cursor: "default", borderRadius: 3, display: "inline-flex", alignItems: "center" },
};
