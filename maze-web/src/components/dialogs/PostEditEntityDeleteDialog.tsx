import React, { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { buildPostEditPointEntitiesAt } from "../../store/slices/postEditSliceHelpers";
import { ui, radius, dialogSpacing, spacing, typography, inset, muted } from "../../styles/theme";
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
  const activeTessellationConfig = useMazeStore((s) => s.activeTessellationConfig);
  const floorFields = useMazeStore((s) => s.floorFields);

  const entities = useMemo(() => {
    if (!prompt) return [];
    return buildPostEditPointEntitiesAt(
      {
        nodes, postEditDraftSplitPoints, postEditDraftMeta, postEditDraftTeleports, postEditDraftVerticalPassages, postEditDraftElevators,
        postEditDraftEdges, floors, floorFields, activeTessellationConfig, postEditActiveSplitNode,
      },
      prompt.point,
      prompt.level,
    );
  }, [
    prompt, nodes, postEditDraftSplitPoints, postEditDraftMeta, postEditDraftTeleports, postEditDraftVerticalPassages, postEditDraftElevators,
    postEditDraftEdges, floors, floorFields, activeTessellationConfig, postEditActiveSplitNode,
  ]);

  if (!prompt) return null;
  if (entities.length === 0) {
    onClose();
    return null;
  }
  const [x, y] = prompt.point;

  return (
    <Modal title={m["post_edit.entity_delete_title"]({ x, y })} size="approveWide" onClose={onClose}>
      <p style={styles.hint}>{m["post_edit.entity_delete_hint"]()}</p>
      <div style={styles.list}>
        {entities.map((e) => (
          <Button
            key={`${e.kind}:${e.id}`}
            variant="secondary"
            layoutStyle={styles.item}
            onClick={() => removeOne(e)}
          >
            <span style={styles.action}>{e.title}</span>
            {e.entityId !== undefined && <span style={styles.idBubble}>id: {e.entityId}</span>}
            <div style={styles.bubbles}>
              {e.bubbles.map((bubble, j) => (
                <span key={j} style={styles.bubbleGroup}>
                  {j > 0 && e.showArrow && <span style={styles.arrow}>{e.arrow}</span>}
                  <span style={styles.bubble}>{bubble.text}</span>
                </span>
              ))}
            </div>
          </Button>
        ))}
      </div>
      <div style={styles.footer}>
        <Button variant="secondary" layoutStyle={styles.btnCancel} onClick={onClose}>{m["common.cancel"]()}</Button>
        <Button variant="destructive" layoutStyle={styles.btnCancel} onClick={() => { removeAll(); onClose(); }}>
          {m["post_edit.entity_delete_all"]()}
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
    flexDirection: "row",
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
