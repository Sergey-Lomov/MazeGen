import React from "react";
import { typography, muted, disabled, spacing } from "../styles/theme";

interface Props {
  label: string;
  value: number;
  onChange: (v: number) => void;
  variant?: "primary" | "secondary";
  min?: number;
  max?: number;
  step?: number;
  /** Value display formatter. Defaults to `toFixed(2)`, matching the default 0..1/0.01 range. */
  format?: (v: number) => string;
}

export function SliderParam({ label, value, onChange, variant = "secondary", min = 0, max = 1, step = 0.01, format }: Props) {
  return (
    <div style={styles.row}>
      <div style={styles.header}>
        <span style={variant === "primary" ? styles.labelPrimary : styles.label}>{label}</span>
        <span style={styles.value}>{format ? format(value) : value.toFixed(2)}</span>
      </div>
      <input
        className="maze-slider"
        type="range"
        name={label}
        min={min}
        max={max}
        step={step}
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
    gap: spacing.itemGap,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  label: {
    ...disabled(typography.body),
  },
  labelPrimary: {
    ...muted(typography.body),
  },
  value: {
    ...typography.caption,
  },
};
