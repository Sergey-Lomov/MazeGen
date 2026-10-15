import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { buildPresetPointEntities, type PresetPointEntityDescriptor, type PresetPointEntityScope } from "../../pixi/pointEntities";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import type { PresetSplitLabelContext } from "../../pixi/presetSplitLabels";
import type { EntityChoiceRow } from "./EntityChoiceDialog";
import * as m from "~/paraglide/messages";

/** Live preset entity descriptors (with dialog bubbles) for one point — shared by the entity-delete
 *  dialog and the move/settings pick dialog. Rebuilt from store state on every change, never cached
 *  at open time. `[]` while `target` is `null`. */
export function usePresetPointEntities(
  target: { point: [number, number]; level?: number; scope: PresetPointEntityScope } | null,
): PresetPointEntityDescriptor[] {
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

  return useMemo(() => {
    if (!target) return [];
    return buildPresetPointEntities(target.point, target.level, activeFloorIndex, target.scope, {
      presetSplitPoints, presetStart, presetFinish, presetGenSource,
      presetTeleports, presetVerticalPassages, presetElevators,
      presetConnections, lockedNodes, autoLockedNodes, splitCtx,
    });
  }, [
    target, activeFloorIndex, presetSplitPoints, presetStart, presetFinish, presetGenSource,
    presetTeleports, presetVerticalPassages, presetElevators, presetConnections, lockedNodes, autoLockedNodes,
    splitCtx,
  ]);
}

function actionTitle(entity: PresetPointEntityDescriptor): string {
  if (entity.kind === "teleport") return m["post_edit.entity_delete_label_teleport"]();
  if (entity.kind === "vertical_passage") return m["post_edit.entity_delete_label_vertical_passage"]();
  if (entity.kind === "elevator") return m["post_edit.entity_delete_label_elevator"]();
  if (entity.kind === "edge") return entity.title.replace(/\s+(?:<->|->|<-)\s+.*$/, "");
  return entity.title;
}

export function presetEntityRowKey(entity: PresetPointEntityDescriptor): string {
  return `${entity.kind}:${entity.id}`;
}

/** Dialog rows for preset entity descriptors, keyed by `presetEntityRowKey`. */
export function presetEntityChoiceRows(entities: PresetPointEntityDescriptor[]): EntityChoiceRow[] {
  return entities.map((e) => ({
    key: presetEntityRowKey(e),
    title: actionTitle(e),
    entityId: e.entityId,
    bubbles: e.bubbles ?? [],
    showArrow: e.showArrow,
    arrow: e.arrow,
  }));
}
