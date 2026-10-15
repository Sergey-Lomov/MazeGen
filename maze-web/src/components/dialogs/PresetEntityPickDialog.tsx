import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { EntityChoiceDialog } from "./EntityChoiceDialog";
import { formatTargetLabel } from "../../pixi/targetLabel";
import { presetEntitiesForPurpose } from "../../pixi/entityToolKinds";
import { presetEntityChoiceRows, presetEntityRowKey, usePresetPointEntities } from "./usePresetPointEntities";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** Element picker of the preset move and settings tools (GitHub issue #748), shown when a cell holds
 *  more than one element the tool can act on. A split tile lists the elements of all its nodes. */
export function PresetEntityPickDialog({ onClose }: Props) {
  const prompt = useMazeStore((s) => s.presetEntityPickPrompt);
  const choose = useMazeStore((s) => s.choosePresetEntityPick);
  const floorCount = useMazeStore((s) => s.floors.length);
  const target = useMemo(
    () => (prompt ? { point: prompt.point, level: prompt.level, scope: { kind: "point_all" as const } } : null),
    [prompt],
  );
  const allEntities = usePresetPointEntities(target);

  if (!prompt) return null;
  const entities = presetEntitiesForPurpose(prompt.purpose, allEntities);
  if (entities.length === 0) {
    onClose();
    return null;
  }
  const coords = formatTargetLabel(prompt.point, prompt.level ?? 0, floorCount > 1, undefined);
  const isMove = prompt.purpose === "move";
  return <EntityChoiceDialog
    title={isMove ? m["tools.pick_move_title"]({ coords }) : m["tools.pick_settings_title"]({ coords })}
    hint={isMove ? m["tools.pick_move_hint"]() : m["tools.pick_settings_hint"]()}
    rows={presetEntityChoiceRows(entities)}
    onSelect={(row) => {
      const entity = entities.find((e) => presetEntityRowKey(e) === row.key);
      if (entity) choose(entity);
    }}
    onClose={onClose}
    compact
  />;
}
