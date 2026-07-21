import React from "react";
import { typography, muted, disabled, spacing } from "../styles/theme";

interface Props {
  label: string;
  value: number;
  onChange: (v: number) => void;
  variant?: "primary" | "secondary";
}

export function SliderParam({ label, value, onChange, variant = "secondary" }: Props) {
  return (
    <div style={styles.row}>
      <div style={styles.header}>
        <span style={variant === "primary" ? styles.labelPrimary : styles.label}>{label}</span>
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
