import { useMazeStore } from "../../store/mazeStore";
import { EntityChoiceDialog } from "./EntityChoiceDialog";
import { formatTargetLabel } from "../../pixi/targetLabel";
import { presetEntityChoiceRows, presetEntityRowKey, usePresetPointEntities } from "./usePresetPointEntities";
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
  const floorCount = useMazeStore((s) => s.floors.length);
  const entities = usePresetPointEntities(prompt);

  if (!prompt) return null;
  if (entities.length === 0) {
    onClose();
    return null;
  }
  const coords = formatTargetLabel(prompt.point, prompt.level ?? 0, floorCount > 1, undefined);
  return <EntityChoiceDialog
    title={m["preset.entity_delete_title"]({ coords })}
    hint={m["preset.entity_delete_hint"]()}
    rows={presetEntityChoiceRows(entities)}
    deleteAllLabel={m["preset.entity_delete_all"]()}
    onSelect={(row) => {
      const entity = entities.find((e) => presetEntityRowKey(e) === row.key);
      if (entity) removeOne(entity);
    }}
    onDeleteAll={() => { removeAll(); onClose(); }}
    onClose={onClose}
  />;
}
