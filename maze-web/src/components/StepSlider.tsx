import React from "react";

interface Props {
  value: number;
  max: number;
  style?: React.CSSProperties;
  onChange: (v: number) => void;
}

export function StepSlider({ value, max, style, onChange }: Props) {
  return (
    <input
      type="range"
      className="maze-slider"
      style={style}
      min={0}
      max={Math.max(0, max)}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
