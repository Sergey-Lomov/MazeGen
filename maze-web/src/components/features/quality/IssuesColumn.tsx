import { useState } from "react";
import { StrategySelectDialog } from "../StrategySelectDialog";
import * as m from "~/paraglide/messages";
import { qualityCanvasStyles as styles, cardStyle } from "./qualityCanvasStyles";
import type { IssueVM, StrategyVM } from "../useQualityViewModel";
import type { QualitySelection } from "./types";

interface Props {
  issues: IssueVM[];
  issueStrategy: Record<string, StrategyVM | null>;
  selection: QualitySelection;
  onSelect: (s: QualitySelection) => void;
}

export function IssuesColumn({ issues, issueStrategy, selection, onSelect }: Props) {
  const [strategyDialogIssue, setStrategyDialogIssue] = useState<string | null>(null);

  return (
    <div style={styles.issuesColumn}>
      <div style={styles.columnHeader}>
        <span style={styles.columnTitle}>{m["quality.issues_column"]()}</span>
      </div>
      <div style={styles.columnBody}>
        {issues.map((issue) => {
          const issueSelected = selection?.type === "issue" && selection.id === issue.id;
          const strategy = issueStrategy[issue.id];
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
                style={{ ...cardStyle(strategySelected), ...styles.strategyCard }}
                onClick={() => {
                  if (strategy) {
                    onSelect({ type: "strategy", issueId: issue.id, strategyId: strategy.id });
                  }
                }}
              >
                <span style={{ ...styles.cardLabel, ...(strategy ? {} : styles.noStrategy) }}>
                  {strategy ? strategy.label : m["strategy.no_fix.label"]()}
                </span>
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
