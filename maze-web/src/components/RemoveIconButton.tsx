import type React from "react";
import { X } from "lucide-react";
import { ui } from "../styles/theme";
import { Tooltip } from "./Tooltip";

/** Shared "remove/delete this row" icon button — the plain `X` glyph convention used throughout the
 *  quality panels (`RulesColumn`, `RuleCheckRow`, `NestedStrategyPanel`'s own `removeBtn`/`X`) rather
 *  than a trash-can icon, so every delete entry point across the app renders and behaves identically
 *  instead of each row hand-rolling its own button+`X` copy. `size` matches the two sizes already in
 *  use (16 for compact toolbar rows, 18 for card-level rows) — pass whichever the surrounding row's
 *  other icons use. */
export function RemoveIconButton({ onClick, title, size = 18, disabled }: {
  onClick: (e: React.MouseEvent) => void;
  title: string;
  size?: 16 | 18;
  disabled?: boolean;
}) {
  return (
    <Tooltip content={title}>
      <button
        type="button"
        className={disabled ? undefined : "hoverable"}
        style={disabled ? { ...styles.removeBtn, ...styles.removeBtnDisabled } : styles.removeBtn}
        disabled={disabled}
        onClick={onClick}
      >
        <X size={size} color={ui.text.tertiary} />
      </button>
    </Tooltip>
  );
}

const styles: Record<string, React.CSSProperties> = {
  removeBtn: {
    background: "none",
    border: "none",
    cursor: "default",
    padding: 0,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
  },
  removeBtnDisabled: {
    opacity: 0.25,
  },
};
