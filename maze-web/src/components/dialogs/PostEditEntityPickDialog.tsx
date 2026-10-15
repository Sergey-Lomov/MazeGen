import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { EntityChoiceDialog, type EntityChoiceRow } from "./EntityChoiceDialog";
import { buildPostEditPointEntitiesAt } from "../../store/slices/postEditSliceHelpers";
import { postEditEntitiesForPurpose } from "../../pixi/entityToolKinds";
import { formatTargetLabel } from "../../pixi/targetLabel";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** Element picker of the post-edit move and settings tools (GitHub issue #748), shown when a cell
 *  holds more than one element the tool can act on. A split tile lists the elements of all its
 *  nodes. Rows match the entity-delete dialog's. */
export function PostEditEntityPickDialog({ onClose }: Props) {
  const prompt = useMazeStore((s) => s.postEditEntityPickPrompt);
  const choose = useMazeStore((s) => s.choosePostEditEntityPick);
  const nodes = useMazeStore((s) => s.nodes);
  const postEditDraftSplitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  const postEditDraftMeta = useMazeStore((s) => s.postEditDraftMeta);
  const postEditDraftTeleports = useMazeStore((s) => s.postEditDraftTeleports);
  const postEditDraftVerticalPassages = useMazeStore((s) => s.postEditDraftVerticalPassages);
  const postEditDraftElevators = useMazeStore((s) => s.postEditDraftElevators);
  const postEditDraftEdges = useMazeStore((s) => s.postEditDraftEdges);
  const floors = useMazeStore((s) => s.floors);
  const postEditActiveSplitNode = useMazeStore((s) => s.postEditActiveSplitNode);
  const activeFieldConfig = useMazeStore((s) => s.activeFieldConfig);
  const floorFields = useMazeStore((s) => s.floorFields);

  const entities = useMemo(() => {
    if (!prompt) return [];
    return postEditEntitiesForPurpose(prompt.purpose, buildPostEditPointEntitiesAt(
      {
        nodes, postEditDraftSplitPoints, postEditDraftMeta, postEditDraftTeleports, postEditDraftVerticalPassages, postEditDraftElevators,
        postEditDraftEdges, floors, floorFields, activeFieldConfig, postEditActiveSplitNode,
      },
      prompt.point,
      prompt.level,
    ));
  }, [
    prompt, nodes, postEditDraftSplitPoints, postEditDraftMeta, postEditDraftTeleports, postEditDraftVerticalPassages, postEditDraftElevators,
    postEditDraftEdges, floors, floorFields, activeFieldConfig, postEditActiveSplitNode,
  ]);

  if (!prompt) return null;
  if (entities.length === 0) {
    onClose();
    return null;
  }
  const coords = formatTargetLabel(prompt.point, prompt.level ?? 0, floors.length > 1, undefined);
  const rows: EntityChoiceRow[] = entities.map((e) => ({
    key: `${e.kind}:${e.id}`,
    title: e.title,
    entityId: e.entityId,
    bubbles: e.bubbles.map((bubble) => bubble.text),
    showArrow: e.showArrow,
    arrow: e.arrow,
  }));
  const isMove = prompt.purpose === "move";
  return <EntityChoiceDialog
    title={isMove ? m["tools.pick_move_title"]({ coords }) : m["tools.pick_settings_title"]({ coords })}
    hint={isMove ? m["tools.pick_move_hint"]() : m["tools.pick_settings_hint"]()}
    rows={rows}
    onSelect={(row) => {
      const entity = entities.find((e) => `${e.kind}:${e.id}` === row.key);
      if (entity) choose(entity);
    }}
    onClose={onClose}
    compact
  />;
}
