import { useMazeStore } from "../../store/mazeStore";
import { VerticalDirectionPicker } from "./VerticalDirectionPicker";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** Direction picker for an in-progress post-edit vertical-passage placement (GitHub issue #341) —
 * mirrors `PresetVerticalDirectionDialog`, shown only when the clicked node's own point has a cell
 * on *both* adjacent floors (`postEditVerticalPassagePending.availableDirections.length === 2`). */
export function PostEditVerticalDirectionDialog({ onClose }: Props) {
  const pending = useMazeStore((s) => s.postEditVerticalPassagePending);
  const choose = useMazeStore((s) => s.choosePostEditVerticalPassageDirection);

  if (!pending) return null;

  return <VerticalDirectionPicker
    title={m["preset.vertical_direction_dialog_title"]()}
    onSelect={(direction) => { choose(direction); onClose(); }}
    onClose={onClose}
  />;
}
