import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { EntityChoiceDialog, type EntityChoiceRow } from "./EntityChoiceDialog";
import { buildPostEditPointEntitiesAt } from "../../store/slices/postEditSliceHelpers";
import { formatTargetLabel } from "../../pixi/targetLabel";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** Entity-delete picker for the post-edit `delete` tool (GitHub issue #550, mirroring the preset-
 * side `PresetEntityDeleteDialog` from #540). Shown whenever the targeted point carries more than
 * one removable entity — clicking a row removes just that entity, "Delete all" removes every
 * entity currently on the point. The row list is rebuilt from live store state on every render
 * (never cached at open time), so it stays correct as rows disappear one click at a time; the
 * dialog auto-closes once the point is empty. Row assembly itself is `buildPostEditPointEntitiesAt`
 * (GitHub issue #550 tenth follow-up) — this component only subscribes to the individual store
 * fields it needs (for render reactivity) and passes them straight through, rather than
 * re-deriving `nodesHere`/`nodeLevel`/`nodeById`/`splitCtx` itself. */
export function PostEditEntityDeleteDialog({ onClose }: Props) {
  const prompt = useMazeStore((s) => s.postEditEntityDeletePrompt);
  const removeOne = useMazeStore((s) => s.removePostEditPointEntity);
  const removeAll = useMazeStore((s) => s.removeAllPostEditPointEntities);
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
    return buildPostEditPointEntitiesAt(
      {
        nodes, postEditDraftSplitPoints, postEditDraftMeta, postEditDraftTeleports, postEditDraftVerticalPassages, postEditDraftElevators,
        postEditDraftEdges, floors, floorFields, activeFieldConfig, postEditActiveSplitNode,
      },
      prompt.point,
      prompt.level,
    );
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
  return <EntityChoiceDialog
    title={m["post_edit.entity_delete_title"]({ coords })}
    hint={m["post_edit.entity_delete_hint"]()}
    rows={rows}
    deleteAllLabel={m["post_edit.entity_delete_all"]()}
    onSelect={(row) => {
      const entity = entities.find((e) => `${e.kind}:${e.id}` === row.key);
      if (entity) removeOne(entity);
    }}
    onDeleteAll={() => { removeAll(); onClose(); }}
    onClose={onClose}
  />;
}
