import React from "react";
import { ui, typography, controlRowHeight } from "../styles/theme";
import { Tooltip } from "./Tooltip";

export function HoverIconButton({ onClick, title, children, fixedHeight, stretch, square, ariaLabel }: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  /** Use a fixed `controlRowHeight` instead of stretching to match the tallest sibling in the row
   *  — for standalone rows (e.g. the panel footer's Save/Load/Fit buttons) where no sibling sets a
   *  taller natural height to stretch to, so the button would otherwise collapse to its icon size. */
  fixedHeight?: boolean;
  /** Stretch the tooltip wrapper and button to a sibling text button's height. */
  stretch?: boolean;
  /** Keep the button as wide as its stretched height (for controls beside a text input). */
  square?: boolean;
  /** Accessible control name. Defaults to the tooltip text. */
  ariaLabel?: string;
}) {
  return (
    <Tooltip content={title} stretch={stretch}>
      <button
        onClick={onClick}
        aria-label={ariaLabel ?? title}
        style={{ ...styles.button, ...(fixedHeight ? { height: controlRowHeight, alignSelf: undefined } : {}), ...(square ? { aspectRatio: "1 / 1", padding: 0 } : {}) }}
        onMouseEnter={e => (e.currentTarget.style.background = ui.border.strong)}
        onMouseLeave={e => (e.currentTarget.style.background = ui.bg.input)}
      >
        {children}
      </button>
    </Tooltip>
  );
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    ...typography.icon,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    borderRadius: 3,
    color: ui.text.secondary,
    cursor: "default",
    alignSelf: "stretch",
    boxSizing: "border-box",
    padding: "0 6px",
    lineHeight: "normal",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
};
