import type React from "react";
import { typography, ui, inset } from "../styles/theme";
import { Tooltip } from "./Tooltip";

/** Shared "edit this row" icon button — the plain "✎" glyph convention used throughout the quality
 *  panels (`RulesColumn`'s rule/stage rename buttons, `NestedStrategyPanel`'s own `editBtn`) rather
 *  than a pencil icon, so every edit entry point across the app renders and behaves identically
 *  instead of each row hand-rolling its own button+glyph copy. */
export function EditIconButton({ onClick, title, fontSize, disabled, style }: {
  onClick: (e: React.MouseEvent) => void;
  title: string;
  fontSize?: number;
  disabled?: boolean;
  /** Extra style, e.g. an accent while the edit is active. */
  style?: React.CSSProperties;
}) {
  return (
    <Tooltip content={title}>
      <button
        type="button"
        className="hoverable"
        style={{ ...styles.editBtn, ...(fontSize === undefined ? {} : { fontSize }), ...style }}
        disabled={disabled}
        onClick={onClick}
      >
        ✎
      </button>
    </Tooltip>
  );
}

const styles: Record<string, React.CSSProperties> = {
  editBtn: {
    ...typography.icon,
    background: "none",
    border: "none",
    color: ui.text.tertiary,
    padding: `0 ${inset.iconButtonInset}px`,
    cursor: "default",
    lineHeight: 1,
    flexShrink: 0,
  },
};
