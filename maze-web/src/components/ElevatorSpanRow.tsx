import type React from "react";
import { sharedStyles } from "../styles/shared";
import { typography, spacing, controlRowHeight } from "../styles/theme";
import { NumberInput } from "./NumberInput";
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
      <NumberInput
        name="elevator-span-min"
        min={1}
        integer
        style={{ ...sharedStyles.input, width: 56, height: controlRowHeight, boxSizing: "border-box" }}
        value={String(min)}
        disabled={disabled}
        onChange={(raw) => {
          const value = Number(raw);
          if (Number.isFinite(value)) onMinChange(value);
        }}
      />
      <span style={styles.dash}>–</span>
      <NumberInput
        name="elevator-span-max"
        min={1}
        integer
        style={{ ...sharedStyles.input, width: 56, height: controlRowHeight, boxSizing: "border-box" }}
        value={String(max)}
        disabled={disabled}
        onChange={(raw) => {
          const value = Number(raw);
          if (Number.isFinite(value)) onMaxChange(value);
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
