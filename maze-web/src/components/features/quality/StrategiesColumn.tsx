import { useState } from "react";
import { useMazeStore } from "../../../store/mazeStore";
import { StrategySelectDialog } from "../StrategySelectDialog";
import { Switch } from "../../Switch";
import * as m from "~/paraglide/messages";
import { qualityCanvasStyles as styles, cardStyle } from "./qualityCanvasStyles";
import type { StrategySlotVM } from "../useQualityViewModel";
import type { QualitySelection } from "./types";

interface Props {
  slots: StrategySlotVM[];
  selection: QualitySelection;
  onSelect: (s: QualitySelection) => void;
}

// One row per distinct issue kind (not per check) — N checks can share a kind, in which case
// they share this one strategy slot rather than each rendering their own.
export function StrategiesColumn({ slots, selection, onSelect }: Props) {
  const toggleStrategyDisabled = useMazeStore((s) => s.toggleStrategyDisabled);
  const [strategyDialogKind, setStrategyDialogKind] = useState<string | null>(null);

  return (
    <div style={styles.strategiesColumn}>
      <div style={styles.columnHeader}>
        <span style={styles.columnTitle}>{m["quality.strategies_column"]()}</span>
      </div>
      <div style={styles.columnBody}>
        {slots.map((slot) => {
          const strategySelected = selection?.type === "strategy" && selection.issueId === slot.kind;
          return (
            <div
              key={slot.kind}
              style={{ ...cardStyle(strategySelected), ...(slot.disabled ? styles.strategyDisabled : {}) }}
              onClick={() => {
                if (slot.strategy) {
                  onSelect({ type: "strategy", issueId: slot.kind, strategyId: slot.strategy.id });
                }
              }}
            >
              <span style={{ ...styles.cardLabel, ...(slot.strategy ? {} : styles.noStrategy) }}>
                {slot.strategy ? slot.strategy.label : m["strategy.no_fix.label"]()}
              </span>
              {slot.strategy && (
                <div
                  style={styles.toggleWrap}
                  title={slot.disabled ? m["quality.enable_strategy"]() : m["quality.disable_strategy"]()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Switch
                    checked={!slot.disabled}
                    onChange={() => toggleStrategyDisabled(slot.kind)}
                  />
                </div>
              )}
              <button
                style={styles.editBtn}
                title={m["quality.edit_strategy"]()}
                onClick={(e) => {
                  e.stopPropagation();
                  setStrategyDialogKind(slot.kind);
                }}
              >✎</button>
            </div>
          );
        })}
        {slots.length === 0 && (
          <span style={styles.emptyHint}>{m["quality.no_issues"]()}</span>
        )}
      </div>
      {strategyDialogKind !== null && (
        <StrategySelectDialog
          issueId={strategyDialogKind}
          onClose={() => setStrategyDialogKind(null)}
        />
      )}
    </div>
  );
}
