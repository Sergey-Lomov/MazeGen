import React, { useEffect, useRef, useState } from "react";
import type { ParamDescriptor } from "../../wasm/types";
import { sharedStyles } from "../../styles/shared";
import { typography, font, spacing } from "../../styles/theme";
import { resolveParamOptionLabel, resolveParamOptionExplanation } from "./qualityI18n";
import { Switch } from "../Switch";
import { Inline } from "../Layout";

const OPTION_WIDTH_BUFFER = 10;
const SELECT_MAX_WIDTH_RATIO = 0.4;

// Float params rendered as a 0-100 percent slider instead of the default number input — an
// explicit id allowlist rather than a blanket "every Float is a slider" rule, since most Float
// params (reserve_percent, min_distance, etc.) are edited as exact numbers elsewhere in the app.
const PERCENT_SLIDER_PARAM_IDS = new Set(["unreachable_priority", "one_way_chance"]);

let measureCanvasCtx: CanvasRenderingContext2D | null | undefined;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCanvasCtx === undefined) {
    measureCanvasCtx = document.createElement("canvas").getContext("2d");
    if (measureCanvasCtx) {
      measureCanvasCtx.font = `${font.lg}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    }
  }
  return measureCanvasCtx;
}

function widestOptionWidth(labels: string[]): number {
  const ctx = getMeasureCtx();
  if (!ctx) return 0;
  let max = 0;
  for (const label of labels) {
    max = Math.max(max, ctx.measureText(label).width);
  }
  return max;
}

interface Props {
  params: ParamDescriptor[];
  values?: Record<string, string>;
  getValue?: (p: ParamDescriptor) => string;
  onChange: (paramId: string, value: string) => void;
  /** Show each param's description as secondary text below its row. Only the expanded
   * detail view (e.g. QualityDetailPanel, AddCheckToRuleDialog) should set this — compact
   * views (rule cards, feature cards) must not. */
  getDescription?: (p: ParamDescriptor) => string | undefined;
  /** Renders every control non-interactive (native `disabled`) — e.g. a rule-card check row
   * whose check is toggled off (`CheckInstance.disabled`). Values are still shown, just not
   * editable, until the check is re-enabled. */
  disabled?: boolean;
}

const SELECT_HORIZONTAL_CHROME = 4 + 18 + 2; // padding-left + padding-right + border
const ROW_GAP = 10; // styles.row's `gap`

function enumSelectWidth(p: ParamDescriptor, containerWidth: number): number | undefined {
  if (p.kind.type !== "enum") return undefined;
  const labels = p.kind.options.map((opt) => resolveParamOptionLabel(p.id, opt));
  const textWidth = widestOptionWidth(labels);
  const desired = Math.ceil(textWidth + OPTION_WIDTH_BUFFER + SELECT_HORIZONTAL_CHROME);
  if (containerWidth <= 0) return desired;

  const softCap = Math.floor(containerWidth * SELECT_MAX_WIDTH_RATIO);
  if (desired <= softCap) return desired;

  // Widest option needs more than the soft cap — allow growing further, but never
  // past the point where the label would get squeezed below its own text width.
  const labelWidth = widestOptionWidth([p.label]);
  const hardCap = Math.floor(containerWidth - labelWidth - ROW_GAP);
  return Math.min(desired, Math.max(softCap, hardCap));
}

export function ParamFields({ params, values, getValue, onChange, getDescription, disabled }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (params.length === 0) return null;

  function get(p: ParamDescriptor): string {
    if (getValue) return getValue(p);
    return values?.[p.id] ?? "";
  }

  // "min,max" -- mirrors maze-core's `parse_param` Interval encoding (repair/params.rs).
  function getIntervalParts(p: ParamDescriptor): [string, string] {
    const raw = get(p);
    const [lo, hi] = raw.split(",");
    return [lo ?? "", hi ?? ""];
  }

  return (
    <div ref={containerRef} style={{ ...styles.fieldsWrap, gap: getDescription ? spacing.sectionGap : spacing.itemGap }}>
      {params.map((p) => {
        const description = getDescription?.(p);
        return (
          <div key={p.id} style={styles.field}>
            <Inline gap="rowGap" justify="space-between">
              <label style={styles.label}>{p.label}</label>
              {/* Each control stops its own click from bubbling — not the whole row/field — so a
                  container that turns clicks into a "select this" action elsewhere (e.g.
                  `NestedStrategyPanel`'s strategy block) still catches clicks on the label or
                  empty space around a control, just not on the control itself. */}
              {p.kind.type === "float" && PERCENT_SLIDER_PARAM_IDS.has(p.id) && (
                <span style={styles.percentSliderWrap} onClick={(e) => e.stopPropagation()}>
                  <input
                    type="range"
                    className="maze-slider"
                    style={styles.percentSlider}
                    min={p.kind.min}
                    max={p.kind.max}
                    step={1}
                    value={get(p)}
                    disabled={disabled}
                    onChange={(e) => onChange(p.id, e.target.value)}
                  />
                  <span style={styles.percentSliderValue}>{Math.round(Number(get(p)))}%</span>
                </span>
              )}
              {(p.kind.type === "float" || p.kind.type === "integer") && !PERCENT_SLIDER_PARAM_IDS.has(p.id) && (
                <input
                  type="number"
                  style={styles.input}
                  value={get(p)}
                  min={p.kind.min}
                  max={p.kind.max}
                  step={p.kind.type === "integer" ? 1 : 0.1}
                  disabled={disabled}
                  onChange={(e) => onChange(p.id, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
              {p.kind.type === "interval" && (
                <span style={styles.intervalWrap} onClick={(e) => e.stopPropagation()}>
                  {(() => {
                    const [lo, hi] = getIntervalParts(p);
                    const kind = p.kind;
                    return (
                      <>
                        <input
                          type="number"
                          style={styles.input}
                          value={lo}
                          min={kind.min}
                          max={kind.max}
                          disabled={disabled}
                          onChange={(e) => onChange(p.id, `${e.target.value},${hi}`)}
                          onBlur={(e) => {
                            // Clamp on blur, not on every keystroke -- an onChange clamp would
                            // cap the value against the OLD hi mid-edit, making it impossible to
                            // type a min above the current max (e.g. raising min from 3 to 30
                            // while max is still 10 would freeze at 10 on the first keystroke).
                            // Deferring to blur lets the field hold a temporarily-inverted value
                            // while both ends are being edited in sequence.
                            // Empty string parses to 0 via Number(), not NaN -- an explicit
                            // emptiness check catches "cleared, then blurred without typing"
                            // separately from a genuine out-of-order numeric value.
                            const raw = e.target.value;
                            const hiNum = Number(hi);
                            if (raw === "" && Number.isFinite(hiNum)) {
                              onChange(p.id, `${kind.min},${hi}`);
                              return;
                            }
                            const loNum = Number(raw);
                            if (Number.isFinite(loNum) && Number.isFinite(hiNum) && loNum > hiNum) {
                              onChange(p.id, `${hiNum},${hiNum}`);
                            }
                          }}
                        />
                        <span style={styles.intervalSeparator}>–</span>
                        <input
                          type="number"
                          style={styles.input}
                          value={hi}
                          min={kind.min}
                          max={kind.max}
                          disabled={disabled}
                          onChange={(e) => onChange(p.id, `${lo},${e.target.value}`)}
                          onBlur={(e) => {
                            // Same rationale as the min input's own onBlur clamp above, including
                            // the empty-string special case.
                            const raw = e.target.value;
                            const loNum = Number(lo);
                            if (raw === "" && Number.isFinite(loNum)) {
                              onChange(p.id, `${lo},${kind.max}`);
                              return;
                            }
                            const hiNum = Number(raw);
                            if (Number.isFinite(loNum) && Number.isFinite(hiNum) && hiNum < loNum) {
                              onChange(p.id, `${loNum},${loNum}`);
                            }
                          }}
                        />
                      </>
                    );
                  })()}
                </span>
              )}
              {p.kind.type === "bool" && (
                <span style={styles.switchWrap} onClick={(e) => e.stopPropagation()}>
                  <Switch
                    checked={get(p) === "true"}
                    disabled={disabled}
                    onChange={(checked) => onChange(p.id, checked ? "true" : "false")}
                  />
                </span>
              )}
              {p.kind.type === "enum" && (
                <select
                  style={{ ...styles.select, width: enumSelectWidth(p, containerWidth) }}
                  value={get(p)}
                  disabled={disabled}
                  onChange={(e) => onChange(p.id, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                >
                  {p.kind.options.map((opt) => (
                    <option key={opt} value={opt}>{resolveParamOptionLabel(p.id, opt)}</option>
                  ))}
                </select>
              )}
            </Inline>
            {description && <div style={styles.description}>{description}</div>}
            {description && p.kind.type === "enum" && (
              <ul style={styles.optionList}>
                {p.kind.options.map((opt) => {
                  const explanation = resolveParamOptionExplanation(p.id, opt);
                  if (!explanation) return null;
                  return (
                    <li key={opt}>
                      <strong>{resolveParamOptionLabel(p.id, opt)}</strong> — {explanation}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  fieldsWrap: {
    display: "flex",
    flexDirection: "column",
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.elementsGap,
  },
  // `typography.message` — the theme's own "label"-weight token (body size, secondary color) —
  // see theme.ts's own guidance against composing fontSize/color ad hoc.
  label: {
    ...typography.message,
    flex: 1,
  },
  description: {
    ...typography.caption,
    lineHeight: 1.4,
  },
  optionList: {
    margin: `${spacing.elementsGap}px 0 0`,
    paddingLeft: 16,
    ...typography.caption,
    lineHeight: 1.4,
  },
  input: {
    ...sharedStyles.inputSm,
    width: 80,
    boxSizing: "border-box",
    height: 22,
  },
  select: {
    ...sharedStyles.selectSm,
    boxSizing: "border-box",
    height: 22,
    padding: "2px 18px 2px 4px",
  },
  // `display: flex` (not the default `inline`) so this stopPropagation wrapper doesn't disturb
  // `row`'s flex layout — `Switch`'s own `flexShrink: 0` still applies to it as a flex item.
  switchWrap: {
    display: "flex",
    flexShrink: 0,
  },
  intervalWrap: {
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
    flexShrink: 0,
  },
  intervalSeparator: {
    ...typography.caption,
  },
  percentSliderWrap: {
    display: "flex",
    alignItems: "center",
    gap: spacing.groupGap,
    flex: 1,
    justifyContent: "flex-end",
  },
  percentSlider: {
    width: 100,
  },
  percentSliderValue: {
    ...typography.caption,
    width: 32,
    textAlign: "right",
    flexShrink: 0,
  },
};
