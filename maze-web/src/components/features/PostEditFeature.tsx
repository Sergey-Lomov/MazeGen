import { useState, useEffect } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { PostEditTool } from "../../store/mazeStore";
import { Button } from "../Button";
import { ToolIconRow } from "../ToolIconRow";
import { VerticalDragFailureAlert } from "../VerticalDragFailureAlert";
import { typography, spacing, indent, ui } from "../../styles/theme";
import { ConfirmModal } from "../ConfirmModal";
import { ToggleRow } from "../ToggleRow";
import { BackgroundImageToggle } from "../BackgroundImageToggle";
import { IssuesBlock } from "../IssuesBlock";
import { Stack } from "../Layout";
import { ManageSplitNodesDialog } from "./ManageSplitNodesDialog";
import { PostEditChangesPanel } from "./PostEditChangesPanel";
import { AutoConfirmInfoModal, AutoCompactInfoModal } from "./PostEditModals";
import { PostEditElevatorFloorDialog } from "../dialogs/PostEditElevatorFloorDialog";
import { PostEditVerticalDirectionDialog } from "../dialogs/PostEditVerticalDirectionDialog";
import { PostEditSplitTargetDialog } from "../dialogs/PostEditSplitTargetDialog";
import { PostEditEntityDeleteDialog } from "../dialogs/PostEditEntityDeleteDialog";
import { PostEditEntityPickDialog } from "../dialogs/PostEditEntityPickDialog";
import { PostEditConnectionSettingsDialog } from "../dialogs/PostEditConnectionSettingsDialog";
import { PostEditResetDialog } from "../dialogs/PostEditResetDialog";
import type { ToolGlyphKey } from "./toolGlyphs";
import * as m from "~/paraglide/messages";
import type React from "react";

function getEdgeTools(): [PostEditTool, string][] {
  return [
    ["wall",    m["post_edit.wall"]()],
    ["passage", m["post_edit.passage"]()],
    ["one_way", m["post_edit.one_way"]()],
  ];
}

function getVertexTools(): [PostEditTool, string][] {
  return [
    ["set_start",  m["preset.start"]()],
    ["set_finish", m["preset.finish"]()],
  ];
}

function getTeleportTools(): [PostEditTool, string][] {
  return [
    ["teleport_two_way", m["preset.teleport_two_way"]()],
    ["teleport_one_way", m["preset.teleport_one_way"]()],
  ];
}

function getVerticalTools(): [PostEditTool, string][] {
  return [
    ["vertical_passage_two_way", m["preset.vertical_passage_two_way"]()],
    ["vertical_passage_one_way", m["preset.vertical_passage_one_way"]()],
    ["elevator", m["preset.elevator"]()],
  ];
}

/** Which offscreen glyph a post-edit tool draws — `reset` has different semantics from the preset
 *  `reset` tool (revert post-edit changes vs. undecided-edge stub), so it maps to the synthetic
 *  `post_edit_reset` key (`toolGlyphs.ts`); everything else is 1:1. */
function glyphKeyFor(t: PostEditTool): ToolGlyphKey {
  return t === "reset" ? "post_edit_reset" : t;
}

/** Destructive tools show a danger-hued selected border instead of the accent one. */
const DANGER_TOOLS = new Set<PostEditTool>(["reset", "delete"]);

