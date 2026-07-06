import React, { useMemo, useState } from "react";
import { X } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { PresetConnectionTool } from "../../pixi/fieldEditUtils";
import { computeInvalidKeys, computeInvalidTeleportIds } from "../../pixi/fieldEditUtils";
import { buttonStyle } from "../../styles/shared";
import { ui, typography, muted } from "../../styles/theme";
import { ConfirmModal } from "../ConfirmModal";
import { Switch } from "../Switch";
import * as m from "~/paraglide/messages";

function getEdgeTools(): [PresetConnectionTool, string][] {
  return [
    ["wall", m["preset.wall"]()],
    ["passage", m["preset.passage"]()],
    ["reset", m["preset.reset"]()],
    ["one_way", m["preset.one_way"]()],
  ];
}

function getVertexTools(): [PresetConnectionTool, string][] {
  return [
    ["teleport_two_way", m["preset.teleport_two_way"]()],
    ["teleport_one_way", m["preset.teleport_one_way"]()],
  ];
}

function getStartFinishTools(): [PresetConnectionTool, string][] {
  return [
    ["set_start", m["preset.start"]()],
    ["set_finish", m["preset.finish"]()],
  ];
}

function getGenerationTools(): [PresetConnectionTool, string][] {
  return [
    ["lock_in", m["preset.lock_in"]()],
    ["lock_out", m["preset.lock_out"]()],
    ["full_lock", m["preset.full_lock"]()],
    ["gen_source", m["preset.gen_source"]()],
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
  const presetGenSource = useMazeStore((s) => s.presetGenSource);
  const setPresetStart = useMazeStore((s) => s.setPresetStart);
  const setPresetFinish = useMazeStore((s) => s.setPresetFinish);
  const setPresetGenSource = useMazeStore((s) => s.setPresetGenSource);
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
  const defaultEdgeState = useMazeStore((s) => s.defaultEdgeState);
  const setDefaultEdgeState = useMazeStore((s) => s.setDefaultEdgeState);
  const presetTeleports = useMazeStore((s) => s.presetTeleports);
  const presetTeleportPendingFrom = useMazeStore((s) => s.presetTeleportPendingFrom);
  const setPresetTeleportPendingFrom = useMazeStore((s) => s.setPresetTeleportPendingFrom);

  const [confirmReset, setConfirmReset] = useState(false);

  // Nodes locked both in and out AND with no explicit passage preset are fully isolated
  const isolatedNodes = useMemo(() => {
    const allBothLocked = new Set<string>();
    for (const [key, kind] of lockedNodes) {
      if (kind === "both") allBothLocked.add(key);
    }
    for (const key of autoLockedNodes) {
      allBothLocked.add(key);
    }
    const result: string[] = [];
    for (const key of allBothLocked) {
      const [x, y] = key.split(",").map(Number);
      const hasPassage = Array.from(presetConnections.values()).some(e => {
        if (e.state === "wall" || e.state === "undefined") return false;
        return (e.from[0] === x && e.from[1] === y) || (e.to[0] === x && e.to[1] === y);
      });
      if (!hasPassage) result.push(key);
    }
    return result;
  }, [lockedNodes, autoLockedNodes, presetConnections]);

  const customPts = fieldEditMode === "custom" && fieldPoints.size > 0 ? fieldPoints : undefined;
  const invalidKeys = useMemo(
    () => computeInvalidKeys(presetConnections, tessellationConfig, customPts),
    [presetConnections, tessellationConfig, customPts],
  );
  const invalidTeleportIds = useMemo(
    () => computeInvalidTeleportIds(presetTeleports, tessellationConfig, customPts),
    [presetTeleports, tessellationConfig, customPts],
  );
  const invalidCount = invalidKeys.size + invalidTeleportIds.size;
  const hasInvalid = invalidCount > 0;

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
        <div style={styles.startFinishRow}>
          {getStartFinishTools().map(([t, label]) => (
            <button
              key={t}
              style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
              onClick={() => setTool(t)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <span style={styles.sectionLabel}>{m["preset.generation_tools"]()}</span>
      <div style={styles.generationToolGrid}>
        {getGenerationTools().map(([t, label]) => (
          <button
            key={t}
            style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
      </div>

      <span style={styles.sectionLabel}>{m["preset.default_edge"]()}</span>
      <div style={styles.triGrid}>
        {(["undefined", "wall", "passage"] as const).map((s) => (
          <button
            key={s}
            style={buttonStyle(defaultEdgeState === s ? "toggle-active" : "toggle")}
            onClick={() => setDefaultEdgeState(s)}
          >
            {m[`preset.default_${s}` as "preset.default_undefined" | "preset.default_wall" | "preset.default_passage"]()}
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

      {(lockedNodes.size > 0 || isolatedNodes.length > 0 || presetStart || presetFinish || presetGenSource || presetTeleports.length > 0 || presetTeleportPendingFrom) && (
        <div style={styles.statusBlock}>
          {presetTeleportPendingFrom && (
            <div style={styles.statusBubble}>
              <span>{m["preset.teleport_pending"]()}: {presetTeleportPendingFrom[0]},{presetTeleportPendingFrom[1]}</span>
              <button style={styles.clearTag} onClick={() => setPresetTeleportPendingFrom(null)}><X size={16} /></button>
            </div>
          )}
          {presetTeleports.length > 0 && (
            <div style={styles.statusBubble}>
              <span>{presetTeleports.length === 1
                ? m["preset.teleports_count"]({ count: presetTeleports.length })
                : m["preset.teleports_count_plural"]({ count: presetTeleports.length })}</span>
            </div>
          )}
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
              <button style={styles.clearTag} onClick={() => setPresetStart(null)}><X size={16} /></button>
            </div>
          )}
          {presetFinish && (
            <div style={styles.statusBubble}>
              <span>{m["preset.finish"]()}: {presetFinish[0]},{presetFinish[1]}</span>
              <button style={styles.clearTag} onClick={() => setPresetFinish(null)}><X size={16} /></button>
            </div>
          )}
          {presetGenSource && (
            <div style={styles.statusBubble}>
              <span>{m["preset.gen_source"]()}: {presetGenSource[0]},{presetGenSource[1]}</span>
              <button style={styles.clearTag} onClick={() => setPresetGenSource(null)}><X size={16} /></button>
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
          {m["preset.clear_invalid"]({ count: invalidCount })}
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
    ...typography.body,
    marginTop: 8,
  },
  toolGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 },
  vertexToolGrid: { display: "grid", gridTemplateColumns: "1fr", gap: 4 },
  startFinishRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 },
  generationToolGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 },
  triGrid: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 },
  statusBlock: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  statusBubble: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    ...typography.caption,
    background: ui.bg.input,
    borderRadius: 4,
    padding: "6px 8px",
  },
  warningBubble: {
    ...typography.body,
    color: ui.text.warning,
    cursor: "default",
    background: ui.bg.input,
    borderRadius: 4,
    padding: "4px 6px",
  },
  autoLockRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    ...typography.caption,
  },
  autoLockLeft: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  autoLockLabel: {
    ...muted(typography.body),
  },
  autoLockCount: {
    ...typography.caption,
    background: ui.bg.input,
    borderRadius: 3,
    padding: "1px 5px",
  },
  originRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    ...typography.caption,
  },
  originLabel: {
    ...muted(typography.body),
  },
  clearTag: {
    ...muted(typography.icon),
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "0 0 0 4px",
    lineHeight: 1,
    display: "flex",
  },
};
