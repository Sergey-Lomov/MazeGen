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
  const rules = useMazeStore((s) => s.rules);
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
    const storeValues = rules.find((r) => r.id === check.ruleId)?.checks.find((c) => c.localId === check.localId)?.params ?? {};
    return (
      <ParamizedDetail
        id={check.id}
        label={check.label}
        description={check.description}
        params={check.params}
        storeValues={storeValues}
        onCommit={(paramId, value) => setCheckParam(check.ruleId, check.localId, paramId, value)}
        flushRef={flushRef}
      />
    );
  }

  if (selection.type === "logging") {
    return (
      <div style={styles.detailPanel}>
        <span style={styles.detailTitle}>{m["strategy.no_fix.label"]()}</span>
        <p style={styles.detailDesc}>{m["strategy.no_fix.description"]()}</p>
      </div>
    );
  }

  if (selection.type === "strategy") {
    const slot = vm.strategySlots.find((s) => s.ruleId === selection.ruleId);
    const strategy = slot?.strategy;
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
