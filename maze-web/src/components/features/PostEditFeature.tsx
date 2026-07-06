import { useState, useMemo } from "react";
import { X } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { PostEditTool } from "../../store/mazeStore";
import { buttonStyle } from "../../styles/shared";
import { ui, typography, muted } from "../../styles/theme";
import { ConfirmModal } from "../ConfirmModal";
import { Switch } from "../Switch";
import { IssuesBlock } from "../IssuesBlock";
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
  const start  = postEditDraftMeta?.start ?? null;
  const finish = postEditDraftMeta?.finish ?? null;
  const clearPostEditEndpoint = useMazeStore((s) => s.clearPostEditEndpoint);
  const postEditDraftTeleports = useMazeStore((s) => s.postEditDraftTeleports);
  const postEditTeleportPendingFrom = useMazeStore((s) => s.postEditTeleportPendingFrom);
  const setPostEditTeleportPendingFrom = useMazeStore((s) => s.setPostEditTeleportPendingFrom);

  const nodeById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const startNode = start !== null ? nodeById.get(start) : undefined;
  const finishNode = finish !== null ? nodeById.get(finish) : undefined;
  const pendingFromNode = postEditTeleportPendingFrom !== null ? nodeById.get(postEditTeleportPendingFrom) : undefined;

  const [confirmReset, setConfirmReset] = useState(false);

  const hasEdges = postEditDraftEdges !== null;

  return (
    <div style={styles.root}>
      {postEditAnalytics && <IssuesBlock issues={postEditAnalytics.issues} />}
      <span style={styles.sectionLabel}>{m["preset.edges_tools"]()}</span>
      <div style={styles.toolGrid}>
        {getEdgeTools().map(([t, label]) => (
          <button
            key={t}
            style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
      </div>
      <span style={styles.sectionLabel}>{m["preset.vertex_tools"]()}</span>
      <div style={styles.vertexToolGrid}>
        {getTeleportTools().map(([t, label]) => (
          <button
            key={t}
            style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
        <div style={styles.startFinishRow}>
          {getVertexTools().map(([t, label]) => (
            <button
              key={t}
              style={buttonStyle(tool === t ? "toggle-active" : "toggle")}
              onClick={() => setTool(t)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {(startNode || finishNode || pendingFromNode || postEditDraftTeleports.length > 0) && (
        <div style={styles.statusBlock}>
          {startNode && (
            <div style={styles.statusBubble}>
              <span>{m["preset.start"]()}: {startNode.x},{startNode.y}</span>
              <button style={styles.clearTag} onClick={() => clearPostEditEndpoint("start")}><X size={16} /></button>
            </div>
          )}
          {finishNode && (
            <div style={styles.statusBubble}>
              <span>{m["preset.finish"]()}: {finishNode.x},{finishNode.y}</span>
              <button style={styles.clearTag} onClick={() => clearPostEditEndpoint("finish")}><X size={16} /></button>
            </div>
          )}
          {pendingFromNode && (
            <div style={styles.statusBubble}>
              <span>{m["preset.teleport_pending"]()}: {pendingFromNode.x},{pendingFromNode.y}</span>
              <button style={styles.clearTag} onClick={() => setPostEditTeleportPendingFrom(null)}><X size={16} /></button>
            </div>
          )}
          {postEditDraftTeleports.length > 0 && (
            <div style={styles.statusBubble}>
              <span>{postEditDraftTeleports.length === 1
                ? m["preset.teleports_count"]({ count: postEditDraftTeleports.length })
                : m["preset.teleports_count_plural"]({ count: postEditDraftTeleports.length })}</span>
            </div>
          )}
        </div>
      )}

      <div style={styles.autoConfirmRow}>
        <span style={styles.autoConfirmLabel}>{m["post_edit.auto_confirm"]()}</span>
        <Switch checked={autoConfirm} onChange={setAutoConfirm} />
      </div>
      <span style={styles.hint}>{m["post_edit.auto_confirm_hint"]()}</span>

      <button
        style={{ ...buttonStyle("primary"), width: "100%" }}
        disabled={autoConfirm || !hasEdges}
        onClick={() => void confirmPostEdit()}
      >
        {m["post_edit.confirm"]()}
      </button>

      <button
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
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: 8 },
  sectionLabel: {
    ...typography.body,
    marginTop: 8,
  },
  toolGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 },
  vertexToolGrid: { display: "grid", gridTemplateColumns: "1fr", gap: 4 },
  startFinishRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 },
  autoConfirmRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    ...typography.caption,
  },
  autoConfirmLabel: {
    ...muted(typography.body),
  },
  hint: {
    ...typography.caption,
    marginTop: -4,
  },
  statusBlock: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  statusBubble: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    ...typography.caption,
    background: ui.bg.input,
    borderRadius: 4,
    padding: "6px 8px",
  },
  clearTag: {
    ...muted(typography.icon),
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "0 2px",
    lineHeight: 1,
    display: "flex",
  },
};
