import React from "react";
import { colors, font } from "../styles/theme";

interface Props {
  label: string;
  value: number;
  onChange: (v: number) => void;
}

export function SliderParam({ label, value, onChange }: Props) {
  return (
    <div style={styles.row}>
      <div style={styles.header}>
        <span style={styles.label}>{label}</span>
        <span style={styles.value}>{value.toFixed(2)}</span>
      </div>
      <input
        className="maze-slider"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  label: {
    fontSize: font.sm,
    color: colors.textVeryDim,
  },
  value: {
    fontSize: font.sm,
    color: colors.textDim,
  },
};
