import { useState, useCallback } from "react";
import { useMazeStore } from "../store/mazeStore";
import { generateMazeSteps } from "../wasm/mazeService";
import type { GenerationStepsSnapshot, NodeDto, EdgeDto } from "../wasm/types";
import { sharedStyles, buttonStyle } from "../styles/shared";
import { colors } from "../styles/theme";

interface Props {
  onClose: () => void;
}

export function GenerationDebugPanel({ onClose }: Props) {
  const seed = useMazeStore((s) => s.seed);
  const tessellationConfig = useMazeStore((s) => s.tessellationConfig);
  const initialConfig = useMazeStore((s) => s.initialConfig);
  const elementsConfig = useMazeStore((s) => s.elementsConfig);
  const selectedChecks = useMazeStore((s) => s.selectedChecks);
  const selectedStrategies = useMazeStore((s) => s.selectedStrategies);
  const strategyParams = useMazeStore((s) => s.strategyParams);
  const availableStrategies = useMazeStore((s) => s.availableStrategies);
  const setDebugState = useMazeStore((s) => s.setDebugState);

  const [snapshot, setSnapshot] = useState<GenerationStepsSnapshot | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    try {
      const strategies: Record<string, { id: string; params: Record<string, string> }> = {};
      for (const [issueKind, strategyId] of Object.entries(selectedStrategies)) {
        if (!strategyId) continue;
        const descriptor = availableStrategies.find((s) => s.id === strategyId);
        const paramOverrides = strategyParams[strategyId] ?? {};
        const params: Record<string, string> = {};
        if (descriptor) {
          for (const p of descriptor.params) {
            if (paramOverrides[p.id] !== undefined) params[p.id] = paramOverrides[p.id];
          }
        }
        strategies[issueKind] = { id: strategyId, params };
      }
      const result = generateMazeSteps(seed, {
        tessellation: tessellationConfig,
        checks: selectedChecks,
        strategies,
        initial: initialConfig,
        elements: elementsConfig,
      });
      setSnapshot(result);
      setError(null);
      const lastStep = result.steps.length > 0 ? result.steps.length - 1 : 0;
      setStep(lastStep);
      const edges: EdgeDto[] = result.steps[lastStep]?.edges ?? [];
      setDebugState(result.nodes, edges, tessellationConfig);
    } catch (e) {
      setError(String(e));
    }
  }, [seed, tessellationConfig, initialConfig, elementsConfig, selectedChecks, selectedStrategies, strategyParams, availableStrategies, setDebugState]);

  const applyStep = useCallback((s: number) => {
    if (!snapshot) return;
    setStep(s);
    const edges: EdgeDto[] = snapshot.steps[s]?.edges ?? [];
    const nodes: NodeDto[] = snapshot.nodes;
    setDebugState(nodes, edges, tessellationConfig);
  }, [snapshot, tessellationConfig, setDebugState]);

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>Generation Debug</span>
        <button style={styles.closeBtn} onClick={onClose}>✕</button>
      </div>
      <button style={styles.btn} onClick={load}>Load Steps</button>
      {error && <div style={styles.error}>{error}</div>}
      {snapshot && snapshot.steps.length > 0 && (
        <>
          <div style={styles.stepLabel}>
            Step {step + 1} / {snapshot.steps.length}
            {" "}({snapshot.steps[step]?.edges.length ?? 0} edges)
          </div>
          <input
            type="range"
            min={0}
            max={snapshot.steps.length - 1}
            value={step}
            onChange={(e) => applyStep(Number(e.target.value))}
            style={styles.slider}
          />
          <div style={styles.btnRow}>
            <button style={styles.stepBtn} onClick={() => applyStep(Math.max(0, step - 1))}>◀</button>
            <button style={styles.stepBtn} onClick={() => applyStep(Math.min(snapshot.steps.length - 1, step + 1))}>▶</button>
          </div>
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 12,
    borderBottom: `1px solid ${colors.borderMid}`,
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  title: sharedStyles.panelTitle,
  closeBtn: sharedStyles.closeBtn,
  btn: buttonStyle("primary"),
  stepLabel: { fontSize: 11, color: colors.textFaint },
  slider: { width: "100%", cursor: "pointer" },
  btnRow: { display: "flex", gap: 4 },
  stepBtn: {
    ...sharedStyles.btnMuted,
    flex: 1,
    padding: "4px 0",
    fontSize: 14,
  },
  error: sharedStyles.errorMsg,
};
