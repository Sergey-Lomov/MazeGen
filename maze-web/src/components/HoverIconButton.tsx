import React from "react";
import { ui, font } from "../styles/theme";

export function HoverIconButton({ onClick, title, children }: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={styles.button}
      title={title}
      onMouseEnter={e => (e.currentTarget.style.background = ui.border.strong)}
      onMouseLeave={e => (e.currentTarget.style.background = ui.bg.input)}
    >
      {children}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    borderRadius: 3,
    color: ui.text.secondary,
    fontSize: font.xl,
    cursor: "pointer",
    padding: "4px 6px",
    lineHeight: "normal",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
};
