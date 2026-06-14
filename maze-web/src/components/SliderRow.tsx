import React from "react";
import { sharedStyles } from "../styles/shared";

interface Props {
  label: string;
  value: number;
  onChange: (v: number) => void;
}

export function SliderRow({ label, value, onChange }: Props) {
  return (
    <div style={sharedStyles.sliderRow}>
      <span style={sharedStyles.sliderRowLabel}>{label}</span>
      <input
        type="range"
        className="maze-slider"
        style={{ flex: 1 }}
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span style={sharedStyles.sliderRowValue}>{value.toFixed(2)}</span>
    </div>
  );
}
