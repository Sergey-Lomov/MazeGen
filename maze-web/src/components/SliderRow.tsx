import { sharedStyles } from "../styles/shared";
import { typography, spacing } from "../styles/theme";

interface Props {
  label: string;
  value: number;
  onChange: (v: number) => void;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Value display formatter. Defaults to `toFixed(2)`, matching the default 0..1/0.01 range. */
  format?: (v: number) => string;
  disabled?: boolean;
}

export function SliderRow({ label, value, onChange, description, min = 0, max = 1, step = 0.01, format, disabled }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.elementsGap }}>
      <div style={sharedStyles.sliderRow}>
        <span style={{ ...sharedStyles.sliderRowLabel, ...(disabled ? { opacity: 0.4 } : {}) }}>{label}</span>
        <input
          type="range"
          className="maze-slider"
          style={{ flex: 1 }}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span style={sharedStyles.sliderRowValue}>{format ? format(value) : value.toFixed(2)}</span>
      </div>
      {description && <div style={{ ...typography.caption, lineHeight: 1.4 }}>{description}</div>}
    </div>
  );
}
