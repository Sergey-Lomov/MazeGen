import React, { useMemo, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { PresetConnectionTool } from "../../pixi/fieldEditUtils";
import { computeInvalidKeys, computeInvalidTeleportIds, computeInvalidVerticalPassageIds, computeInvalidElevatorIds, computeInvalidMarkers, computeInvalidSplitPoints, presetConnectionsOnLevel, mapOnLevel, setOnLevel } from "../../pixi/fieldEditUtils";
import { computeOrphanSplitPoints } from "../../pixi/selectors/presetSelectors";
import { presetEndpointLevelLabel, type PresetEndpoint } from "../../pixi/presetEndpoint";
import { resolveFieldAtOf, activeFloorLevel } from "../../store/storeHelpers";
import { buttonStyle } from "../../styles/shared";
import { ui, typography, muted, spacing } from "../../styles/theme";
import { darken } from "../../styles/palette";
import { ConfirmModal } from "../ConfirmModal";
import { SectionHeader } from "../SectionHeader";
import { Switch } from "../Switch";
import { Stack, Grid } from "../Layout";
import { StatusTag } from "../StatusTag";
import { WarningBubble } from "../WarningBubble";
import { FloorBadgeRow } from "../FloorBadgeRow";
import { notificationPalette } from "../EmbeddedNotification";
import { PresetSplitNodesDialog } from "./PresetSplitNodesDialog";
import { PresetElevatorFloorDialog } from "../dialogs/PresetElevatorFloorDialog";
import { PresetVerticalDirectionDialog } from "../dialogs/PresetVerticalDirectionDialog";
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

function getVerticalTools(): [PresetConnectionTool, string][] {
  return [
    ["vertical_passage_two_way", m["preset.vertical_passage_two_way"]()],
    ["vertical_passage_one_way", m["preset.vertical_passage_one_way"]()],
    ["elevator", m["preset.elevator"]()],
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
  const presetStart = useMazeStore((s) => s.presetStart);
  const presetFinish = useMazeStore((s) => s.presetFinish);
  const presetGenSource = useMazeStore((s) => s.presetGenSource);
  const setPresetGenSource = useMazeStore((s) => s.setPresetGenSource);
  const clearInvalidPresetConnections = useMazeStore((s) => s.clearInvalidPresetConnections);
  const resetPresetConnections = useMazeStore((s) => s.resetPresetConnections);
  const setHighlightInvalidPresets = useMazeStore((s) => s.setHighlightInvalidPresets);
  const lockedNodes = useMazeStore((s) => s.lockedNodes);
  const clearLockedNodes = useMazeStore((s) => s.clearLockedNodes);
  const setHighlightIsolatedNodes = useMazeStore((s) => s.setHighlightIsolatedNodes);
  const setHighlightOrphanSplitNodes = useMazeStore((s) => s.setHighlightOrphanSplitNodes);
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
  const presetVerticalPassages = useMazeStore((s) => s.presetVerticalPassages);
  const presetVerticalPassagePending = useMazeStore((s) => s.presetVerticalPassagePending);
  const cancelPresetVerticalPassagePlacement = useMazeStore((s) => s.cancelPresetVerticalPassagePlacement);
  const presetElevators = useMazeStore((s) => s.presetElevators);
  const presetElevatorPending = useMazeStore((s) => s.presetElevatorPending);
  const cancelPresetElevatorPlacement = useMazeStore((s) => s.cancelPresetElevatorPlacement);
  const presetSplitPoints = useMazeStore((s) => s.presetSplitPoints);
  const presetFocusedPoint = useMazeStore((s) => s.presetFocusedPoint);
  const setPresetFocusedPoint = useMazeStore((s) => s.setPresetFocusedPoint);
  const floors = useMazeStore((s) => s.floors);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  const floorFields = useMazeStore((s) => s.floorFields);
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const hexOrientation = useMazeStore((s) => s.hexOrientation);
  const triOrientation = useMazeStore((s) => s.triOrientation);
  const presetSectionsExpanded = useMazeStore((s) => s.presetSectionsExpanded);
  const setPresetSectionExpanded = useMazeStore((s) => s.setPresetSectionExpanded);

  const [confirmReset, setConfirmReset] = useState(false);

  // Nodes locked both in and out AND with no explicit passage preset are fully isolated. Scoped
  // to the active floor (GitHub issue #340 follow-up) — mixing keys across floors here previously
  // parsed a level-suffixed key ("x,y@2") as garbage coordinates via a bare `key.split(",")`, so
  // this warning (and its hover highlight) only ever worked correctly on floor 0.
  const isolatedNodes = useMemo(() => {
    const level = activeFloorLevel({ floors, activeFloorId });
    const lockedNodesOnLevel = mapOnLevel(lockedNodes, level);
    const autoLockedNodesOnLevel = setOnLevel(autoLockedNodes, level);
    const presetConnectionsOnActiveLevel = presetConnectionsOnLevel(presetConnections, level);
    const allBothLocked = new Set<string>();
    for (const [key, kind] of lockedNodesOnLevel) {
      if (kind === "both") allBothLocked.add(key);
    }
    for (const key of autoLockedNodesOnLevel) {
      allBothLocked.add(key);
    }
    const result: string[] = [];
    for (const key of allBothLocked) {
      const [x, y] = key.split(",").map(Number);
      const hasPassage = Array.from(presetConnectionsOnActiveLevel.values()).some(e => {
        if (e.state === "wall" || e.state === "undefined") return false;
        return (e.from.point[0] === x && e.from.point[1] === y) || (e.to.point[0] === x && e.to.point[1] === y);
      });
      if (!hasPassage) result.push(key);
    }
    return result;
  }, [lockedNodes, autoLockedNodes, presetConnections, floors, activeFloorId]);

  // Orphan split nodes: declared in presetSplitPoints but referenced by nothing (GitHub issue
  // #231) — created regardless, but likely forgotten by the user, so surfaced as a warning (same
  // style as isolatedNodes above), not blocking generation. Computed across every floor (not just
  // the active one) — `presetEndpointIsSplit` is deliberately level-agnostic (point+slot only, see
  // its own doc comment), so a point's orphan status doesn't depend on which floor is active. The
  // hover highlight (GitHub issue #420) only lights up the active floor's own orphan cells
  // (`buildOrphanSplitCellHighlights`, wired in `PresetConnectionsRenderer`), same convention as
  // `isolatedNodes` above — the floor badges below are what surfaces "this also exists elsewhere".
  const orphanPoints = useMemo(
    () => computeOrphanSplitPoints(presetSplitPoints, presetConnections, presetTeleports, presetStart, presetFinish, presetGenSource),
    [presetSplitPoints, presetConnections, presetTeleports, presetStart, presetFinish, presetGenSource],
  );
  const orphanSplitCount = orphanPoints.length;

  const resolveFieldAt = useMemo(
    () => resolveFieldAtOf({ floors, floorFields, tessellationKind, hexOrientation, triOrientation }),
    [floors, floorFields, tessellationKind, hexOrientation, triOrientation],
  );
  const invalidKeys = useMemo(
    () => computeInvalidKeys(presetConnections, resolveFieldAt),
    [presetConnections, resolveFieldAt],
  );
  const invalidTeleportIds = useMemo(
    () => computeInvalidTeleportIds(presetTeleports, resolveFieldAt),
    [presetTeleports, resolveFieldAt],
  );
  const invalidVerticalPassageIds = useMemo(
    () => computeInvalidVerticalPassageIds(presetVerticalPassages, resolveFieldAt),
    [presetVerticalPassages, resolveFieldAt],
  );
  const invalidElevatorIds = useMemo(
    () => computeInvalidElevatorIds(presetElevators, resolveFieldAt),
    [presetElevators, resolveFieldAt],
  );
  const invalidMarkers = useMemo(
    () => computeInvalidMarkers(presetStart, presetFinish, resolveFieldAt),
    [presetStart, presetFinish, resolveFieldAt],
  );
  const invalidSplitKeys = useMemo(
    () => computeInvalidSplitPoints(presetSplitPoints, resolveFieldAt),
    [presetSplitPoints, resolveFieldAt],
  );
  const invalidMarkerCount = (invalidMarkers.start ? 1 : 0) + (invalidMarkers.finish ? 1 : 0);
  const invalidCount = invalidKeys.size + invalidTeleportIds.size + invalidVerticalPassageIds.size + invalidElevatorIds.size + invalidMarkerCount + invalidSplitKeys.size;
  const hasInvalid = invalidCount > 0;

  return (
    <Stack gap="groupGap">
      {(isolatedNodes.length > 0 || orphanSplitCount > 0) && (
        <>
          <SectionHeader
            label={m["preset.problems"]()}
            expanded={presetSectionsExpanded["problems"] ?? true}
            onToggle={() => setPresetSectionExpanded("problems", !(presetSectionsExpanded["problems"] ?? true))}
          />
          {(presetSectionsExpanded["problems"] ?? true) && (
            <Stack gap="itemGap">
              {isolatedNodes.length > 0 && (
                <WarningBubble
                  message={isolatedNodes.length === 1
                    ? m["preset.nodes_isolated"]({ count: isolatedNodes.length })
                    : m["preset.nodes_isolated_plural"]({ count: isolatedNodes.length })}
                  onMouseEnter={() => setHighlightIsolatedNodes(true)}
                  onMouseLeave={() => setHighlightIsolatedNodes(false)}
                />
              )}
              {orphanSplitCount > 0 && (
                <WarningBubble
                  message={orphanSplitCount === 1
                    ? m["preset.split_orphan"]({ count: orphanSplitCount })
                    : m["preset.split_orphan_plural"]({ count: orphanSplitCount })}
                  onMouseEnter={() => setHighlightOrphanSplitNodes(true)}
                  onMouseLeave={() => setHighlightOrphanSplitNodes(false)}
                >
                  <OrphanSplitFloorBadges orphanPoints={orphanPoints} />
                </WarningBubble>
              )}
            </Stack>
          )}
          <div style={styles.divider} />
        </>
      )}

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
        {floors.length > 1 && getVerticalTools().map(([t, label]) => (
          <button
            key={t}
            className={tool === t ? "hoverable-accent" : "hoverable"}
            style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
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

      {(presetGenSource || presetTeleportPendingFrom) && (
        <Stack gap="itemGap">
          {presetTeleportPendingFrom && (
            <StatusTag onClear={() => setPresetTeleportPendingFrom(null)}>
              {m["preset.teleport_pending"]()}: {presetEndpointLevelLabel(presetTeleportPendingFrom, floors.length > 1)}{presetTeleportPendingFrom.point[0]},{presetTeleportPendingFrom.point[1]}
            </StatusTag>
          )}
          {presetGenSource && (
            <StatusTag onClear={() => setPresetGenSource(null)}>
              {m["preset.gen_source"]()}: {presetEndpointLevelLabel(presetGenSource, floors.length > 1)}{presetGenSource.point[0]},{presetGenSource.point[1]}
            </StatusTag>
          )}
        </Stack>
      )}

      {presetElevatorPending && (
        <PresetElevatorFloorDialog onClose={cancelPresetElevatorPlacement} />
      )}

      {presetVerticalPassagePending && (
        <PresetVerticalDirectionDialog onClose={cancelPresetVerticalPassagePlacement} />
      )}

      <span style={styles.sectionLabel}>{m["preset.control"]()}</span>
      <Stack gap="itemGap">
        <button
          className={tool === "clear" ? "hoverable-danger" : "hoverable"}
          style={buttonStyle(tool === "clear" ? "toggle-danger-active" : "toggle-danger")}
          onClick={() => setTool("clear")}
        >
          {m["preset.clear_tool"]()}
        </button>
        <button
          className={lockedNodes.size === 0 ? undefined : "hoverable-danger"}
          style={{ ...buttonStyle("destructive"), width: "100%", ...(lockedNodes.size === 0 ? styles.controlBtnDisabled : {}) }}
          disabled={lockedNodes.size === 0}
          onClick={clearLockedNodes}
        >
          {m["preset.reset_locks"]()}
        </button>
        <button
          className={hasInvalid ? "hoverable-danger" : undefined}
          style={{ ...buttonStyle("destructive"), width: "100%", ...(hasInvalid ? {} : styles.controlBtnDisabled) }}
          disabled={!hasInvalid}
          onClick={() => clearInvalidPresetConnections()}
          onMouseEnter={() => setHighlightInvalidPresets(true)}
          onMouseLeave={() => setHighlightInvalidPresets(false)}
        >
          {m["preset.clear_invalid"]({ count: invalidCount })}
        </button>
        <button
          className="hoverable-danger"
          style={{ ...buttonStyle("destructive"), width: "100%" }}
          onClick={() => setConfirmReset(true)}
        >
          {m["common.reset_all"]()}
        </button>
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
      </Stack>
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


/** Row of solid `L{n}` badges for the orphan-split-node warning bubble (GitHub issue #420) —
 *  preset-stage counterpart of `IssuesBlock`'s `IssueFloorBadges`, but keyed directly off each
 *  orphan point's own `level` instead of resolving through generated `NodeId`s (presets run before
 *  generation, so there's no node snapshot to look levels up in). */
function OrphanSplitFloorBadges({ orphanPoints }: { orphanPoints: PresetEndpoint[] }) {
  const palette = notificationPalette("warning");
  const levels = Array.from(new Set(orphanPoints.map((ep) => ep.level ?? 0))).sort((a, b) => a - b);
  return <FloorBadgeRow levels={levels} bg={darken(palette.text, 0.2)} text={palette.bg} />;
}

const styles: Record<string, React.CSSProperties> = {
  sectionLabel: {
    ...typography.body,
    marginTop: spacing.groupGap,
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
  controlBtnDisabled: {
    opacity: 0.25,
    cursor: "default",
  },
  originLabel: {
    ...muted(typography.body),
  },
  divider: {
    borderTop: `1px solid`,
    borderColor: ui.border.default,
    margin: `${spacing.itemGap}px 0`,
  },
};
