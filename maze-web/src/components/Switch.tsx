import React from "react";
import { ui } from "../styles/theme";

interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}

export function Switch({ checked, onChange, disabled }: Props) {
  return (
    <label style={{ ...styles.wrap, ...(disabled ? styles.wrapDisabled : {}) }}>
      <input
        type="checkbox"
        style={styles.input}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span style={{ ...styles.track, ...(checked ? styles.trackOn : {}) }}>
        <span style={{ ...styles.thumb, ...(checked ? styles.thumbOn : {}) }} />
      </span>
    </label>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  wrapDisabled: {
    opacity: 0.4,
    cursor: "default",
  },
  input: {
    position: "absolute",
    opacity: 0,
    width: 0,
    height: 0,
  },
  track: {
    display: "inline-block",
    width: 32,
    height: 18,
    background: ui.border.strong,
    borderRadius: 9,
    position: "relative",
    transition: "background 0.2s",
  },
  trackOn: {
    background: ui.accent.base,
  },
  thumb: {
    position: "absolute",
    top: 2,
    left: 2,
    width: 14,
    height: 14,
    background: ui.text.inverse,
    borderRadius: "50%",
    transition: "left 0.2s",
  },
  thumbOn: {
    left: 16,
  },
};
