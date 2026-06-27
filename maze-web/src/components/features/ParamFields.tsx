import React from "react";
import type { ParamDescriptor } from "../../wasm/types";
import { sharedStyles } from "../../styles/shared";
import { colors, font } from "../../styles/theme";
import { resolveParamOptionLabel, resolveParamOptionExplanation } from "./qualityI18n";

interface Props {
  params: ParamDescriptor[];
  values?: Record<string, string>;
  getValue?: (p: ParamDescriptor) => string;
  onChange: (paramId: string, value: string) => void;
  labelSize?: "sm" | "lg";
  /** Show each param's description as secondary text below its row. Only the expanded
   * detail view (e.g. QualityDetailPanel, AddCheckToRuleDialog) should set this — compact
   * views (rule cards, feature cards) must not. */
  getDescription?: (p: ParamDescriptor) => string | undefined;
}

export function ParamFields({ params, values, getValue, onChange, labelSize = "lg", getDescription }: Props) {
  if (params.length === 0) return null;

  function get(p: ParamDescriptor): string {
    if (getValue) return getValue(p);
    return values?.[p.id] ?? "";
  }

  return (
    <div style={{ ...styles.fieldsWrap, gap: getDescription ? 10 : 4 }}>
      {params.map((p) => {
        const description = getDescription?.(p);
        return (
          <div key={p.id} style={styles.field}>
            <div style={styles.row}>
              <label style={{ ...styles.label, fontSize: labelSize === "sm" ? font.sm : font.lg }}>{p.label}</label>
              {(p.kind.type === "float" || p.kind.type === "integer") && (
                <div style={styles.inputWithUnit}>
                  <input
                    type="number"
                    style={styles.input}
                    value={get(p)}
                    min={p.kind.min}
                    max={p.kind.max}
                    step={p.kind.type === "integer" ? 1 : 0.1}
                    onChange={(e) => onChange(p.id, e.target.value)}
                  />
                  {p.id === "min_region_ratio" && <span style={styles.unit}>%</span>}
                </div>
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
                  style={styles.select}
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
  label: {
    color: colors.textMuted,
    flex: 1,
  },
  description: {
    fontSize: font.sm,
    color: colors.textDim,
    lineHeight: 1.4,
  },
  optionList: {
    margin: "2px 0 0",
    paddingLeft: 16,
    fontSize: font.sm,
    color: colors.textDim,
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
  inputWithUnit: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  unit: {
    color: colors.textMuted,
  },
  select: {
    ...sharedStyles.selectSm,
    width: 120,
    boxSizing: "border-box",
    height: 22,
    padding: "2px 18px 2px 4px",
  },
};
