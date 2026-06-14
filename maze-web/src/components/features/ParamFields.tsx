import React from "react";
import type { ParamDescriptor } from "../../wasm/types";
import { sharedStyles } from "../../styles/shared";
import { colors, font } from "../../styles/theme";

interface Props {
  params: ParamDescriptor[];
  values: Record<string, string>;
  onChange: (paramId: string, value: string) => void;
}

export function ParamFields({ params, values, onChange }: Props) {
  if (params.length === 0) return null;
  return (
    <>
      {params.map((p) => (
        <div key={p.id} style={styles.row}>
          <label style={styles.label}>{p.label}</label>
          {(p.kind.type === "float" || p.kind.type === "integer") && (
            <input
              type="number"
              style={styles.input}
              value={values[p.id] ?? ""}
              min={p.kind.min}
              max={p.kind.max}
              step={p.kind.type === "integer" ? 1 : 0.1}
              onChange={(e) => onChange(p.id, e.target.value)}
            />
          )}
          {p.kind.type === "bool" && (
            <input
              type="checkbox"
              checked={(values[p.id] ?? "") === "true"}
              onChange={(e) => onChange(p.id, e.target.checked ? "true" : "false")}
            />
          )}
          {p.kind.type === "enum" && (
            <select
              style={styles.select}
              value={values[p.id] ?? ""}
              onChange={(e) => onChange(p.id, e.target.value)}
            >
              {p.kind.options.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          )}
        </div>
      ))}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  label: {
    fontSize: font.lg,
    color: colors.textMuted,
    flex: 1,
  },
  input: {
    ...sharedStyles.inputSm,
    width: 80,
  },
  select: {
    ...sharedStyles.selectSm,
    width: 120,
  },
};
