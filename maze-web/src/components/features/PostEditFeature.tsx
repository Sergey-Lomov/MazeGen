import { useState, useEffect } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { PostEditTool } from "../../store/mazeStore";
import { buttonStyle } from "../../styles/shared";
import { typography, muted, spacing } from "../../styles/theme";
import { ConfirmModal } from "../ConfirmModal";
import { Switch } from "../Switch";
import { IssuesBlock } from "../IssuesBlock";
import { Stack, Inline, Grid } from "../Layout";
import { ManageSplitNodesDialog } from "./ManageSplitNodesDialog";
import { PostEditElevatorFloorDialog } from "../dialogs/PostEditElevatorFloorDialog";
import { PostEditVerticalDirectionDialog } from "../dialogs/PostEditVerticalDirectionDialog";
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

export function PostEditFeature() {
  const tool                = useMazeStore((s) => s.postEditTool);
  const setTool             = useMazeStore((s) => s.setPostEditTool);
  const autoConfirm         = useMazeStore((s) => s.postEditAutoConfirm);
  const setAutoConfirm      = useMazeStore((s) => s.setPostEditAutoConfirm);
  const postEditDraftEdges       = useMazeStore((s) => s.postEditDraftEdges);
  const confirmPostEdit     = useMazeStore((s) => s.confirmPostEdit);
  const resetPostEdit       = useMazeStore((s) => s.resetPostEdit);
  const postEditAnalytics   = useMazeStore((s) => s.postEditAnalytics);
  const postEditFocusedPoint = useMazeStore((s) => s.postEditFocusedPoint);
  const setPostEditFocusedPoint = useMazeStore((s) => s.setPostEditFocusedPoint);
  const openCard = useMazeStore((s) => s.openCard);
  const floors = useMazeStore((s) => s.floors);
  const postEditVerticalPassagePending = useMazeStore((s) => s.postEditVerticalPassagePending);
  const cancelPostEditVerticalPassagePlacement = useMazeStore((s) => s.cancelPostEditVerticalPassagePlacement);
  const postEditElevatorPending = useMazeStore((s) => s.postEditElevatorPending);
  const cancelPostEditElevatorPlacement = useMazeStore((s) => s.cancelPostEditElevatorPlacement);

  // The "Manage split nodes" dialog closes when leaving the post-edit card — it has no meaning
  // once the user is looking at a different feature (see GitHub issue #221's plan, §6.2).
  useEffect(() => {
    if (openCard !== "post_edit" && postEditFocusedPoint !== null) {
      setPostEditFocusedPoint(null);
    }
  }, [openCard, postEditFocusedPoint, setPostEditFocusedPoint]);

  const [confirmReset, setConfirmReset] = useState(false);

  const hasEdges = postEditDraftEdges !== null;

  return (
    <Stack gap="groupGap">
      {postEditAnalytics && <IssuesBlock issues={postEditAnalytics.issues} />}
      <span style={styles.sectionLabel}>{m["preset.edges_tools"]()}</span>
      <Grid templateColumns="1fr 1fr" gap="itemGap">
        {getEdgeTools().map(([t, label]) => (
          <button
            key={t}
            className={tool === t ? "hoverable-accent" : "hoverable"}
            style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
      </Grid>
      <span style={styles.sectionLabel}>{m["preset.vertex_tools"]()}</span>
      <Stack gap="itemGap">
        {getTeleportTools().map(([t, label]) => (
          <button
            key={t}
            className={tool === t ? "hoverable-accent" : "hoverable"}
            style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
        <Grid templateColumns="1fr 1fr" gap="itemGap">
          {getVertexTools().map(([t, label]) => (
            <button
              key={t}
              className={tool === t ? "hoverable-accent" : "hoverable"}
              style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
              onClick={() => setTool(t)}
            >
              {label}
            </button>
          ))}
        </Grid>
        <button
          className={tool === "manage_split_nodes" ? "hoverable-accent" : "hoverable"}
          style={buttonStyle(tool === "manage_split_nodes" ? "toggle-active" : "toggle")}
          onClick={() => setTool("manage_split_nodes")}
        >
          {m["post_edit.manage_split_nodes_tool"]()}
        </button>
        {floors.length > 1 && getVerticalTools().map(([t, label]) => (
          <button
            key={t}
            className={tool === t ? "hoverable-accent" : "hoverable"}
            style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
      </Stack>

      {postEditElevatorPending && (
        <PostEditElevatorFloorDialog onClose={cancelPostEditElevatorPlacement} />
      )}

      {postEditVerticalPassagePending && (
        <PostEditVerticalDirectionDialog onClose={cancelPostEditVerticalPassagePlacement} />
      )}

      <span style={styles.sectionLabel}>{m["post_edit.management"]()}</span>
      <Stack gap="itemGap">
        <button
          className={tool === "reset" ? "hoverable-danger" : "hoverable"}
          style={buttonStyle(tool === "reset" ? "toggle-danger-active" : "toggle-danger")}
          onClick={() => setTool("reset")}
        >
          {m["post_edit.reset"]()}
        </button>

        <button
          className="hoverable-danger"
          style={{ ...buttonStyle("destructive"), width: "100%" }}
          onClick={() => setConfirmReset(true)}
        >
          {m["post_edit.reset_to_generation"]()}
        </button>

        <button
          className="hoverable-accent"
          style={{ ...buttonStyle("primary"), width: "100%" }}
          disabled={autoConfirm || !hasEdges}
          onClick={() => void confirmPostEdit()}
        >
          {m["post_edit.confirm"]()}
        </button>

        <Inline gap="groupGap" justify="space-between">
          <span style={styles.autoConfirmLabel}>{m["post_edit.auto_confirm"]()}</span>
          <Switch checked={autoConfirm} onChange={setAutoConfirm} />
        </Inline>
        <span style={styles.hint}>{m["post_edit.auto_confirm_hint"]()}</span>
      </Stack>

      {confirmReset && (
        <ConfirmModal
          message={m["post_edit.confirm_reset"]()}
          onConfirm={() => { resetPostEdit(); setConfirmReset(false); }}
          onCancel={() => setConfirmReset(false)}
        />
      )}

      {postEditFocusedPoint && (
        <ManageSplitNodesDialog
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
  autoConfirmLabel: {
    ...muted(typography.body),
  },
  hint: {
    ...typography.caption,
    marginTop: -4,
  },
};
