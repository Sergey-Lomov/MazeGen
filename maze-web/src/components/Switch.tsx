import React from "react";
import { ui, controlRowHeight } from "../styles/theme";

interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  name?: string;
  id?: string;
  ariaLabel?: string;
  /** Track height in px; the thumb scales with it. Defaults to the standard control row height. */
  height?: number;
}

export function Switch({ checked, onChange, disabled, name = "switch", id, ariaLabel, height = controlRowHeight }: Props) {
  const thumbSize = height - THUMB_INSET * 2;
  return (
    <label style={{ ...styles.wrap, ...(disabled ? styles.wrapDisabled : {}) }}>
      <input
        type="checkbox"
        name={name}
        id={id}
        aria-label={ariaLabel}
        style={styles.input}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span style={{ ...styles.track, height, borderRadius: height / 2, ...(checked ? styles.trackOn : {}) }}>
        <span style={{ ...styles.thumb, width: thumbSize, height: thumbSize, ...(checked ? { left: TRACK_WIDTH - THUMB_INSET - thumbSize } : {}) }} />
      </span>
    </label>
  );
}

const TRACK_WIDTH = 36;
const THUMB_INSET = 2;

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
    background: ui.border.strong,
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
    background: ui.text.inverse,
    borderRadius: "50%",
    transition: "left 0.2s",
  },
};
