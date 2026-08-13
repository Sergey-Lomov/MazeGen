import React, { useMemo, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { PresetConnectionTool } from "../../pixi/fieldEditUtils";
import { computeInvalidKeys, computeInvalidTeleportIds, computeInvalidMarkers, computeInvalidSplitPoints } from "../../pixi/fieldEditUtils";
import { presetEndpointIsSplit } from "../../pixi/presetEndpoint";
import { buttonStyle } from "../../styles/shared";
import { ui, typography, muted, spacing } from "../../styles/theme";
import { ConfirmModal } from "../ConfirmModal";
import { Switch } from "../Switch";
import { Stack, Grid } from "../Layout";
import { StatusTag } from "../StatusTag";
import { PresetSplitNodesDialog } from "./PresetSplitNodesDialog";
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
  const tessellationConfig = useMazeStore((s) => s.floorFields[s.activeFloorId].tessellationConfig);
  const fieldEditMode = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldEditMode);
  const fieldPoints = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPoints);
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
  const presetSplitPoints = useMazeStore((s) => s.presetSplitPoints);
  const presetFocusedPoint = useMazeStore((s) => s.presetFocusedPoint);
  const setPresetFocusedPoint = useMazeStore((s) => s.setPresetFocusedPoint);

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
        return (e.from.point[0] === x && e.from.point[1] === y) || (e.to.point[0] === x && e.to.point[1] === y);
      });
      if (!hasPassage) result.push(key);
    }
    return result;
  }, [lockedNodes, autoLockedNodes, presetConnections]);

  // Orphan split nodes: declared in presetSplitPoints but referenced by nothing (GitHub issue
  // #231) — created regardless, but likely forgotten by the user, so surfaced as a warning
  // (same style as isolatedNodes above), not blocking generation.
  const orphanSplitCount = useMemo(() => {
    let count = 0;
    for (const [key, slots] of Object.entries(presetSplitPoints)) {
      const [x, y] = key.split(",").map(Number);
      for (const slotId of slots) {
        const target = { point: [x, y] as [number, number], slotId };
        const referenced =
          Array.from(presetConnections.values()).some(e => presetEndpointIsSplit(e.from, target) || presetEndpointIsSplit(e.to, target))
          || presetTeleports.some(t => presetEndpointIsSplit(t.from, target) || presetEndpointIsSplit(t.to, target))
          || (presetStart && presetEndpointIsSplit(presetStart, target))
          || (presetFinish && presetEndpointIsSplit(presetFinish, target))
          || (presetGenSource && presetEndpointIsSplit(presetGenSource, target));
        if (!referenced) count++;
      }
    }
    return count;
  }, [presetSplitPoints, presetConnections, presetTeleports, presetStart, presetFinish, presetGenSource]);

  const customPts = fieldEditMode === "custom" && fieldPoints.size > 0 ? fieldPoints : undefined;
  const invalidKeys = useMemo(
    () => computeInvalidKeys(presetConnections, tessellationConfig, customPts),
    [presetConnections, tessellationConfig, customPts],
  );
  const invalidTeleportIds = useMemo(
    () => computeInvalidTeleportIds(presetTeleports, tessellationConfig, customPts),
    [presetTeleports, tessellationConfig, customPts],
  );
  const invalidMarkers = useMemo(
    () => computeInvalidMarkers(presetStart, presetFinish, tessellationConfig, customPts),
    [presetStart, presetFinish, tessellationConfig, customPts],
  );
  const invalidSplitKeys = useMemo(
    () => computeInvalidSplitPoints(presetSplitPoints, tessellationConfig, customPts),
    [presetSplitPoints, tessellationConfig, customPts],
  );
  const invalidMarkerCount = (invalidMarkers.start ? 1 : 0) + (invalidMarkers.finish ? 1 : 0);
  const invalidCount = invalidKeys.size + invalidTeleportIds.size + invalidMarkerCount + invalidSplitKeys.size;
  const hasInvalid = invalidCount > 0;

  return (
    <Stack gap="groupGap">
      <span style={styles.sectionLabel}>{m["preset.edges_tools"]()}</span>
      <Grid templateColumns="1fr 1fr" gap="itemGap">
        {getEdgeTools().map(([t, label]) => (
          <button
            key={t}
            className={tool === t ? "hoverable-accent" : "hoverable"}
            style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
      </Grid>

      <span style={styles.sectionLabel}>{m["preset.vertex_tools"]()}</span>
      <Stack gap="itemGap">
        {getVertexTools().map(([t, label]) => (
          <button
            key={t}
            className={tool === t ? "hoverable-accent" : "hoverable"}
            style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
        <Grid templateColumns="1fr 1fr" gap="itemGap">
          {getStartFinishTools().map(([t, label]) => (
            <button
              key={t}
              className={tool === t ? "hoverable-accent" : "hoverable"}
              style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
              onClick={() => setTool(t)}
            >
              {label}
            </button>
          ))}
        </Grid>
        <button
          className={tool === "manage_split_nodes" ? "hoverable-accent" : "hoverable"}
          style={buttonStyle(tool === "manage_split_nodes" ? "toggle-active" : "toggle")}
          onClick={() => setTool("manage_split_nodes")}
        >
          {m["post_edit.manage_split_nodes_tool"]()}
        </button>
      </Stack>

      <span style={styles.sectionLabel}>{m["preset.generation_tools"]()}</span>
      <Grid templateColumns="1fr 1fr" gap="itemGap">
        {getGenerationTools().map(([t, label]) => (
          <button
            key={t}
            className={tool === t ? "hoverable-accent" : "hoverable"}
            style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
      </Grid>

      <span style={styles.sectionLabel}>{m["preset.default_edge"]()}</span>
      <Grid templateColumns="1fr 1fr 1fr" gap="itemGap">
        {(["undefined", "wall", "passage"] as const).map((s) => (
          <button
            key={s}
            className={defaultEdgeState === s ? "hoverable-accent" : "hoverable"}
            style={buttonStyle(defaultEdgeState === s ? "toggle-active" : "toggle")}
            onClick={() => setDefaultEdgeState(s)}
          >
            {m[`preset.default_${s}` as "preset.default_undefined" | "preset.default_wall" | "preset.default_passage"]()}
          </button>
        ))}
      </Grid>

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

      {(lockedNodes.size > 0 || isolatedNodes.length > 0 || presetStart || presetFinish || presetGenSource || presetTeleports.length > 0 || presetTeleportPendingFrom || orphanSplitCount > 0) && (
        <Stack gap="itemGap">
          {presetTeleportPendingFrom && (
            <StatusTag onClear={() => setPresetTeleportPendingFrom(null)}>
              {m["preset.teleport_pending"]()}: {presetTeleportPendingFrom[0]},{presetTeleportPendingFrom[1]}
            </StatusTag>
          )}
          {presetTeleports.length > 0 && (
            <StatusTag>
              {presetTeleports.length === 1
                ? m["preset.teleports_count"]({ count: presetTeleports.length })
                : m["preset.teleports_count_plural"]({ count: presetTeleports.length })}
            </StatusTag>
          )}
          {lockedNodes.size > 0 && (
            <StatusTag onClear={clearLockedNodes} clearLabel={m["common.clear_all"]()}>
              {lockedNodes.size === 1
                ? m["preset.nodes_locked"]({ count: lockedNodes.size })
                : m["preset.nodes_locked_plural"]({ count: lockedNodes.size })}
            </StatusTag>
          )}
          {presetStart && (
            <StatusTag onClear={() => setPresetStart(null)}>
              {m["preset.start"]()}: {presetStart.point[0]},{presetStart.point[1]}
            </StatusTag>
          )}
          {presetFinish && (
            <StatusTag onClear={() => setPresetFinish(null)}>
              {m["preset.finish"]()}: {presetFinish.point[0]},{presetFinish.point[1]}
            </StatusTag>
          )}
          {presetGenSource && (
            <StatusTag onClear={() => setPresetGenSource(null)}>
              {m["preset.gen_source"]()}: {presetGenSource.point[0]},{presetGenSource.point[1]}
            </StatusTag>
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
          {orphanSplitCount > 0 && (
            <div style={styles.warningBubble} title="Split node declared but not referenced by any preset, teleport, or marker">
              ⚠ {orphanSplitCount === 1
                ? m["preset.split_orphan"]({ count: orphanSplitCount })
                : m["preset.split_orphan_plural"]({ count: orphanSplitCount })}
            </div>
          )}
        </Stack>
      )}

      {hasInvalid && (
        <button
          className="hoverable-danger"
          style={{ ...buttonStyle("destructive"), width: "100%" }}
          onClick={() => clearInvalidPresetConnections()}
          onMouseEnter={() => setHighlightInvalidPresets(true)}
          onMouseLeave={() => setHighlightInvalidPresets(false)}
        >
          {m["preset.clear_invalid"]({ count: invalidCount })}
        </button>
      )}
      <button
        className="hoverable-danger"
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

      {presetFocusedPoint && (
        <PresetSplitNodesDialog
          point={presetFocusedPoint}
          onClose={() => setPresetFocusedPoint(null)}
        />
      )}
    </Stack>
  );
}


const styles: Record<string, React.CSSProperties> = {
  sectionLabel: {
    ...typography.body,
    marginTop: spacing.groupGap,
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
    gap: spacing.itemGap,
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
};
