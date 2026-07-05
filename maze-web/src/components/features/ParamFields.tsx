import React, { useEffect, useRef, useState } from "react";
import type { ParamDescriptor } from "../../wasm/types";
import { sharedStyles } from "../../styles/shared";
import { typography, font } from "../../styles/theme";
import { resolveParamOptionLabel, resolveParamOptionExplanation } from "./qualityI18n";

const OPTION_WIDTH_BUFFER = 10;
const SELECT_MAX_WIDTH_RATIO = 0.4;

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

export function ParamFields({ params, values, getValue, onChange, getDescription }: Props) {
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

  return (
    <div ref={containerRef} style={{ ...styles.fieldsWrap, gap: getDescription ? 16 : 4 }}>
      {params.map((p) => {
        const description = getDescription?.(p);
        return (
          <div key={p.id} style={styles.field}>
            <div style={styles.row}>
              <label style={styles.label}>{p.label}</label>
              {(p.kind.type === "float" || p.kind.type === "integer") && (
                <input
                  type="number"
                  style={styles.input}
                  value={get(p)}
                  min={p.kind.min}
                  max={p.kind.max}
                  step={p.kind.type === "integer" ? 1 : 0.1}
                  onChange={(e) => onChange(p.id, e.target.value)}
                />
              )}
              {p.kind.type === "bool" && (
                <input
                  type="checkbox"
                  checked={get(p) === "true"}
                  onChange={(e) => onChange(p.id, e.target.checked ? "true" : "false")}
                />
              )}
              {p.kind.type === "enum" && (
                <select
                  style={{ ...styles.select, width: enumSelectWidth(p, containerWidth) }}
                  value={get(p)}
                  onChange={(e) => onChange(p.id, e.target.value)}
                >
                  {p.kind.options.map((opt) => (
                    <option key={opt} value={opt}>{resolveParamOptionLabel(p.id, opt)}</option>
                  ))}
                </select>
              )}
            </div>
            {description && <div style={styles.description}>{description}</div>}
            {description && p.kind.type === "enum" && (
              <ul style={styles.optionList}>
                {p.kind.options.map((opt) => {
                  const explanation = resolveParamOptionExplanation(p.id, opt);
                  if (!explanation) return null;
                  return (
                    <li key={opt} style={styles.optionListItem}>
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
    gap: 2,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
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
    margin: "2px 0 0",
    paddingLeft: 16,
    ...typography.caption,
    lineHeight: 1.4,
  },
  optionListItem: {
    marginBottom: 2,
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
};
