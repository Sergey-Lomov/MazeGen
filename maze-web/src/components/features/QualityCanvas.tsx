import React, { useState, useRef } from "react";
import { X } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { useQualityViewModel } from "./useQualityViewModel";
import { useParamEditor } from "./useParamEditor";
import { ParamFields } from "./ParamFields";
import { CheckSelectDialog } from "./CheckSelectDialog";
import { StrategySelectDialog } from "./StrategySelectDialog";
import type { CheckVM, IssueVM, StrategyVM } from "./useQualityViewModel";
import { resolveStrategyDescription } from "./qualityI18n";
import { colors, font, radius } from "../../styles/theme";
import * as m from "~/paraglide/messages";

type QualitySelection =
  | { type: "check"; id: string }
  | { type: "issue"; id: string }
  | { type: "strategy"; issueId: string; strategyId: string }
  | null;

function cardStyle(selected: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 10px",
    background: colors.bgPanel,
    borderRadius: radius.md,
    border: `1px solid ${selected ? colors.borderSelected : colors.borderMid}`,
    cursor: "pointer",
    userSelect: "none",
    minHeight: 34,
  };
}

export function QualityCanvas() {
  const [selection, setSelection] = useState<QualitySelection>(null);
  const vm = useQualityViewModel();
  const flushRef = useRef<() => void>(() => {});

  function handleSelect(next: QualitySelection) {
    flushRef.current();
    setSelection(next);
  }

  return (
    <div style={styles.root}>
      <ChecksColumn
        checks={vm.checks}
        selection={selection}
        onSelect={handleSelect}
      />
      <div style={styles.divider} />
      <IssuesColumn
        issues={vm.issues}
        issueStrategy={vm.issueStrategy}
        selection={selection}
        onSelect={handleSelect}
      />
      <div style={styles.divider} />
      <DetailPanel
        selection={selection}
        vm={vm}
        flushRef={flushRef}
      />
    </div>
  );
}

function ChecksColumn({ checks, selection, onSelect }: {
  checks: CheckVM[];
  selection: QualitySelection;
  onSelect: (s: QualitySelection) => void;
}) {
  const removeCheck = useMazeStore((s) => s.removeCheck);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  return (
    <div style={styles.column}>
      <div style={styles.columnHeader}>
        <span style={styles.columnTitle}>{m["quality.checks_column"]()}</span>
        <button style={styles.addBtn} onClick={() => setAddDialogOpen(true)} title={m["quality.add_check"]()}>+</button>
      </div>
      <div style={styles.columnBody}>
        {checks.map((check) => {
          const selected = selection?.type === "check" && selection.id === check.id;
          return (
            <div
              key={check.id}
              style={cardStyle(selected)}
              onClick={() => onSelect({ type: "check", id: check.id })}
            >
              <span style={styles.cardLabel}>{check.label}</span>
              <button
                style={styles.removeBtn}
                title={m["quality.remove"]()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (selected) onSelect(null);
                  removeCheck(check.id);
                }}
              >
                <TrashIcon />
              </button>
            </div>
          );
        })}
        {checks.length === 0 && (
          <span style={styles.emptyHint}>{m["status.no_checks"]()}</span>
        )}
      </div>
      {addDialogOpen && <CheckSelectDialog onClose={() => setAddDialogOpen(false)} />}
    </div>
  );
}

