import React from "react";
import { Switch } from "../Switch";
import { sharedStyles } from "../../styles/shared";
import { ui, typography, spacing, dialogSpacing } from "../../styles/theme";
import { SplitPatternListEditor } from "./SplitPatternListEditor";
import type { SplitPattern } from "../../wasm/types";
import * as m from "~/paraglide/messages";

export interface SplitGenerationSettingsValue {
  pattern_mode: boolean;
  max_split_nodes: number;
  patterns: SplitPattern[];
}

interface Props {
  value: SplitGenerationSettingsValue;
  onChange: (next: SplitGenerationSettingsValue) => void;
}

/** Pattern-mode toggle + max_split_nodes (unconstrained mode) + weighted pattern list (pattern
 *  mode) — the same `SplitGenerationConfig` shape generation's own split settings edit, extracted
 *  from `SplitSettingsDialog` so `AddSplitStrategy`'s own `split_config` param (GitHub issue #247)
 *  can reuse the exact same body behind its own settings button/dialog, without generation's
 *  store coupling — pure over `value`/`onChange`, same rationale `SplitPatternListEditor` itself
 *  already follows for its own `patterns`/`onChange` pair. */
export function SplitGenerationSettingsBody({ value, onChange }: Props) {
  return (
    <>
      <div style={styles.row}>
        <span style={styles.label}>{m["generation.split_pattern_mode"]()}</span>
        <Switch checked={value.pattern_mode} onChange={(v) => onChange({ ...value, pattern_mode: v })} />
      </div>

      {!value.pattern_mode && (
        <div style={styles.row}>
          <span style={styles.label}>{m["generation.split_max_nodes"]()}</span>
          <input
            type="number"
            name="split-max-nodes"
            style={sharedStyles.inputSm}
            value={value.max_split_nodes}
            min={1}
            step={1}
            onChange={(e) => {
              const v = Math.max(1, Math.trunc(Number(e.target.value)));
              if (Number.isFinite(v)) onChange({ ...value, max_split_nodes: v });
            }}
          />
        </div>
      )}

      {value.pattern_mode && (
        <div style={styles.patternsWrap}>
          <SplitPatternListEditor
            patterns={value.patterns}
            withWeights
            onChange={(patterns) => onChange({ ...value, patterns })}
          />
        </div>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.groupGap,
    padding: `6px ${dialogSpacing.paddingX}px`,
  },
  label: {
    ...typography.control,
    color: ui.text.secondary,
  },
  patternsWrap: {
    marginTop: spacing.groupGap,
    borderTop: `1px solid ${ui.border.strong}`,
    padding: `${spacing.groupGap}px ${dialogSpacing.paddingX}px`,
  },
};
