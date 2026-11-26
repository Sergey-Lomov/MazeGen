import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { canvas } from "../../domain/colorTokens";
import { isPresetLockTool } from "../../store/storeTypes";
import type { PresetConnectionTool } from "../../domain/fieldEditUtils";
import { computeInvalidKeys, computeInvalidPresetEndpointKeys, listedInvalidConnections } from "../../domain/fieldValidity";
import { computeIsolatedNodeKeys } from "../../pixi/selectors/presetSelectors";
import { computePresetInvalidElementCount, computePresetSplitProblemsOf, countPresetSplitProblems, presetWarningCount, type PresetWarningInput } from "../../pixi/selectors/presetWarnings";
import { presetEndpoint, presetEndpointFromKey, presetEndpointKey, type PresetEndpoint } from "../../domain/presetEndpoint";
import { resolveFieldAtOf, activeFloorLevel } from "../../store/storeHelpers";
import { Button } from "../Button";
import { ToolIconRow } from "../ToolIconRow";
import { ui, typography, muted, spacing, indent } from "../../styles/theme";
import { ConfirmModal } from "../ConfirmModal";
import { SectionHeader } from "../SectionHeader";
import { Switch } from "../Switch";
import { BackgroundImageToggle } from "../BackgroundImageToggle";
import { Stack, Grid } from "../Layout";
import { CoordinateWarningBubble } from "../CoordinateWarningBubble";
import { useCoordinateWarningHover } from "../useCoordinateWarningHover";
import type { CoordinateWarning } from "../../domain/coordinateWarning";
import { PresetSplitNodesDialog } from "./PresetSplitNodesDialog";
import { PresetElevatorFloorDialog } from "../dialogs/PresetElevatorFloorDialog";
import { PresetVerticalDirectionDialog } from "../dialogs/PresetVerticalDirectionDialog";
import { PresetSplitTargetDialog } from "../dialogs/PresetSplitTargetDialog";
import { PresetEntityDeleteDialog } from "../dialogs/PresetEntityDeleteDialog";
import { PresetEntityPickDialog } from "../dialogs/PresetEntityPickDialog";
import { PresetConnectionSettingsDialog } from "../dialogs/PresetConnectionSettingsDialog";
import { PresetLockSettingsDialog } from "../dialogs/PresetLockSettingsDialog";
import { PresetList } from "./PresetList";
import * as m from "~/paraglide/messages";
import { useSidePanelOpen } from "../sidePanelStack";
import { presetToolShortcut } from "../../pixi/toolShortcuts";

function getEdgeTools(): [PresetConnectionTool, string, string?][] {
  return [
    ["wall", m["preset.wall"]()],
    ["passage", m["preset.passage"]()],
    ["reset", m["preset.reset"](), m["preset.reset_tooltip"]()],
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
    ["gen_source", m["preset.gen_source_tool"]()],
  ];
}

/** Destructive tools show a danger-hued selected border instead of the accent one (mirrors
 *  `PostEditFeature`'s own `DANGER_TOOLS`). */
const DANGER_TOOLS = new Set<PresetConnectionTool>(["clear"]);

