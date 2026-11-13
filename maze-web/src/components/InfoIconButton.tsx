import type React from "react";
import { typography, muted } from "../styles/theme";

/** Shared clickable "ℹ" icon that opens an info popup for a row/section — mirrors
 *  `LinkStatusIcon`'s own per-field icon convention, so every info entry point renders and
 *  behaves identically instead of each row hand-rolling its own span+styles copy. */
export function InfoIconButton({ onClick, symbol = "ℹ", label = "Info" }: { onClick: () => void; symbol?: React.ReactNode; label?: string }) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      className="hoverable"
      style={styles.infoIcon}
      onClick={onClick}
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
