import { useState, useCallback } from "react";
import { useMazeStore } from "../store/mazeStore";
import { generateMazeSteps } from "../wasm/mazeService";
import type { GenerationStepsSnapshot, NodeDto, EdgeDto } from "../wasm/types";

interface Props {
  onClose: () => void;
}

export function GenerationDebugPanel({ onClose }: Props) {
  const seed = useMazeStore((s) => s.seed);
  const tessellationConfig = useMazeStore((s) => s.tessellationConfig);
  const initialConfig = useMazeStore((s) => s.initialConfig);
  const selectedChecks = useMazeStore((s) => s.selectedChecks);
  const selectedStrategies = useMazeStore((s) => s.selectedStrategies);
  const strategyParams = useMazeStore((s) => s.strategyParams);
  const setDebugState = useMazeStore((s) => s.setDebugState);

  const [snapshot, setSnapshot] = useState<GenerationStepsSnapshot | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    try {
      const strategies: Record<string, { id: string; params: Record<string, string> }> = {};
      for (const [issueKind, strategyId] of Object.entries(selectedStrategies)) {
        if (!strategyId) continue;
        strategies[issueKind] = { id: strategyId, params: strategyParams[strategyId] ?? {} };
      }
      const result = generateMazeSteps(seed, {
        tessellation: tessellationConfig,
        checks: selectedChecks,
        strategies,
        initial: initialConfig,
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
  }, [seed, tessellationConfig, initialConfig, selectedChecks, selectedStrategies, strategyParams, setDebugState]);

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
    borderBottom: "1px solid #333",
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 13, fontWeight: "bold", color: "#aaa" },
  closeBtn: { background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 14, padding: "0 2px" },
  btn: {
    background: "#3a6ea8", border: "none", color: "#fff",
    padding: "5px 0", cursor: "pointer", borderRadius: 3, fontSize: 12,
  },
  stepLabel: { fontSize: 11, color: "#aaa" },
  slider: { width: "100%", cursor: "pointer" },
  btnRow: { display: "flex", gap: 4 },
  stepBtn: {
    flex: 1, background: "#444", border: "none", color: "#fff",
    padding: "4px 0", cursor: "pointer", borderRadius: 3, fontSize: 14,
  },
  error: { fontSize: 11, color: "#ff6b6b", background: "#2a1a1a", padding: "4px 6px", borderRadius: 3 },
};
