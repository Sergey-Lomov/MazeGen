import type React from "react";
import { typography, muted } from "../styles/theme";

/** Shared clickable "ℹ" icon that opens an info popup for a row/section — mirrors
 *  `LinkStatusIcon`'s own per-field icon convention, so every info entry point renders and
 *  behaves identically instead of each row hand-rolling its own span+styles copy. */
export function InfoIconButton({ onClick, symbol = "ℹ", label = "Info", inList = false, hoverable = true, disabled = false, testId }: {
  onClick: () => void;
  symbol?: React.ReactNode;
  label?: string;
  /** The icon sits in a row of a list that keeps keyboard focus (a `SelectableList`): a click must not
   *  select the row or pull focus off the list, and the icon is not a tab stop. */
  inList?: boolean;
  /** Highlight the icon under the pointer (the shared `hoverable` look). */
  hoverable?: boolean;
  /** Dimmed and inert: it keeps its place, so the row does not shift when an action becomes unavailable. */
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <span
      role="button"
      tabIndex={inList || disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      aria-label={label}
      className={hoverable && !disabled ? "hoverable" : undefined}
      style={disabled ? { ...styles.infoIcon, opacity: 0.4 } : styles.infoIcon}
      onMouseDown={inList ? (e) => e.preventDefault() : undefined}
      onClick={(e) => {
        if (inList) e.stopPropagation();
        if (!disabled) onClick();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (!disabled) onClick();
      }}
    >
      {symbol}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  infoIcon: { ...muted(typography.icon), lineHeight: 1, flexShrink: 0, cursor: "default", borderRadius: 3, display: "inline-flex", alignItems: "center" },
};
