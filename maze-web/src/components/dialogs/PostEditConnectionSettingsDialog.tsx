import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { endpointBubble } from "../../pixi/postEditCommandLabels";
import { resolveEndpointToHoverPoint, type PostEditEndpoint } from "../../pixi/postEditEndpoint";
import { formatTargetLabel } from "../../pixi/targetLabel";
import { ConnectionSettingsDialog } from "./ConnectionSettingsDialog";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** Settings-tool dialog for a post-edit teleport or vertical passage (GitHub issue #748). */
export function PostEditConnectionSettingsDialog({ onClose }: Props) {
  const prompt = useMazeStore((s) => s.postEditConnectionSettingsPrompt);
  const teleports = useMazeStore((s) => s.postEditDraftTeleports);
  const verticalPassages = useMazeStore((s) => s.postEditDraftVerticalPassages);
  const nodes = useMazeStore((s) => s.nodes);
  const floorCount = useMazeStore((s) => s.floors.length);
  const setTeleportDirection = useMazeStore((s) => s.setPostEditTeleportDirection);
  const setVerticalPassageDirection = useMazeStore((s) => s.setPostEditVerticalPassageDirection);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  if (!prompt) return null;
  const entry = prompt.kind === "teleport"
    ? teleports.find((t) => t.id === prompt.id)
    : verticalPassages.find((p) => p.id === prompt.id);
  if (!entry) return null;
  // A vertical passage's endpoints share their coordinates, so only the floors are shown.
  const label = (ep: PostEditEndpoint) => {
    if (prompt.kind === "teleport") return endpointBubble(ep, nodeById, floorCount > 1, null).text;
    const p = resolveEndpointToHoverPoint(ep, nodeById);
    return p ? formatTargetLabel(p.point, p.level ?? 0, true, undefined, true) : "?";
  };
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
