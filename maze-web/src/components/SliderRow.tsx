import type React from "react";
import { NumberInput } from "./NumberInput";
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
  /** Adds a bounded numeric editor for values that need more precision than the range input. */
  precise?: boolean;
  /** Accessible name for the precise editor when the visible row label is contextual or repeated. */
  preciseAriaLabel?: string;
  disabled?: boolean;
  onPointerDown?: React.PointerEventHandler<HTMLInputElement>;
  onPointerUp?: React.PointerEventHandler<HTMLInputElement>;
  onPointerCancel?: React.PointerEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  /** Trailing control (GitHub issue #652's per-field link-status icon, `LinkStatusIcon`) — shrinks
   *  the slider's own `flex: 1` track, never the label, per that issue's own spec. */
  resetButton?: React.ReactNode;
  /** Extra action button rendered between the value and `resetButton` (GitHub issue #707's
   *  per-size "Auto-fit" button). */
  trailingAction?: React.ReactNode;
}

export function SliderRow({ label, value, onChange, description, min = 0, max = 1, step = 0.01, format, precise, preciseAriaLabel, disabled, resetButton, trailingAction, onPointerDown, onPointerUp, onPointerCancel, onBlur }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.elementsGap }}>
      <div style={sharedStyles.sliderRow}>
        <span style={{ ...sharedStyles.sliderRowLabel, ...(disabled ? { opacity: 0.4 } : {}) }}>{label}</span>
        <input
          type="range"
          name={label}
          className="maze-slider"
          style={{ flex: 1 }}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onBlur={onBlur}
        />
        {precise ? (
          <NumberInput
            name={`${label}-value`}
            ariaLabel={preciseAriaLabel ?? `${label} value`}
            min={min}
            max={max}
            value={String(value)}
            disabled={disabled}
            style={{ ...sharedStyles.input, width: 64, textAlign: "right" }}
            onChange={(raw) => {
              const next = Number(raw);
              if (Number.isFinite(next)) onChange(next);
            }}
          />
        ) : (
          <span style={sharedStyles.sliderRowValue}>{format ? format(value) : value.toFixed(2)}</span>
        )}
        {trailingAction}
        {resetButton}
      </div>
      {description && <div style={{ ...typography.caption, lineHeight: 1.4 }}>{description}</div>}
    </div>
  );
}