function IssuesColumn({ issues, issueStrategy, selection, onSelect }: {
  issues: IssueVM[];
  issueStrategy: Record<string, StrategyVM | null>;
  selection: QualitySelection;
  onSelect: (s: QualitySelection) => void;
}) {
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

function DetailPanel({ selection, vm, flushRef }: {
  selection: QualitySelection;
  vm: ReturnType<typeof useQualityViewModel>;
  flushRef: React.MutableRefObject<() => void>;
}) {
  if (!selection) {
    return (
      <div style={styles.detailPanel}>
        <span style={styles.detailEmpty}>{m["quality.select_to_view"]()}</span>
      </div>
    );
  }

  if (selection.type === "check") {
    const check = vm.checks.find((c) => c.id === selection.id);
    if (!check) return <div style={styles.detailPanel} />;
    return <CheckDetail check={check} flushRef={flushRef} />;
  }

  if (selection.type === "issue") {
    const issue = vm.issues.find((i) => i.id === selection.id);
    if (!issue) return <div style={styles.detailPanel} />;
    const detectors = vm.issueToChecks[issue.id] ?? [];
    return (
      <div style={styles.detailPanel}>
        <div style={styles.detailTitle}>{issue.label}</div>
        {issue.description && <div style={styles.detailDesc}>{issue.description}</div>}
        {detectors.length > 0 && (
          <>
            <div style={styles.detailSectionLabel}>{m["quality.detected_by"]()}</div>
            {detectors.map((c) => (
              <div key={c.id} style={styles.detailListItem}>{c.label}</div>
            ))}
          </>
        )}
      </div>
    );
  }

  if (selection.type === "strategy") {
    const strategy = vm.issueStrategy[selection.issueId];
    if (!strategy) return <div style={styles.detailPanel} />;
    return <StrategyDetail strategy={strategy} flushRef={flushRef} />;
  }

  return <div style={styles.detailPanel} />;
}

function CheckDetail({ check, flushRef }: {
  check: CheckVM;
  flushRef: React.MutableRefObject<() => void>;
}) {
  const checkParams = useMazeStore((s) => s.checkParams);
  const setCheckParam = useMazeStore((s) => s.setCheckParam);

  const storeValues = checkParams[check.id] ?? {};
  const { values, onChange, flushRef: localFlushRef } = useParamEditor({
    entityId: check.id,
    params: check.params,
    storeValues,
    onCommit: (paramId, value) => setCheckParam(check.id, paramId, value),
  });

  flushRef.current = localFlushRef.current;

  return (
    <div style={styles.detailPanel}>
      <div style={styles.detailTitle}>{check.label}</div>
      <div style={styles.detailDesc}>{check.description}</div>
      {check.params.length > 0 && (
        <>
          <div style={styles.detailDivider} />
          <ParamFields params={check.params} values={values} onChange={onChange} />
        </>
      )}
    </div>
  );
}

function StrategyDetail({ strategy, flushRef }: {
  strategy: StrategyVM;
  flushRef: React.MutableRefObject<() => void>;
}) {
  const strategyParams = useMazeStore((s) => s.strategyParams);
  const setStrategyParam = useMazeStore((s) => s.setStrategyParam);

  const description = resolveStrategyDescription(strategy.id);
  const storeValues = strategyParams[strategy.id] ?? {};
  const { values, onChange, flushRef: localFlushRef } = useParamEditor({
    entityId: strategy.id,
    params: strategy.params,
    storeValues,
    onCommit: (paramId, value) => setStrategyParam(strategy.id, paramId, value),
  });

  flushRef.current = localFlushRef.current;

  return (
    <div style={styles.detailPanel}>
      <div style={styles.detailTitle}>{strategy.label}</div>
      {description && <div style={styles.detailDesc}>{description}</div>}
      {strategy.params.length > 0 && (
        <>
          <div style={styles.detailDivider} />
          <ParamFields params={strategy.params} values={values} onChange={onChange} />
        </>
      )}
    </div>
  );
}

function TrashIcon() {
  return <X size={16} color={colors.textDim} />;
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "row",
    width: "100%",
    height: "100%",
    background: colors.bgApp,
    overflow: "hidden",
  },
  column: {
    display: "flex",
    flexDirection: "column",
    flex: "0 0 22%",
    minWidth: 0,
    overflow: "hidden",
  },
  issuesColumn: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  columnHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "0 12px",
    height: 36,
    borderBottom: `1px solid ${colors.borderMid}`,
    flexShrink: 0,
  },
  columnTitle: {
    fontSize: font.sm,
    fontWeight: 700,
    color: colors.textDim,
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    flex: 1,
  },
  addBtn: {
    background: "none",
    border: "none",
    color: colors.textDim,
    fontSize: 18,
    lineHeight: 1,
    cursor: "pointer",
    padding: "0 2px",
    flexShrink: 0,
  },
  columnBody: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "8px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  cardLabel: {
    fontSize: font.md,
    color: colors.textMuted,
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  removeBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 0,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
  },
  emptyHint: {
    fontSize: font.sm,
    color: colors.textVeryDim,
    padding: "4px 2px",
  },
  issueRow: {
    display: "flex",
    flexDirection: "row",
    gap: 8,
    alignItems: "stretch",
  },
  issueCard: {
    flex: "0 0 40%",
    minWidth: 0,
    alignSelf: "stretch",
  },
  strategyCard: {
    flex: 1,
    minWidth: 0,
    alignSelf: "stretch",
  },
  noStrategy: {
    color: colors.textVeryDim,
  },
  editBtn: {
    background: "none",
    border: "none",
    color: colors.textDim,
    padding: "0 2px",
    cursor: "pointer",
    fontSize: 16,
    lineHeight: 1,
    flexShrink: 0,
    opacity: 0.7,
  },
  divider: {
    width: 1,
    background: colors.borderMid,
    flexShrink: 0,
  },
  detailPanel: {
    flex: "0 0 28%",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: "10px 14px",
    overflowY: "auto" as const,
    minWidth: 0,
    borderLeft: `1px solid ${colors.borderMid}`,
  },
  detailEmpty: {
    fontSize: font.sm,
    color: colors.textVeryDim,
    marginTop: 8,
  },
  detailTitle: {
    fontSize: font.xl,
    fontWeight: 700,
    color: colors.textSecondary,
  },
  detailDesc: {
    fontSize: font.lg,
    color: colors.textFaint,
    lineHeight: 1.5,
  },
  detailSectionLabel: {
    fontSize: font.sm,
    color: colors.textDim,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginTop: 4,
  },
  detailListItem: {
    fontSize: font.md,
    color: colors.textMuted,
    padding: "2px 0",
  },
  detailDivider: {
    borderTop: `1px solid ${colors.borderDim}`,
    marginTop: 2,
    marginBottom: 2,
  },
};
