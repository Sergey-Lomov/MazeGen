import React from "react";
import { ui, controlRowHeight } from "../styles/theme";

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

const TRACK_WIDTH = 36;
const THUMB_INSET = 2;
const THUMB_SIZE = controlRowHeight - THUMB_INSET * 2;

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    cursor: "default",
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
    width: TRACK_WIDTH,
    height: controlRowHeight,
    background: ui.border.strong,
    borderRadius: controlRowHeight / 2,
    position: "relative",
    transition: "background 0.2s",
    boxSizing: "border-box",
  },
  trackOn: {
    background: ui.accent.base,
  },
  thumb: {
    position: "absolute",
    top: THUMB_INSET,
    left: THUMB_INSET,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    background: ui.text.inverse,
    borderRadius: "50%",
    transition: "left 0.2s",
  },
  thumbOn: {
    left: TRACK_WIDTH - THUMB_INSET - THUMB_SIZE,
  },
};
