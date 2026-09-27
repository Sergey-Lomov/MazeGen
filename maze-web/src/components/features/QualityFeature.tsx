import React, { useEffect, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { typography, muted, disabled, spacing } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import { Switch } from "../Switch";
import * as m from "~/paraglide/messages";

const DEFAULT_MAX_ITERATIONS = 100;
const DEFAULT_TIME_BUDGET_SECS = 10;

/// Local draft state, committed (clamped) to the store only on blur/Enter — not on every
/// keystroke. Typing into a clamped-on-change number input fights the user mid-edit (e.g.
/// clamping "0" to "0.1" before they can type "0.5"). `value` resets the draft whenever the
/// store value changes from outside this input (switch toggle, project load).
function useCommitOnBlur(value: number, commit: (v: number) => void, clampMin: number) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  function doCommit() {
    const n = Number(draft);
    const clamped = Number.isFinite(n) ? Math.max(clampMin, n) : value;
    setDraft(String(clamped));
    commit(clamped);
  }

  return {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
    onBlur: doCommit,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") doCommit(); },
  };
}

export function QualityFeature() {
  const activeCheckCount = useMazeStore((s) => s.rules.reduce((n, r) => n + r.checks.length, 0));
  const openCard = useMazeStore((s) => s.openCard);
  const repairMaxIterations = useMazeStore((s) => s.repairMaxIterations);
  const repairTimeBudgetSecs = useMazeStore((s) => s.repairTimeBudgetSecs);
  const setRepairMaxIterations = useMazeStore((s) => s.setRepairMaxIterations);
  const setRepairTimeBudgetSecs = useMazeStore((s) => s.setRepairTimeBudgetSecs);

  // The store only has room for "a number" or "disabled" (null) — it can't remember what number
  // was last set while disabled. Re-enabling the switch should restore that last value, not snap
  // back to the hardcoded default, so it's kept here, outside the store, surviving the toggle off.
  const [lastMaxIterations, setLastMaxIterations] = useState(repairMaxIterations ?? DEFAULT_MAX_ITERATIONS);
  const [lastTimeBudgetSecs, setLastTimeBudgetSecs] = useState(repairTimeBudgetSecs ?? DEFAULT_TIME_BUDGET_SECS);

  const maxIterationsField = useCommitOnBlur(
    repairMaxIterations ?? lastMaxIterations,
    (v) => { const rounded = Math.round(v); setLastMaxIterations(rounded); setRepairMaxIterations(rounded); },
    1,
  );
  const timeBudgetField = useCommitOnBlur(
    repairTimeBudgetSecs ?? lastTimeBudgetSecs,
    (v) => { setLastTimeBudgetSecs(v); setRepairTimeBudgetSecs(v); },
    0.1,
  );

  return (
    <div style={styles.root}>
      {activeCheckCount === 0 ? (
        <span style={styles.empty}>{m["status.no_checks"]()}</span>
      ) : openCard !== "quality" ? (
        <span style={styles.hint}>{m["quality.open_to_configure"]()}</span>
      ) : null}
      <div style={styles.limitsBlock}>
        <div style={styles.limitRow}>
          <Switch
            checked={repairMaxIterations != null}
            onChange={(v) => setRepairMaxIterations(v ? lastMaxIterations : null)}
          />
          <span style={styles.limitLabel}>{m["quality.repair_max_iterations_label"]()}</span>
          <input
            type="number"
            name="repair-max-iterations"
            style={styles.limitInput}
            disabled={repairMaxIterations == null}
            min={1}
            step={1}
            {...maxIterationsField}
          />
        </div>
        <div style={styles.limitRow}>
          <Switch
            checked={repairTimeBudgetSecs != null}
            onChange={(v) => setRepairTimeBudgetSecs(v ? lastTimeBudgetSecs : null)}
          />
          <span style={styles.limitLabel}>{m["quality.repair_time_budget_label"]()}</span>
          <input
            type="number"
            name="repair-time-budget-seconds"
            style={styles.limitInput}
            disabled={repairTimeBudgetSecs == null}
            min={0.1}
            step={0.1}
            {...timeBudgetField}
          />
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
    paddingBottom: spacing.itemGap,
  },
  empty: {
    ...disabled(typography.body),
  },
  hint: {
    ...disabled(typography.body),
  },
  limitsBlock: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
    marginTop: spacing.itemGap,
  },
  limitRow: {
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
  },
  limitLabel: {
    ...muted(typography.body),
    flex: 1,
  },
  limitInput: {
    ...sharedStyles.inputSm,
    width: 60,
  },
};
