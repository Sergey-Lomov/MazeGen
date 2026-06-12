import React from "react";
import { useMazeStore } from "../store/mazeStore";
import { colors, font } from "../styles/theme";

export function GenerationDebugBar() {
  const debugSnapshot = useMazeStore((s) => s.debugSnapshot);
  const debugStep = useMazeStore((s) => s.debugStep);
  const debugStale = useMazeStore((s) => s.debugStale);
  const setDebugStep = useMazeStore((s) => s.setDebugStep);
  const setDebugMode = useMazeStore((s) => s.setDebugMode);

  if (!debugSnapshot) return null;

  const total = debugSnapshot.steps.length;
  const currentEdges = debugSnapshot.steps[debugStep]?.edges.length ?? 0;

  function handleClose() {
    setDebugMode(false);
  }

  return (
    <>
    {debugStale && (
      <div style={styles.staleAlert}>Debug snapshot is outdated — re-generate to update</div>
    )}
    <div style={styles.bar}>
      <span style={styles.label}>
        Step {debugStep + 1} / {total} ({currentEdges} edges)
      </span>
      <button
        style={styles.stepBtn}
        disabled={debugStep <= 0}
        onClick={() => setDebugStep(debugStep - 1)}
        title="Previous step"
      >
        ◀
      </button>
      <input
        type="range"
        className="maze-slider"
        style={styles.slider}
        min={0}
        max={Math.max(0, total - 1)}
        value={debugStep}
        onChange={(e) => setDebugStep(Number(e.target.value))}
      />
      <button
        style={styles.stepBtn}
        disabled={debugStep >= total - 1}
        onClick={() => setDebugStep(debugStep + 1)}
        title="Next step"
      >
        ▶
      </button>
      <button style={styles.closeBtn} onClick={handleClose} title="Exit debug mode">
        ×
      </button>
    </div>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 12px",
    background: colors.bgPanelAlt,
    borderBottom: `1px solid ${colors.borderMid}`,
    flexShrink: 0,
  },
  label: {
    fontSize: font.sm,
    color: colors.textMuted,
    whiteSpace: "nowrap" as const,
    minWidth: 140,
  },
  stepBtn: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textMuted,
    cursor: "pointer",
    padding: "2px 8px",
    fontSize: font.md,
    flexShrink: 0,
  },
  slider: {
    flex: 1,
  },
  staleAlert: {
    background: "#3a1010",
    color: "#ff6b6b",
    fontSize: font.sm,
    padding: "4px 12px",
    flexShrink: 0,
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: colors.textDim,
    cursor: "pointer",
    fontSize: font.xl,
    padding: "0 4px",
    flexShrink: 0,
    lineHeight: 1,
  },
};
