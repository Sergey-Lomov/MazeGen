import type React from "react";
import { sharedStyles } from "../styles/shared";
import { typography, spacing, controlRowHeight } from "../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  min: number;
  max: number;
  onMinChange: (v: number) => void;
  onMaxChange: (v: number) => void;
  disabled?: boolean;
}

/** Elevator floor-count range (GitHub issue #337) — two plain integer text inputs on one row,
 *  not sliders: the range is small and unbounded upward, and a slider pair for min/max is
 *  awkward to read/operate compared to just typing the two numbers. */
export function ElevatorSpanRow({ min, max, onMinChange, onMaxChange, disabled }: Props) {
  return (
    <div style={styles.row}>
      <span style={{ ...styles.label, ...(disabled ? { opacity: 0.4 } : {}) }}>{m["generation.elevator_span"]()}</span>
      <input
        type="number"
        name="elevator-span-min"
        min={1}
        style={{ ...sharedStyles.input, width: 56, height: controlRowHeight, boxSizing: "border-box" }}
        value={min}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onMinChange(Math.max(1, Math.round(v)));
        }}
      />
      <span style={styles.dash}>–</span>
      <input
        type="number"
        name="elevator-span-max"
        min={1}
        style={{ ...sharedStyles.input, width: 56, height: controlRowHeight, boxSizing: "border-box" }}
        value={max}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onMaxChange(Math.max(1, Math.round(v)));
        }}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
    minHeight: controlRowHeight,
    boxSizing: "border-box",
  },
  label: {
    fontSize: typography.body.fontSize,
    color: typography.body.color,
    flex: 1,
  },
  dash: {
    ...typography.body,
  },
};
