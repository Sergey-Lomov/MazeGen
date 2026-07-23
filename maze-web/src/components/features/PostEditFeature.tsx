import { useState, useMemo, useEffect } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { PostEditTool } from "../../store/mazeStore";
import { buttonStyle } from "../../styles/shared";
import { typography, muted, spacing } from "../../styles/theme";
import { ConfirmModal } from "../ConfirmModal";
import { Switch } from "../Switch";
import { IssuesBlock } from "../IssuesBlock";
import { Stack, Inline, Grid } from "../Layout";
import { StatusTag } from "../StatusTag";
import { ManageSplitNodesDialog } from "./ManageSplitNodesDialog";
import { resolveEndpoint, buildSplitNodeResolver } from "../../pixi/postEditEndpoint";
import * as m from "~/paraglide/messages";
import type React from "react";

function getEdgeTools(): [PostEditTool, string][] {
  return [
    ["wall",    m["post_edit.wall"]()],
    ["passage", m["post_edit.passage"]()],
    ["reset",   m["post_edit.reset"]()],
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

export function PostEditFeature() {
  const tool                = useMazeStore((s) => s.postEditTool);
  const setTool             = useMazeStore((s) => s.setPostEditTool);
  const autoConfirm         = useMazeStore((s) => s.postEditAutoConfirm);
  const setAutoConfirm      = useMazeStore((s) => s.setPostEditAutoConfirm);
  const postEditDraftEdges       = useMazeStore((s) => s.postEditDraftEdges);
  const confirmPostEdit     = useMazeStore((s) => s.confirmPostEdit);
  const resetPostEdit       = useMazeStore((s) => s.resetPostEdit);
  const postEditAnalytics   = useMazeStore((s) => s.postEditAnalytics);
  const postEditDraftMeta        = useMazeStore((s) => s.postEditDraftMeta);
  const nodes               = useMazeStore((s) => s.nodes);
  const postEditDraftSplitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  const postEditFocusedPoint = useMazeStore((s) => s.postEditFocusedPoint);
  const setPostEditFocusedPoint = useMazeStore((s) => s.setPostEditFocusedPoint);
  const openCard = useMazeStore((s) => s.openCard);

  // The "Manage split nodes" dialog closes when leaving the post-edit card — it has no meaning
  // once the user is looking at a different feature (see GitHub issue #221's plan, §6.2).
  useEffect(() => {
    if (openCard !== "post_edit" && postEditFocusedPoint !== null) {
      setPostEditFocusedPoint(null);
    }
  }, [openCard, postEditFocusedPoint, setPostEditFocusedPoint]);
  const clearPostEditEndpoint = useMazeStore((s) => s.clearPostEditEndpoint);
  const postEditDraftTeleports = useMazeStore((s) => s.postEditDraftTeleports);
  const postEditTeleportPendingFrom = useMazeStore((s) => s.postEditTeleportPendingFrom);
  const setPostEditTeleportPendingFrom = useMazeStore((s) => s.setPostEditTeleportPendingFrom);

  const nodeById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const pointNodeMap = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const nd of nodes) {
      const key = `${nd.x},${nd.y}`;
      const list = map.get(key);
      if (list) list.push(nd.id); else map.set(key, [nd.id]);
    }
    return map;
  }, [nodes]);
  const resolveSplit = useMemo(
    () => buildSplitNodeResolver(pointNodeMap, postEditDraftSplitPoints),
    [pointNodeMap, postEditDraftSplitPoints],
  );
  const start = postEditDraftMeta?.start != null ? resolveEndpoint(postEditDraftMeta.start, resolveSplit) ?? null : null;
  const finish = postEditDraftMeta?.finish != null ? resolveEndpoint(postEditDraftMeta.finish, resolveSplit) ?? null : null;
  const startNode = start !== null ? nodeById.get(start) : undefined;
  const finishNode = finish !== null ? nodeById.get(finish) : undefined;
  const pendingFromNode = postEditTeleportPendingFrom !== null ? nodeById.get(postEditTeleportPendingFrom) : undefined;

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
      </Stack>

      {(startNode || finishNode || pendingFromNode || postEditDraftTeleports.length > 0) && (
        <Stack gap="itemGap">
          {startNode && (
            <StatusTag onClear={() => clearPostEditEndpoint("start")}>
              {m["preset.start"]()}: {startNode.x},{startNode.y}
            </StatusTag>
          )}
          {finishNode && (
            <StatusTag onClear={() => clearPostEditEndpoint("finish")}>
              {m["preset.finish"]()}: {finishNode.x},{finishNode.y}
            </StatusTag>
          )}
          {pendingFromNode && (
            <StatusTag onClear={() => setPostEditTeleportPendingFrom(null)}>
              {m["preset.teleport_pending"]()}: {pendingFromNode.x},{pendingFromNode.y}
            </StatusTag>
          )}
          {postEditDraftTeleports.length > 0 && (
            <StatusTag>
              {postEditDraftTeleports.length === 1
                ? m["preset.teleports_count"]({ count: postEditDraftTeleports.length })
                : m["preset.teleports_count_plural"]({ count: postEditDraftTeleports.length })}
            </StatusTag>
          )}
        </Stack>
      )}

      <Inline gap="groupGap" justify="space-between">
        <span style={styles.autoConfirmLabel}>{m["post_edit.auto_confirm"]()}</span>
        <Switch checked={autoConfirm} onChange={setAutoConfirm} />
      </Inline>
      <span style={styles.hint}>{m["post_edit.auto_confirm_hint"]()}</span>

      <button
        className="hoverable-accent"
        style={{ ...buttonStyle("primary"), width: "100%" }}
        disabled={autoConfirm || !hasEdges}
        onClick={() => void confirmPostEdit()}
      >
        {m["post_edit.confirm"]()}
      </button>

      <button
        className="hoverable-danger"
        style={{ ...buttonStyle("destructive"), width: "100%" }}
        onClick={() => setConfirmReset(true)}
      >
        {m["post_edit.reset_to_generation"]()}
      </button>

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