export function PresetConnectionsFeature() {
  const tool = useMazeStore((s) => s.presetConnectionsTool);
  const setTool = useMazeStore((s) => s.setPresetConnectionsTool);
  const presetConnections = useMazeStore((s) => s.presetConnections);
  const presetStart = useMazeStore((s) => s.presetStart);
  const presetFinish = useMazeStore((s) => s.presetFinish);
  const presetGenSource = useMazeStore((s) => s.presetGenSource);
  const clearInvalidPresetConnections = useMazeStore((s) => s.clearInvalidPresetConnections);
  const resetPresetConnections = useMazeStore((s) => s.resetPresetConnections);
  const lockedNodes = useMazeStore((s) => s.lockedNodes);
  const clearLockedNodes = useMazeStore((s) => s.clearLockedNodes);
  const showPresetOrigin = useMazeStore((s) => s.showPresetOrigin);
  const setShowPresetOrigin = useMazeStore((s) => s.setShowPresetOrigin);
  const showPresetLocks = useMazeStore((s) => s.showPresetLocks);
  const setShowPresetLocks = useMazeStore((s) => s.setShowPresetLocks);
  const autoLock = useMazeStore((s) => s.autoLock);
  const setAutoLock = useMazeStore((s) => s.setAutoLock);
  const autoLockedNodes = useMazeStore((s) => s.autoLockedNodes);
  const defaultEdgeState = useMazeStore((s) => s.defaultEdgeState);
  const setDefaultEdgeState = useMazeStore((s) => s.setDefaultEdgeState);
  const presetTeleports = useMazeStore((s) => s.presetTeleports);
  const presetVerticalPassages = useMazeStore((s) => s.presetVerticalPassages);
  const presetVerticalPassagePending = useMazeStore((s) => s.presetVerticalPassagePending);
  const cancelPresetVerticalPassagePlacement = useMazeStore((s) => s.cancelPresetVerticalPassagePlacement);
  const presetElevators = useMazeStore((s) => s.presetElevators);
  const presetElevatorPending = useMazeStore((s) => s.presetElevatorPending);
  const cancelPresetElevatorPlacement = useMazeStore((s) => s.cancelPresetElevatorPlacement);
  const presetSplitPoints = useMazeStore((s) => s.presetSplitPoints);
  const presetFocusedPoint = useMazeStore((s) => s.presetFocusedPoint);
  const setPresetFocusedPoint = useMazeStore((s) => s.setPresetFocusedPoint);
  const presetSplitTargetPrompt = useMazeStore((s) => s.presetSplitTargetPrompt);
  const cancelPresetSplitTarget = useMazeStore((s) => s.cancelPresetSplitTarget);
  const presetEntityDeletePrompt = useMazeStore((s) => s.presetEntityDeletePrompt);
  const cancelPresetEntityDelete = useMazeStore((s) => s.cancelPresetEntityDelete);
  const presetEntityPickPrompt = useMazeStore((s) => s.presetEntityPickPrompt);
  const cancelPresetEntityPick = useMazeStore((s) => s.cancelPresetEntityPick);
  const presetConnectionSettingsPrompt = useMazeStore((s) => s.presetConnectionSettingsPrompt);
  const cancelPresetConnectionSettings = useMazeStore((s) => s.cancelPresetConnectionSettings);
  const presetLockSettingsPrompt = useMazeStore((s) => s.presetLockSettingsPrompt);
  const cancelPresetLockSettings = useMazeStore((s) => s.cancelPresetLockSettings);
  const presetEditConfirmation = useMazeStore((s) => s.presetEditConfirmation);
  const confirmPresetEdit = useMazeStore((s) => s.confirmPresetEdit);
  const cancelPresetEdit = useMazeStore((s) => s.cancelPresetEdit);
  const floors = useMazeStore((s) => s.floors);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  const floorFields = useMazeStore((s) => s.floorFields);
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const tessellationParams = useMazeStore((s) => s.tessellationParams);
  const smoothPrimitives = useMazeStore((s) => s.smoothPrimitives);
  const hexOrientation = useMazeStore((s) => s.hexOrientation);
  const triOrientation = useMazeStore((s) => s.triOrientation);
  const presetSectionsExpanded = useMazeStore((s) => s.presetSectionsExpanded);
  const setPresetSectionExpanded = useMazeStore((s) => s.setPresetSectionExpanded);
  const lockToolActive = isPresetLockTool(tool);

  const [confirmReset, setConfirmReset] = useState(false);
  const [presetListOpen, setPresetListOpen] = useSidePanelOpen("preset-list", true);

  // Nodes locked both in and out AND with no explicit passage preset are fully isolated. This is a
  // project-wide problem: changing the active floor must not hide the warning or alter its count.
  // Endpoint-aware keys keep same-coordinate nodes on distinct floors separate.
  const isolatedNodes = useMemo(() => {
    return computeIsolatedNodeKeys(lockedNodes, autoLockedNodes, presetConnections);
  }, [lockedNodes, autoLockedNodes, presetConnections]);

  // The preset data every warning below is counted from; the Features panel status counts from the same input.
  const activeSplitNode = useMazeStore((s) => s.presetActiveSplitNode);
  const warningInput = useMemo<PresetWarningInput>(() => ({
    presetConnections, presetSplitPoints, presetTeleports, presetVerticalPassages, presetElevators, presetStart, presetFinish,
    presetGenSource, lockedNodes, autoLockedNodes, presetActiveSplitNode: activeSplitNode, floors, floorFields,
  }), [presetConnections, presetSplitPoints, presetTeleports, presetVerticalPassages, presetElevators, presetStart, presetFinish, presetGenSource, lockedNodes, autoLockedNodes, activeSplitNode, floors, floorFields]);
  // Face diagnostics shared with the split edit panel (GitHub issue #1107): a node with only walls
  // or no connections is unreachable. Counted per flagged node.
  const splitProblems = useMemo(() => computePresetSplitProblemsOf(warningInput), [warningInput]);
  const unreachableSplitCount = countPresetSplitProblems(splitProblems);

  const resolveFieldAt = useMemo(
    () => resolveFieldAtOf({ floors, floorFields, tessellationKind, tessellationParams, hexOrientation, triOrientation, smoothPrimitives }),
    [floors, floorFields, tessellationKind, tessellationParams, hexOrientation, triOrientation, smoothPrimitives],
  );
  const invalidKeys = useMemo(
    () => computeInvalidKeys(presetConnections, resolveFieldAt),
    [presetConnections, resolveFieldAt],
  );
  // The connections the preset list shows (one row per user-authored connection; a split tile's face records are not rows) that
  // lead out of the field: the problem count counts what the list shows. They are framed on their edge, not highlighted as cells.
  const invalidLinks = useMemo(
    () => listedInvalidConnections(presetConnections, presetSplitPoints, invalidKeys),
    [presetConnections, presetSplitPoints, invalidKeys],
  );
  const invalidCount = useMemo(() => computePresetInvalidElementCount(warningInput, resolveFieldAt), [warningInput, resolveFieldAt]);
  const hasInvalid = invalidCount > 0;
  const invalidEndpoints = useMemo(() => {
    const endpoints: PresetEndpoint[] = [
      ...[presetStart, presetFinish, presetGenSource].filter((endpoint): endpoint is PresetEndpoint => endpoint !== null),
      ...presetTeleports.flatMap(({ from, to }) => [from, to]),
      ...presetVerticalPassages.flatMap(({ from, to }) => [from, to]),
      ...presetElevators.flatMap(({ floors: elevatorFloors }) => elevatorFloors),
      ...Array.from(lockedNodes.keys()).flatMap((key) => {
        const endpoint = presetEndpointFromKey(key);
        return endpoint ? [endpoint] : [];
      }),
      ...Object.keys(presetSplitPoints).flatMap((key) => {
        const endpoint = presetEndpointFromKey(key);
        return endpoint ? [endpoint] : [];
      }),
    ];
    const invalidEndpointKeys = computeInvalidPresetEndpointKeys(endpoints, resolveFieldAt);
    return endpoints.filter((endpoint) => invalidEndpointKeys.has(presetEndpointKey(endpoint)));
  }, [presetStart, presetFinish, presetGenSource, presetTeleports, presetVerticalPassages, presetElevators, lockedNodes, presetSplitPoints, resolveFieldAt]);
  const isolatedWarning = useMemo<CoordinateWarning>(() => ({
    severity: "warning",
    targets: isolatedNodes.flatMap((key) => presetEndpointFromKey(key) ?? []),
  }), [isolatedNodes]);
  // Split nodes are drawn as one merged outward contour (the split style).
  const unreachableSplitWarning = useMemo<CoordinateWarning>(() => {
    const targets = splitProblems.map((problem) => problem.endpoint);
    return {
      severity: "warning",
      targets,
      groups: targets.length > 0 ? [{ targets, outset: true }] : undefined,
    };
  }, [splitProblems]);
  // Connections are not cell targets (their endpoints are drawn as edges, never as cells): only the points outside the
  // field. Split points are one outward contour (the split style), every other target is a single cell.
  const invalidWarning = useMemo<CoordinateWarning>(() => {
    const splitTargets = invalidEndpoints.filter((endpoint) =>
      (presetSplitPoints[presetEndpointKey(presetEndpoint(endpoint.point, undefined, endpoint.level))]?.length ?? 0) > 0);
    return {
      severity: "warning",
      targets: invalidEndpoints,
      groups: splitTargets.length > 0 ? [{ targets: splitTargets, outset: true }] : undefined,
      floorTargets: invalidLinks.flatMap(({ from, to }) => [from, to]),
    };
  }, [invalidEndpoints, presetSplitPoints, invalidLinks]);
  // "Clear invalid" shows what it would remove: the same targets as the outside-field warning.
  const invalidHover = useCoordinateWarningHover(invalidWarning);
  // Invalid connections are framed like any hovered connection: the one-way frame or the boundary frame on their edge.
  const setPresetHoveredLink = useMazeStore((st) => st.setPresetHoveredLink);
  const invalidLinksHovered = useRef(false);
  const setInvalidLinksHovered = useCallback((hovering: boolean) => {
    invalidLinksHovered.current = hovering;
    const links = invalidLinks.map((entry) => ({
      from: entry.from,
      to: entry.to,
      color: canvas.coordinateWarning.warning,
      highlightStyle: entry.state === "one_way_forward" || entry.state === "one_way_backward" ? "one_way" as const : "boundary" as const,
    }));
    setPresetHoveredLink(hovering && links.length > 0 ? { ...links[0], more: links.slice(1) } : null);
  }, [invalidLinks, setPresetHoveredLink]);
  // The frame goes with what it frames: "Clear invalid" removes the connections (and disables its button) and a card
  // switch unmounts this view, both without a mouse-leave; the bubble reports its own unmount through `onHoverChange`.
  useEffect(() => () => {
    if (invalidLinksHovered.current) {
      invalidLinksHovered.current = false;
      setPresetHoveredLink(null);
    }
  }, [invalidLinks, setPresetHoveredLink]);
  const problemCount = presetWarningCount(isolatedNodes.length, unreachableSplitCount, invalidCount);
  const problemsExpanded = presetSectionsExpanded["problems"] ?? false;

  return (
    <Stack gap="groupGap">
        <>
          <SectionHeader
            label={
              <span
                className={problemCount > 0 ? "problem-section-attention" : undefined}
              >
                {m["common.problems"]()} ({problemCount})
              </span>
            }
            expanded={problemsExpanded}
            onToggle={() => setPresetSectionExpanded("problems", !problemsExpanded)}
          />
          {problemsExpanded && (
            <div style={styles.nestedContent}>
              <Stack gap="itemGap">
                {isolatedNodes.length > 0 && (
                  <CoordinateWarningBubble
                    warning={isolatedWarning}
                    message={isolatedNodes.length === 1
                      ? m["preset.nodes_isolated"]({ count: isolatedNodes.length })
                      : m["preset.nodes_isolated_plural"]({ count: isolatedNodes.length })}
                  />
                )}
                {unreachableSplitCount > 0 && (
                  <CoordinateWarningBubble
                    warning={unreachableSplitWarning}
                    message={unreachableSplitCount === 1
                      ? m["preset.split_problems"]({ count: unreachableSplitCount })
                      : m["preset.split_problems_plural"]({ count: unreachableSplitCount })}
                  />
                )}
                {hasInvalid && (
                  <CoordinateWarningBubble
                    warning={invalidWarning}
                    message={m["preset.elements_outside_field"]({ count: invalidCount })}
                    onHoverChange={setInvalidLinksHovered}
                  />
                )}
              </Stack>
            </div>
          )}
          <div style={styles.divider} />
        </>

      <span style={styles.sectionLabel}>{m["preset.tools"]()}</span>
      <div style={styles.nestedContent}>
        <ToolIconRow
          tools={[
            ...getEdgeTools(),
            ...getStartFinishTools(),
            ...getVertexTools(),
            ["manage_split_nodes", m["post_edit.manage_split_nodes_tool"]()],
            ...(floors.length > 1 ? getVerticalTools() : []),
            ...getGenerationTools(),
            ["move", m["tools.move"]()],
            ["settings", m["tools.settings"]()],
            ["clear", m["preset.clear_tool"](), m["preset.clear_tooltip"](), ["shift"]],
          ]}
          activeTool={tool}
          onPick={setTool}
          shortcutFor={presetToolShortcut}
          isDanger={(candidate) => DANGER_TOOLS.has(candidate)}
        />
      </div>

      <span style={styles.sectionLabel}>{m["preset.default_edge"]()}</span>
      <div style={styles.nestedContent}>
        <Grid templateColumns="1fr 1fr 1fr" gap="itemGap">
          {(["undefined", "wall", "passage"] as const).map((s) => (
            <Button
              key={s}
              variant={defaultEdgeState === s ? "toggle-selected" : "toggle"}
              onClick={() => setDefaultEdgeState(s)}
            >
              {s === "undefined"
                ? m["preset.default_undefined_short"]()
                : m[`preset.default_${s}` as "preset.default_wall" | "preset.default_passage"]()}
            </Button>
          ))}
        </Grid>
      </div>

      {presetElevatorPending && (
        <PresetElevatorFloorDialog onClose={cancelPresetElevatorPlacement} />
      )}

      {presetVerticalPassagePending && (
        <PresetVerticalDirectionDialog onClose={cancelPresetVerticalPassagePlacement} />
      )}

      {presetSplitTargetPrompt && (
        <PresetSplitTargetDialog onClose={cancelPresetSplitTarget} />
      )}

      {presetEntityDeletePrompt && (
        <PresetEntityDeleteDialog onClose={cancelPresetEntityDelete} />
      )}

      {presetEntityPickPrompt && (
        <PresetEntityPickDialog onClose={cancelPresetEntityPick} />
      )}

      {presetConnectionSettingsPrompt && (
        <PresetConnectionSettingsDialog onClose={cancelPresetConnectionSettings} />
      )}

      {presetLockSettingsPrompt && (
        <PresetLockSettingsDialog onClose={cancelPresetLockSettings} />
      )}

      {presetEditConfirmation !== null && (
        <ConfirmModal
          message={m["preset.reset_generation_warning"]()}
          onConfirm={confirmPresetEdit}
          onCancel={cancelPresetEdit}
        />
      )}

      <span style={styles.sectionLabel}>{m["preset.control"]()}</span>
      <div style={styles.nestedContent}>
        <Stack gap="itemGap">
          <Button
            variant={presetListOpen ? "toggle-selected" : "toggle"}
            layoutStyle={{ width: "100%" }}
            onClick={() => {
              setPresetListOpen(true);
            }}
          >
            {m["preset.list_tool"]()}
          </Button>
          <Button
            variant="destructive"
            layoutStyle={{ width: "100%" }}
            disabled={lockedNodes.size === 0}
            onClick={clearLockedNodes}
          >
            {m["preset.reset_locks"]()}
          </Button>
          <Button
            variant="destructive"
            layoutStyle={{ width: "100%" }}
            disabled={!hasInvalid}
            onClick={() => clearInvalidPresetConnections()}
            onMouseEnter={() => { invalidHover.onMouseEnter(); setInvalidLinksHovered(true); }}
            onMouseLeave={() => { invalidHover.onMouseLeave(); setInvalidLinksHovered(false); }}
          >
            {m["preset.clear_invalid"]({ count: invalidCount })}
          </Button>
          <Button
            variant="destructive"
            layoutStyle={{ width: "100%" }}
            onClick={() => setConfirmReset(true)}
          >
            {m["common.reset_all"]()}
          </Button>
          <div style={styles.originRow}>
            <span style={{ ...styles.originLabel, ...(lockToolActive ? styles.disabledLabel : {}) }}>{m["preset.show_locks"]()}</span>
            <Switch checked={showPresetLocks || lockToolActive} disabled={lockToolActive} onChange={setShowPresetLocks} />
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
          <BackgroundImageToggle />
        </Stack>
      </div>
      {confirmReset && (
        <ConfirmModal
          title={m["common.reset_all"]()}
          onConfirm={() => { resetPresetConnections(); setConfirmReset(false); }}
          onCancel={() => setConfirmReset(false)}
        />
      )}

      {presetListOpen && <PresetList onClose={() => setPresetListOpen(false)} />}

      {presetFocusedPoint && (
        <PresetSplitNodesDialog
          key={`${presetFocusedPoint[0]},${presetFocusedPoint[1]}@${activeFloorLevel({ floors, activeFloorId }) ?? 0}`}
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
  // One indent level for a section's own content, relative to its `sectionLabel` (mirrors
  // analyticsStyles `nestedGroup`).
  nestedContent: {
    paddingLeft: indent.tree,
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
  disabledLabel: {
    opacity: 0.4,
  },
  divider: {
    borderTop: `1px solid`,
    borderColor: ui.border.default,
    margin: `${spacing.itemGap}px 0`,
  },
};