export function PostEditFeature() {
  const tool                = useMazeStore((s) => s.postEditTool);
  const setTool             = useMazeStore((s) => s.setPostEditTool);
  const autoConfirm         = useMazeStore((s) => s.postEditAutoConfirm);
  const setAutoConfirm      = useMazeStore((s) => s.setPostEditAutoConfirm);
  const autoCompact         = useMazeStore((s) => s.postEditAutoCompact);
  const setAutoCompact      = useMazeStore((s) => s.setPostEditAutoCompact);
  const postEditDraftEdges       = useMazeStore((s) => s.postEditDraftEdges);
  const confirmPostEdit     = useMazeStore((s) => s.confirmPostEdit);
  const resetPostEdit       = useMazeStore((s) => s.resetPostEdit);
  const postEditAnalytics   = useMazeStore((s) => s.postEditAnalytics);
  const postEditRefreshError = useMazeStore((s) => s.postEditRefreshError);
  const postEditFocusedPoint = useMazeStore((s) => s.postEditFocusedPoint);
  const setPostEditFocusedPoint = useMazeStore((s) => s.setPostEditFocusedPoint);
  const openCard = useMazeStore((s) => s.openCard);
  const floors = useMazeStore((s) => s.floors);
  const postEditVerticalPassagePending = useMazeStore((s) => s.postEditVerticalPassagePending);
  const cancelPostEditVerticalPassagePlacement = useMazeStore((s) => s.cancelPostEditVerticalPassagePlacement);
  const postEditElevatorPending = useMazeStore((s) => s.postEditElevatorPending);
  const cancelPostEditElevatorPlacement = useMazeStore((s) => s.cancelPostEditElevatorPlacement);
  const postEditSplitTargetPrompt = useMazeStore((s) => s.postEditSplitTargetPrompt);
  const cancelPostEditSplitTarget = useMazeStore((s) => s.cancelPostEditSplitTarget);
  const postEditEntityDeletePrompt = useMazeStore((s) => s.postEditEntityDeletePrompt);
  const postEditEntityPickPrompt = useMazeStore((s) => s.postEditEntityPickPrompt);
  const cancelPostEditEntityPick = useMazeStore((s) => s.cancelPostEditEntityPick);
  const postEditConnectionSettingsPrompt = useMazeStore((s) => s.postEditConnectionSettingsPrompt);
  const cancelPostEditConnectionSettings = useMazeStore((s) => s.cancelPostEditConnectionSettings);
  const cancelPostEditEntityDelete = useMazeStore((s) => s.cancelPostEditEntityDelete);
  const postEditResetPrompt = useMazeStore((s) => s.postEditResetPrompt);
  const cancelPostEditReset = useMazeStore((s) => s.cancelPostEditReset);
  const postEditDragFailureMessage = useMazeStore((s) => s.postEditDragFailureMessage);
  const dismissPostEditDragFailureMessage = useMazeStore((s) => s.dismissPostEditDragFailureMessage);
  const postEditChangesOpen = useMazeStore((s) => s.postEditChangesOpen);
  const setPostEditChangesOpen = useMazeStore((s) => s.setPostEditChangesOpen);

  // The "Manage split nodes" dialog closes when leaving the post-edit card — it has no meaning
  // once the user is looking at a different feature (see GitHub issue #221's plan, §6.2).
  useEffect(() => {
    if (openCard !== "post_edit" && postEditFocusedPoint !== null) {
      setPostEditFocusedPoint(null);
    }
  }, [openCard, postEditFocusedPoint, setPostEditFocusedPoint]);

  // A deferred split-target prompt (GitHub issue #474) has no meaning once the user leaves the
  // post-edit card — drop it, same as the "Manage split nodes" panel above.
  useEffect(() => {
    if (openCard !== "post_edit" && postEditSplitTargetPrompt !== null) {
      cancelPostEditSplitTarget();
    }
  }, [openCard, postEditSplitTargetPrompt, cancelPostEditSplitTarget]);

  // Same reasoning as the split-target prompt above — the entity-delete picker (GitHub issue #550)
  // has no meaning once the user leaves the post-edit card.
  useEffect(() => {
    if (openCard !== "post_edit" && postEditEntityDeletePrompt !== null) {
      cancelPostEditEntityDelete();
    }
  }, [openCard, postEditEntityDeletePrompt, cancelPostEditEntityDelete]);

  // The move/settings pickers and the connection settings dialog (GitHub issue #748) have no
  // meaning once the user leaves the post-edit card either.
  useEffect(() => {
    if (openCard !== "post_edit") {
      if (postEditEntityPickPrompt !== null) cancelPostEditEntityPick();
      if (postEditConnectionSettingsPrompt !== null) cancelPostEditConnectionSettings();
    }
  }, [openCard, postEditEntityPickPrompt, cancelPostEditEntityPick, postEditConnectionSettingsPrompt, cancelPostEditConnectionSettings]);

  // Same reasoning as the entity-delete picker above — the reset picker (GitHub issue #549) has no
  // meaning once the user leaves the post-edit card.
  useEffect(() => {
    if (openCard !== "post_edit" && postEditResetPrompt !== null) {
      cancelPostEditReset();
    }
  }, [openCard, postEditResetPrompt, cancelPostEditReset]);

  // The "Changes" panel closes when leaving the post-edit card, same as the other post-edit
  // panels above — it has no meaning once the user is looking at a different feature.
  useEffect(() => {
    if (openCard !== "post_edit" && postEditChangesOpen) {
      setPostEditChangesOpen(false);
    }
  }, [openCard, postEditChangesOpen, setPostEditChangesOpen]);

  const [confirmReset, setConfirmReset] = useState(false);
  const [autoConfirmInfoOpen, setAutoConfirmInfoOpen] = useState(false);
  const [autoCompactInfoOpen, setAutoCompactInfoOpen] = useState(false);

  const hasEdges = postEditDraftEdges !== null;

  return (
    <Stack gap="groupGap">
      {postEditRefreshError !== null && (
        <div style={styles.statusError}>{m["post_edit.refresh_error"]({ message: postEditRefreshError })}</div>
      )}
      {postEditAnalytics && <IssuesBlock issues={postEditAnalytics.issues} />}

      <span style={styles.sectionLabel}>{m["post_edit.tools"]()}</span>
      <div style={styles.nestedContent}>
        <ToolIconRow
          tools={[
            ...getEdgeTools(),
            ...getVertexTools(),
            ...getTeleportTools(),
            ["manage_split_nodes", m["post_edit.manage_split_nodes_tool"]()],
            ...(floors.length > 1 ? getVerticalTools() : []),
            ["reset", m["post_edit.reset_tool"]()],
            ["move", m["tools.move"]()],
            ["settings", m["tools.settings"]()],
            ["delete", m["post_edit.delete_tool"]()],
          ]}
          activeTool={tool}
          onPick={setTool}
          glyphFor={glyphKeyFor}
          isDanger={(candidate) => DANGER_TOOLS.has(candidate)}
        />
      </div>

      {postEditElevatorPending && (
        <PostEditElevatorFloorDialog onClose={cancelPostEditElevatorPlacement} />
      )}

      {postEditVerticalPassagePending && (
        <PostEditVerticalDirectionDialog onClose={cancelPostEditVerticalPassagePlacement} />
      )}

      {postEditSplitTargetPrompt && (
        <PostEditSplitTargetDialog onClose={cancelPostEditSplitTarget} />
      )}

      {postEditEntityDeletePrompt && (
        <PostEditEntityDeleteDialog onClose={cancelPostEditEntityDelete} />
      )}

      {postEditEntityPickPrompt && (
        <PostEditEntityPickDialog onClose={cancelPostEditEntityPick} />
      )}

      {postEditConnectionSettingsPrompt && (
        <PostEditConnectionSettingsDialog onClose={cancelPostEditConnectionSettings} />
      )}

      {postEditResetPrompt && (
        <PostEditResetDialog onClose={cancelPostEditReset} />
      )}

      {postEditDragFailureMessage && <VerticalDragFailureAlert failure={postEditDragFailureMessage} onClose={dismissPostEditDragFailureMessage} />}

      <span style={styles.sectionLabel}>{m["post_edit.management"]()}</span>
      <div style={styles.nestedContent}>
        <Stack gap="itemGap">
          <Button
            variant={postEditChangesOpen ? "toggle-selected" : "toggle"}
            layoutStyle={{ width: "100%" }}
            onClick={() => setPostEditChangesOpen(!postEditChangesOpen)}
          >
            {m["post_edit.changes_tool"]()}
          </Button>

          <Button
            variant="destructive"
            layoutStyle={{ width: "100%" }}
            onClick={() => setConfirmReset(true)}
          >
            {m["post_edit.reset_to_generation"]()}
          </Button>

          <Button
            variant="primary"
            layoutStyle={{ width: "100%" }}
            disabled={autoConfirm || !hasEdges}
            onClick={() => void confirmPostEdit()}
          >
            {m["post_edit.confirm"]()}
          </Button>

          <ToggleRow
            label={m["post_edit.auto_confirm"]()}
            checked={autoConfirm}
            onChange={setAutoConfirm}
            info={() => setAutoConfirmInfoOpen(true)}
          />

          <ToggleRow
            label={m["post_edit.auto_compact"]()}
            checked={autoCompact}
            onChange={setAutoCompact}
            info={() => setAutoCompactInfoOpen(true)}
          />
          <BackgroundImageToggle />
        </Stack>
      </div>

      {confirmReset && (
        <ConfirmModal
          title={m["post_edit.reset_to_generation"]()}
          onConfirm={() => { resetPostEdit(); setConfirmReset(false); }}
          onCancel={() => setConfirmReset(false)}
        />
      )}

      {autoConfirmInfoOpen && <AutoConfirmInfoModal onClose={() => setAutoConfirmInfoOpen(false)} />}
      {autoCompactInfoOpen && <AutoCompactInfoModal onClose={() => setAutoCompactInfoOpen(false)} />}

      {postEditChangesOpen && (
        <PostEditChangesPanel onClose={() => setPostEditChangesOpen(false)} />
      )}

      {postEditFocusedPoint && (
        <ManageSplitNodesDialog
          key={`${postEditFocusedPoint[0]},${postEditFocusedPoint[1]}`}
          point={postEditFocusedPoint}
          onClose={() => setPostEditFocusedPoint(null)}
        />
      )}
    </Stack>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sectionLabel: {
    ...typography.body,
    marginTop: spacing.groupGap,
  },
  // One indent level for a section's own content, relative to its `sectionLabel`.
  nestedContent: {
    paddingLeft: indent.tree,
  },
  statusError: {
    ...typography.body,
    color: ui.text.error,
  },
};
