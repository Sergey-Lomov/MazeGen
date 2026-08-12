import type React from "react";
import { sharedStyles } from "../styles/shared";
import { typography, spacing } from "../styles/theme";
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
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.elementsGap }}>
      <div style={styles.row}>
        <span style={{ ...styles.label, ...(disabled ? { opacity: 0.4 } : {}) }}>{m["generation.elevator_span"]()}</span>
        <input
          type="number"
          min={1}
          style={{ ...sharedStyles.input, width: 56 }}
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
          min={1}
          style={{ ...sharedStyles.input, width: 56 }}
          value={max}
          disabled={disabled}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onMaxChange(Math.max(1, Math.round(v)));
          }}
        />
      </div>
      <div style={{ ...typography.caption, lineHeight: 1.4 }}>{m["generation.desc.elevator_span"]()}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
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
