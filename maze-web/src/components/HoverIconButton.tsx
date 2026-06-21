import React from "react";
import { colors, font } from "../styles/theme";

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
      onMouseEnter={e => (e.currentTarget.style.background = colors.bgBtnMuted)}
      onMouseLeave={e => (e.currentTarget.style.background = colors.bgInput)}
    >
      {children}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 3,
    color: colors.textMuted,
    fontSize: font.xl,
    cursor: "pointer",
    padding: "4px 6px",
    lineHeight: "normal",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
};
