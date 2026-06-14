import React, { useMemo, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { PresetConnectionTool } from "../../pixi/presetConnectionsUtils";
import { computeInvalidKeys } from "../../pixi/presetConnectionsUtils";
import { buttonStyle } from "../../styles/shared";
import { colors, font } from "../../styles/theme";
import { ConfirmModal } from "../ConfirmModal";
import { Switch } from "../Switch";
import * as m from "~/paraglide/messages";

function getEdgeTools(): [PresetConnectionTool, string][] {
  return [
    ["wall", m["preset.wall"]()],
    ["passage", m["preset.passage"]()],
    ["reset", m["preset.reset"]()],
    ["one_way", m["preset.one_way"]()],
    ["set_start", m["preset.start"]()],
    ["set_finish", m["preset.finish"]()],
  ];
}

function getVertexTools(): [PresetConnectionTool, string][] {
  return [
    ["lock_in", m["preset.lock_in"]()],
    ["lock_out", m["preset.lock_out"]()],
    ["lock_both", m["preset.lock_both"]()],
  ];
}

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
  const lockedNodes = useMazeStore((s) => s.lockedNodes);
  const clearLockedNodes = useMazeStore((s) => s.clearLockedNodes);
  const setHighlightIsolatedNodes = useMazeStore((s) => s.setHighlightIsolatedNodes);
  const showPresetOrigin = useMazeStore((s) => s.showPresetOrigin);
  const setShowPresetOrigin = useMazeStore((s) => s.setShowPresetOrigin);
  const autoLock = useMazeStore((s) => s.autoLock);
  const setAutoLock = useMazeStore((s) => s.setAutoLock);
  const autoLockedNodes = useMazeStore((s) => s.autoLockedNodes);

  const [confirmReset, setConfirmReset] = useState(false);

  // Nodes locked both in and out AND with no explicit passage preset are fully isolated
  const isolatedNodes = useMemo(() => {
    const result: string[] = [];
    for (const [key, kind] of lockedNodes) {
      if (kind !== "both") continue;
      const [x, y] = key.split(",").map(Number);
      const hasPassage = Array.from(presetConnections.values()).some(e => {
        if (e.state === "wall") return false;
        return (e.from[0] === x && e.from[1] === y) || (e.to[0] === x && e.to[1] === y);
      });
      if (!hasPassage) result.push(key);
    }
    return result;
  }, [lockedNodes, presetConnections]);

  const customPts = fieldEditMode === "custom" && fieldPoints.size > 0 ? fieldPoints : undefined;
  const invalidKeys = useMemo(
    () => computeInvalidKeys(presetConnections, tessellationConfig, customPts),
    [presetConnections, tessellationConfig, customPts],
  );
  const hasInvalid = invalidKeys.size > 0;

  return (
    <div style={styles.root}>
      <span style={styles.sectionLabel}>{m["preset.edges_tools"]()}</span>
      <div style={styles.toolGrid}>
        {getEdgeTools().map(([t, label]) => (
          <button
            key={t}
            style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
      </div>
      <span style={styles.sectionLabel}>{m["preset.vertex_tools"]()}</span>
      <div style={styles.vertexToolGrid}>
        {getVertexTools().map(([t, label]) => (
          <button
            key={t}
            style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={styles.autoLockRow}>
        <div style={styles.autoLockLeft}>
          <span style={styles.autoLockLabel}>{m["preset.auto_lock"]()}</span>
          {autoLock && autoLockedNodes.size > 0 && (
            <span style={styles.autoLockCount}>{autoLockedNodes.size}</span>
          )}
        </div>
        <Switch checked={autoLock} onChange={setAutoLock} />
      </div>
      <div style={styles.originRow}>
        <span style={styles.originLabel}>{m["preset.show_origin"]()}</span>
        <Switch checked={showPresetOrigin} onChange={setShowPresetOrigin} />
      </div>
      {(lockedNodes.size > 0 || isolatedNodes.length > 0 || presetStart || presetFinish) && (
        <div style={styles.statusBlock}>
          {lockedNodes.size > 0 && (
            <div style={styles.statusBubble}>
              <span>{lockedNodes.size === 1
                ? m["preset.nodes_locked"]({ count: lockedNodes.size })
                : m["preset.nodes_locked_plural"]({ count: lockedNodes.size })}</span>
              <button style={styles.clearTag} onClick={clearLockedNodes}>{m["common.clear_all"]()}</button>
            </div>
          )}
          {presetStart && (
            <div style={styles.statusBubble}>
              <span>{m["preset.start"]()}: {presetStart[0]},{presetStart[1]}</span>
              <button style={styles.clearTag} onClick={() => setPresetStart(null)}>×</button>
            </div>
          )}
          {presetFinish && (
            <div style={styles.statusBubble}>
              <span>{m["preset.finish"]()}: {presetFinish[0]},{presetFinish[1]}</span>
              <button style={styles.clearTag} onClick={() => setPresetFinish(null)}>×</button>
            </div>
          )}
          {isolatedNodes.length > 0 && (
            <div
              style={styles.warningBubble}
              title={`Nodes locked both in and out will be fully isolated (unreachable): ${isolatedNodes.join(", ")}`}
              onMouseEnter={() => setHighlightIsolatedNodes(true)}
              onMouseLeave={() => setHighlightIsolatedNodes(false)}
            >
              ⚠ {isolatedNodes.length === 1
                ? m["preset.nodes_isolated"]({ count: isolatedNodes.length })
                : m["preset.nodes_isolated_plural"]({ count: isolatedNodes.length })}
            </div>
          )}
        </div>
      )}

      {hasInvalid && (
        <button
          style={{ ...buttonStyle("destructive"), width: "100%" }}
          onClick={() => clearInvalidPresetConnections()}
          onMouseEnter={() => setHighlightInvalidPresets(true)}
          onMouseLeave={() => setHighlightInvalidPresets(false)}
        >
          {m["preset.clear_invalid"]({ count: invalidKeys.size })}
        </button>
      )}
      <button
        style={{ ...buttonStyle("destructive"), width: "100%" }}
        onClick={() => setConfirmReset(true)}
      >
        {m["common.reset_all"]()}
      </button>
      {confirmReset && (
        <ConfirmModal
          message={m["common.reset_all"]() + "?"}
          onConfirm={() => { resetPresetConnections(); setConfirmReset(false); }}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}


const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: 8 },
  sectionLabel: {
    fontSize: font.sm,
    color: colors.textVeryDim,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  toolGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 },
  vertexToolGrid: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 },
  statusBlock: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  statusBubble: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: font.sm,
    color: colors.textDim,
    background: colors.bgInput,
    borderRadius: 4,
    padding: "4px 6px",
  },
  warningBubble: {
    fontSize: font.sm,
    color: "#ffaa33",
    cursor: "default",
    background: colors.bgInput,
    borderRadius: 4,
    padding: "4px 6px",
  },
  autoLockRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: font.sm,
    color: colors.textDim,
  },
  autoLockLeft: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  autoLockLabel: {
    fontSize: font.sm,
    color: colors.textMuted,
  },
  autoLockCount: {
    fontSize: 10,
    color: colors.textVeryDim,
    background: colors.bgInput,
    borderRadius: 3,
    padding: "1px 5px",
  },
  originRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: font.sm,
    color: colors.textDim,
  },
  originLabel: {
    fontSize: font.sm,
    color: colors.textMuted,
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

