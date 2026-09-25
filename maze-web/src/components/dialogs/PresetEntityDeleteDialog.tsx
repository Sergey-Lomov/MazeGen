import React, { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { buildPresetPointEntities } from "../../pixi/pointEntities";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import type { PresetSplitLabelContext } from "../../pixi/presetSplitLabels";
import { formatTargetLabel } from "../../pixi/targetLabel";
import { ui, radius, dialogSpacing, spacing, typography, inset, muted } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** Entity-delete picker for the preset `clear` cell tool and RMB vertex-tools (GitHub issue #540).
 * Shown whenever the targeted point/scope carries more than one removable entity — clicking a row
 * removes just that entity, "Delete all" removes every entity currently in scope. The row list is
 * rebuilt from live store state on every render (never cached at open time), so it stays correct as
 * rows disappear one click at a time; the dialog auto-closes once the scope is empty. */
export function PresetEntityDeleteDialog({ onClose }: Props) {
  const prompt = useMazeStore((s) => s.presetEntityDeletePrompt);
  const removeOne = useMazeStore((s) => s.removePresetPointEntity);
  const removeAll = useMazeStore((s) => s.removeAllPresetPointEntities);
  const presetSplitPoints = useMazeStore((s) => s.presetSplitPoints);
  const presetStart = useMazeStore((s) => s.presetStart);
  const presetFinish = useMazeStore((s) => s.presetFinish);
  const presetGenSource = useMazeStore((s) => s.presetGenSource);
  const presetTeleports = useMazeStore((s) => s.presetTeleports);
  const presetVerticalPassages = useMazeStore((s) => s.presetVerticalPassages);
  const presetElevators = useMazeStore((s) => s.presetElevators);
  const presetConnections = useMazeStore((s) => s.presetConnections);
  const presetActiveSplitNode = useMazeStore((s) => s.presetActiveSplitNode);
  const lockedNodes = useMazeStore((s) => s.lockedNodes);
  const autoLockedNodes = useMazeStore((s) => s.autoLockedNodes);
  const activeFloorIndex = useMazeStore((s) => Math.max(s.floors.findIndex((f) => f.id === s.activeFloorId), 0));
  const cfg = useMazeStore((s) => s.floorFields[s.activeFloorId].tessellationConfig);
  const fieldPoints = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPoints);
  const fieldEditMode = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldEditMode);
  const floorFields = useMazeStore((s) => s.floorFields);
  const floors = useMazeStore((s) => s.floors);

  const inFieldCells = useMemo(
    () => buildCellSet(buildActiveCells(fieldPoints, fieldEditMode, cfg)),
    [fieldPoints, fieldEditMode, cfg],
  );

  const splitCtx: PresetSplitLabelContext = useMemo(() => ({
    splitPoints: presetSplitPoints,
    presetConnections,
    activeSplitNode: presetActiveSplitNode,
    cfgAt: (targetLevel) => floorFields[floors[targetLevel]?.id ?? ""]?.tessellationConfig ?? cfg,
    inFieldCellsAt: (targetLevel) => {
      const targetFloor = floorFields[floors[targetLevel]?.id ?? ""];
      return targetFloor
        ? buildCellSet(buildActiveCells(targetFloor.fieldPoints, targetFloor.fieldEditMode, targetFloor.tessellationConfig))
        : inFieldCells;
    },
  }), [presetSplitPoints, presetConnections, presetActiveSplitNode, floorFields, floors, cfg, inFieldCells]);

  const entities = useMemo(() => {
    if (!prompt) return [];
    return buildPresetPointEntities(prompt.point, prompt.level, activeFloorIndex, prompt.scope, {
      presetSplitPoints, presetStart, presetFinish, presetGenSource,
      presetTeleports, presetVerticalPassages, presetElevators,
      presetConnections, lockedNodes, autoLockedNodes, splitCtx,
    });
  }, [
    prompt, activeFloorIndex, presetSplitPoints, presetStart, presetFinish, presetGenSource,
    presetTeleports, presetVerticalPassages, presetElevators, presetConnections, lockedNodes, autoLockedNodes,
    splitCtx,
  ]);

  if (!prompt) return null;
  if (entities.length === 0) {
    onClose();
    return null;
  }
  const coords = formatTargetLabel(prompt.point, prompt.level ?? 0, floors.length > 1, undefined);
  const actionTitle = (entity: (typeof entities)[number]): string => {
    if (entity.kind === "teleport") return m["post_edit.entity_delete_label_teleport"]();
    if (entity.kind === "vertical_passage") return m["post_edit.entity_delete_label_vertical_passage"]();
    if (entity.kind === "elevator") return m["post_edit.entity_delete_label_elevator"]();
    if (entity.kind === "edge") return entity.title.replace(/\s+(?:<->|->|<-)\s+.*$/, "");
    return entity.title;
  };

  return (
    <Modal title={m["preset.entity_delete_title"]({ coords })} size="approveWide" onClose={onClose}>
      <p style={styles.hint}>{m["preset.entity_delete_hint"]()}</p>
      <div style={styles.list}>
        {entities.map((e) => (
          <Button
            key={`${e.kind}:${e.id}`}
            variant="secondary"
            layoutStyle={styles.item}
            onClick={() => removeOne(e)}
          >
            <span style={styles.action}>{actionTitle(e)}</span>
            {e.entityId !== undefined && <span style={styles.idBubble}>id: {e.entityId}</span>}
            <div style={styles.bubbles}>
              {(e.bubbles ?? []).map((bubble, j) => (
                <span key={j} style={styles.bubbleGroup}>
                  {j > 0 && e.showArrow && <span style={styles.arrow}>{e.arrow}</span>}
                  <span style={styles.bubble}>{bubble}</span>
                </span>
              ))}
            </div>
          </Button>
        ))}
      </div>
      <div style={styles.footer}>
        <Button variant="secondary" layoutStyle={styles.btnCancel} onClick={onClose}>{m["common.cancel"]()}</Button>
        <Button variant="destructive" layoutStyle={styles.btnCancel} onClick={() => { removeAll(); onClose(); }}>
          {m["preset.entity_delete_all"]()}
        </Button>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  hint: {
    ...typography.control,
    color: ui.text.secondary,
    margin: 0,
    paddingBottom: dialogSpacing.paddingY,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: dialogSpacing.gap,
  },
  item: {
    ...typography.control,
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.rowGap,
    width: "100%",
    justifyContent: "flex-start",
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    borderRadius: radius.sm,
  },
  action: {
    ...typography.body,
    whiteSpace: "nowrap",
  },
  idBubble: {
    ...typography.caption,
    fontFamily: "Consolas, Menlo, Monaco, monospace",
    display: "inline-flex",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: `0 ${spacing.itemGap}px`,
    background: ui.bg.success,
    borderColor: ui.text.success,
    color: ui.text.success,
    whiteSpace: "nowrap",
  },
  bubbles: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.itemGap / 2,
  },
  bubbleGroup: {
    display: "inline-flex",
    alignItems: "center",
    gap: spacing.itemGap,
  },
  arrow: {
    ...muted(typography.caption),
  },
  bubble: {
    ...typography.caption,
    fontFamily: "Consolas, Menlo, Monaco, monospace",
    display: "inline-flex",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: `0 ${spacing.itemGap}px`,
    background: ui.debug.refHighlight.bg,
    borderColor: ui.debug.refHighlight.text,
    color: ui.debug.refHighlight.text,
    whiteSpace: "nowrap",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: dialogSpacing.gap,
    paddingTop: dialogSpacing.paddingY,
    borderTop: `1px solid ${ui.border.default}`,
  },
  btnCancel: {
    ...typography.control,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
};
