import React from "react";
import { colors } from "../styles/theme";

interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
}

export function Switch({ checked, onChange }: Props) {
  return (
    <label style={styles.wrap}>
      <input
        type="checkbox"
        style={styles.input}
        checked={checked}
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
    background: colors.borderStrong,
    borderRadius: 9,
    position: "relative",
    transition: "background 0.2s",
  },
  trackOn: {
    background: colors.bgBtnPrimary,
  },
  thumb: {
    position: "absolute",
    top: 2,
    left: 2,
    width: 14,
    height: 14,
    background: colors.textWhite,
    borderRadius: "50%",
    transition: "left 0.2s",
  },
  thumbOn: {
    left: 16,
  },
};
