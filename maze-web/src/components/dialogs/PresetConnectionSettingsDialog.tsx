import { useMazeStore } from "../../store/mazeStore";
import { formatTargetLabel } from "../../pixi/targetLabel";
import type { PresetEndpoint } from "../../pixi/presetEndpoint";
import { ConnectionSettingsDialog } from "./ConnectionSettingsDialog";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** Settings-tool dialog for a preset teleport or vertical passage (GitHub issue #748). */
export function PresetConnectionSettingsDialog({ onClose }: Props) {
  const prompt = useMazeStore((s) => s.presetConnectionSettingsPrompt);
  const teleports = useMazeStore((s) => s.presetTeleports);
  const verticalPassages = useMazeStore((s) => s.presetVerticalPassages);
  const floorCount = useMazeStore((s) => s.floors.length);
  const setTeleportDirection = useMazeStore((s) => s.setPresetTeleportDirection);
  const setVerticalPassageDirection = useMazeStore((s) => s.setPresetVerticalPassageDirection);

  if (!prompt) return null;
  const entry = prompt.kind === "teleport"
    ? teleports.find((t) => t.id === prompt.id)
    : verticalPassages.find((p) => p.id === prompt.id);
  if (!entry) return null;
  // A vertical passage's endpoints share their coordinates, so only the floors are shown.
  const floorOnly = prompt.kind === "vertical_passage";
  const label = (ep: PresetEndpoint) => formatTargetLabel(ep.point, ep.level ?? 0, floorCount > 1, undefined, floorOnly);
  return <ConnectionSettingsDialog
    title={prompt.kind === "teleport" ? m["tools.connection_settings_teleport"]() : m["tools.connection_settings_vertical_passage"]()}
    fromLabel={label(entry.from)}
    toLabel={label(entry.to)}
    direction={entry.direction}
    onSelect={(direction) => {
      if (prompt.kind === "teleport") setTeleportDirection(prompt.id, direction);
      else setVerticalPassageDirection(prompt.id, direction);
    }}
    onClose={onClose}
  />;
}
