import { useState } from "react";
import { useMazeStore } from "../../../store/mazeStore";
import { Switch } from "../../Switch";
import { StrategySelectDialog } from "../StrategySelectDialog";
import * as m from "~/paraglide/messages";
import { qualityCanvasStyles as styles, cardStyle } from "./qualityCanvasStyles";
import type { IssueVM, StrategyVM } from "../useQualityViewModel";
import type { QualitySelection } from "./types";

interface Props {
  issues: IssueVM[];
  issueStrategy: Record<string, StrategyVM | null>;
  issueStrategyDisabled: Record<string, boolean>;
  selection: QualitySelection;
  onSelect: (s: QualitySelection) => void;
}

export function IssuesColumn({ issues, issueStrategy, issueStrategyDisabled, selection, onSelect }: Props) {
  const [strategyDialogIssue, setStrategyDialogIssue] = useState<string | null>(null);
  const toggleStrategyDisabled = useMazeStore((s) => s.toggleStrategyDisabled);

  return (
    <div style={styles.issuesColumn}>
      <div style={styles.columnHeader}>
        <span style={styles.columnTitle}>{m["quality.issues_column"]()}</span>
      </div>
      <div style={styles.columnBody}>
        {issues.map((issue) => {
          const issueSelected = selection?.type === "issue" && selection.id === issue.id;
          const strategy = issueStrategy[issue.id];
          const disabled = issueStrategyDisabled[issue.id];
          const strategySelected =
            selection?.type === "strategy" && selection.issueId === issue.id;

          return (
            <div key={issue.id} style={styles.issueRow}>
              <div
                style={{ ...cardStyle(issueSelected), ...styles.issueCard }}
                onClick={() => onSelect({ type: "issue", id: issue.id })}
              >
                <span style={styles.cardLabel}>{issue.label}</span>
              </div>
              <div
                style={{ ...cardStyle(strategySelected), ...styles.strategyCard, ...(disabled ? styles.strategyDisabled : {}) }}
                onClick={() => {
                  if (strategy) {
                    onSelect({ type: "strategy", issueId: issue.id, strategyId: strategy.id });
                  }
                }}
              >
                <span style={{ ...styles.cardLabel, ...(strategy ? {} : styles.noStrategy) }}>
                  {strategy ? strategy.label : m["strategy.no_fix.label"]()}
                </span>
                {strategy && (
                  <div
                    style={styles.toggleWrap}
                    title={disabled ? m["quality.enable_strategy"]() : m["quality.disable_strategy"]()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Switch
                      checked={!disabled}
                      onChange={() => toggleStrategyDisabled(issue.id)}
                    />
                  </div>
                )}
                <button
                  style={styles.editBtn}
                  title={m["quality.edit_strategy"]()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setStrategyDialogIssue(issue.id);
                  }}
                >✎</button>
              </div>
            </div>
          );
        })}
        {issues.length === 0 && (
          <span style={styles.emptyHint}>{m["quality.no_issues"]()}</span>
        )}
      </div>
      {strategyDialogIssue !== null && (
        <StrategySelectDialog
          issueId={strategyDialogIssue}
          onClose={() => setStrategyDialogIssue(null)}
        />
      )}
    </div>
  );
}
