import { useMazeStore } from "../../store/mazeStore";
import { VerticalDirectionPicker } from "./VerticalDirectionPicker";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** Direction picker for an in-progress preset vertical-passage placement (GitHub issue #357
 * follow-up: single-click placement) — shown only when the clicked floor has a cell on *both*
 * adjacent floors (`presetVerticalPassagePending.availableDirections.length === 2`); when only one
 * direction is available, `startPresetVerticalPassagePlacement` creates the entry immediately and
 * this dialog is never opened. Two plain buttons, no footer Confirm/Cancel — picking a direction
 * both confirms and closes in one action. */
export function PresetVerticalDirectionDialog({ onClose }: Props) {
  const pending = useMazeStore((s) => s.presetVerticalPassagePending);
  const choose = useMazeStore((s) => s.choosePresetVerticalPassageDirection);

  if (!pending) return null;

  return <VerticalDirectionPicker
    title={m["preset.vertical_direction_dialog_title"]()}
    onSelect={(direction) => { choose(direction); onClose(); }}
    onClose={onClose}
  />;
}
