import React, { useState } from "react";
import { NumberInput } from "./NumberInput";
import { Tooltip } from "./Tooltip";
import { sharedStyles } from "../styles/shared";
import { controlRowHeight, typography, spacing } from "../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  label: string;
  value: number;
  onChange: (v: number) => void;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Renders a 0..1 probability as a 0..100% control without changing its stored value. */
  percent?: boolean;
  /** Value display formatter. Defaults to `toFixed(2)`, matching the default 0..1/0.01 range. */
  format?: (v: number) => string;
  /** Fixed width of the value label, for a formatter whose output is wider than the default (it then neither wraps nor moves the slider). */
  valueWidth?: React.CSSProperties["width"];
  /** Accessible name for the exact input when the visible row label is contextual or repeated. */
  preciseAriaLabel?: string;
  /** Width of the exact input. */
  preciseWidth?: React.CSSProperties["width"];
  /** Optional upper bound for the exact input; omitted leaves its upper end unbounded. */
  preciseMax?: number | null;
  /** Overrides the slider minimum for the exact input. */
  preciseMin?: number;
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

export function SliderRow({ label, value, onChange, description, min = 0, max = 1, step = 0.01, percent, format, valueWidth, preciseAriaLabel, preciseWidth, preciseMax, preciseMin, disabled, resetButton, trailingAction, onPointerDown, onPointerUp, onPointerCancel, onBlur }: Props) {
  const [editingValue, setEditingValue] = useState(false);
  const factor = percent ? 100 : 1;
  const displayedValue = percent ? `${(value * factor).toFixed(1)}%` : format ? format(value) : value.toFixed(2);
  const valueStyle = valueWidth === undefined
    ? percent ? { ...sharedStyles.sliderRowValue, width: 48 } : sharedStyles.sliderRowValue
    : { ...sharedStyles.sliderRowValue, width: valueWidth, whiteSpace: "nowrap" as const };
  const preciseInputMax = preciseMax === null ? undefined : preciseMax ?? (percent ? max : undefined);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.elementsGap }}>
      <div style={sharedStyles.sliderRow}>
        <span style={{ ...sharedStyles.sliderRowLabel, ...(disabled ? { opacity: 0.4 } : {}) }}>{label}</span>
        <input
          type="range"
          name={label}
          className="maze-slider"
          style={{ flex: 1 }}
          min={min * factor}
          max={max * factor}
          step={percent ? 0.1 : step}
          value={value * factor}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value) / factor)}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onBlur={onBlur}
        />
        {editingValue && !disabled ? (
          <NumberInput
            name={`${label}-value`}
            ariaLabel={preciseAriaLabel ?? `${label} value`}
            autoFocus
            min={(preciseMin ?? min) * factor}
            max={preciseInputMax === undefined ? undefined : preciseInputMax * factor}
            value={percent ? (value * factor).toFixed(1) : String(value)}
            style={{ ...sharedStyles.input, width: preciseWidth ?? 48, height: controlRowHeight, boxSizing: "border-box", textAlign: "right" }}
            onChange={(raw) => {
              const next = Number(raw);
              if (!Number.isFinite(next)) return;
              const normalized = next / factor;
              onChange(percent ? Math.min(max, Math.max(min, normalized)) : normalized);
            }}
            onBlurCommit={() => setEditingValue(false)}
          />
        ) : (
          <Tooltip content={disabled ? undefined : m["common.exact_input"]()}>
            <button
              type="button"
              className="hoverable"
              aria-label={m["common.exact_input"]()}
              disabled={disabled}
              onClick={() => setEditingValue(true)}
              style={{ ...valueStyle, height: controlRowHeight, boxSizing: "border-box", border: "none", borderRadius: 3, padding: "2px 3px", fontFamily: "inherit", cursor: disabled ? "not-allowed" : "text" }}
            >
              {displayedValue}
            </button>
          </Tooltip>
        )}
        {trailingAction}
        {resetButton}
      </div>
      {description && <div style={{ ...typography.caption, lineHeight: 1.4 }}>{description}</div>}
    </div>
  );
}
