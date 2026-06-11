import React, { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { PresetConnectionTool } from "../../pixi/presetConnectionsUtils";
import { computeInvalidKeys } from "../../pixi/presetConnectionsUtils";
import { buttonStyle } from "../../styles/shared";
import { colors } from "../../styles/theme";

const ALL_TOOLS: [PresetConnectionTool, string][] = [
  ["wall", "Wall"],
  ["passage", "Passage"],
  ["reset", "Reset"],
  ["one_way", "One-way"],
  ["set_start", "Start"],
  ["set_finish", "Finish"],
];

export function PresetConnectionsFeature() {
  const tool = useMazeStore((s) => s.presetConnectionsTool);
  const setTool = useMazeStore((s) => s.setPresetConnectionsTool);
  const presetConnections = useMazeStore((s) => s.presetConnections);
  const tessellationConfig = useMazeStore((s) => s.tessellationConfig);
  const fieldEditMode = useMazeStore((s) => s.fieldEditMode);
  const fieldPoints = useMazeStore((s) => s.fieldPoints);
  const presetStart = useMazeStore((s) => s.presetStart);
  const presetFinish = useMazeStore((s) => s.presetFinish);
  const setPresetStart = useMazeStore((s) => s.setPresetStart);
  const setPresetFinish = useMazeStore((s) => s.setPresetFinish);
  const clearInvalidPresetConnections = useMazeStore((s) => s.clearInvalidPresetConnections);
  const resetPresetConnections = useMazeStore((s) => s.resetPresetConnections);
  const setHighlightInvalidPresets = useMazeStore((s) => s.setHighlightInvalidPresets);

  const customPts = fieldEditMode === "custom" && fieldPoints.size > 0 ? fieldPoints : undefined;
  const invalidKeys = useMemo(
    () => computeInvalidKeys(presetConnections, tessellationConfig, customPts),
    [presetConnections, tessellationConfig, customPts],
  );
  const hasInvalid = invalidKeys.size > 0;

  return (
    <div style={styles.root}>
      <div style={styles.toolGrid}>
        {ALL_TOOLS.map(([t, label]) => (
          <button
            key={t}
            style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
      </div>
      {(presetStart || presetFinish) && (
        <div style={styles.markerStatus}>
          {presetStart && (
            <span style={styles.markerTag}>
              Start: {presetStart[0]},{presetStart[1]}
              <button style={styles.clearTag} onClick={() => setPresetStart(null)}>×</button>
            </span>
          )}
          {presetFinish && (
            <span style={styles.markerTag}>
              Finish: {presetFinish[0]},{presetFinish[1]}
              <button style={styles.clearTag} onClick={() => setPresetFinish(null)}>×</button>
            </span>
          )}
        </div>
      )}
      {hasInvalid && (
        <button
          style={{ ...buttonStyle("destructive"), width: "100%", marginTop: 4 }}
          onClick={() => clearInvalidPresetConnections()}
          onMouseEnter={() => setHighlightInvalidPresets(true)}
          onMouseLeave={() => setHighlightInvalidPresets(false)}
        >
          Clear invalid ({invalidKeys.size})
        </button>
      )}
      <button
        style={{ ...buttonStyle("destructive"), width: "100%", marginTop: 4 }}
        onClick={() => {
          if (window.confirm("Reset all preset connections?")) resetPresetConnections();
        }}
      >
        Reset all
      </button>
    </div>
  );
}

export function presetConnectionsSubtitle(
  presetConnections: Map<string, unknown>,
  invalidCount: number,
  markerCount: number,
): string {
  const n = presetConnections.size + markerCount;
  if (n === 0) return "No presets";
  const base = `${n} preset${n !== 1 ? "s" : ""}`;
  if (invalidCount > 0) return `${base} · ⚠ ${invalidCount} invalid`;
  return base;
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: 8 },
  toolGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 },
  markerStatus: { display: "flex", flexDirection: "column", gap: 3 },
  markerTag: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: 11,
    color: colors.textDim,
    background: colors.bgInput,
    borderRadius: 3,
    padding: "2px 6px",
  },
  clearTag: {
    background: "none",
    border: "none",
    color: colors.textFaint,
    cursor: "pointer",
    padding: "0 0 0 4px",
    fontSize: 13,
    lineHeight: 1,
  },
};
