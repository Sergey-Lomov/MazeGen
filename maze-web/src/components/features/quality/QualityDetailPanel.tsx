import React from "react";
import { useMazeStore } from "../../../store/mazeStore";
import { ParamizedDetail } from "./ParamizedDetail";
import { resolveStrategyDescription } from "../qualityI18n";
import * as m from "~/paraglide/messages";
import { qualityCanvasStyles as styles } from "./qualityCanvasStyles";
import type { useQualityViewModel } from "../useQualityViewModel";
import type { QualitySelection } from "./types";

interface Props {
  selection: QualitySelection;
  vm: ReturnType<typeof useQualityViewModel>;
  flushRef: React.MutableRefObject<() => void>;
}

export function QualityDetailPanel({ selection, vm, flushRef }: Props) {
  const checkParams = useMazeStore((s) => s.checkParams);
  const setCheckParam = useMazeStore((s) => s.setCheckParam);
  const strategyParams = useMazeStore((s) => s.strategyParams);
  const setStrategyParam = useMazeStore((s) => s.setStrategyParam);

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
    return (
      <ParamizedDetail
        id={check.id}
        label={check.label}
        description={check.description}
        params={check.params}
        storeValues={checkParams[check.id] ?? {}}
        onCommit={(paramId, value) => setCheckParam(check.id, paramId, value)}
        flushRef={flushRef}
      />
    );
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
    return (
      <ParamizedDetail
        id={strategy.id}
        label={strategy.label}
        description={resolveStrategyDescription(strategy.id)}
        params={strategy.params}
        storeValues={strategyParams[strategy.id] ?? {}}
        onCommit={(paramId, value) => setStrategyParam(strategy.id, paramId, value)}
        flushRef={flushRef}
      />
    );
  }

  return <div style={styles.detailPanel} />;
}
