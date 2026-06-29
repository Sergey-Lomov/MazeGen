import { useState, useMemo } from "react";
import { X } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { PostEditTool } from "../../store/mazeStore";
import { buttonStyle } from "../../styles/shared";
import { ui, font } from "../../styles/theme";
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

  const nodeById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const startNode = start !== null ? nodeById.get(start) : undefined;
  const finishNode = finish !== null ? nodeById.get(finish) : undefined;

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
      <div style={styles.toolGrid}>
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

      {(startNode || finishNode) && (
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
    fontSize: font.sm,
    color: ui.text.disabled,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  toolGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 },
  autoConfirmRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: font.sm,
    color: ui.text.tertiary,
  },
  autoConfirmLabel: {
    fontSize: font.sm,
    color: ui.text.secondary,
  },
  hint: {
    fontSize: 10,
    color: ui.text.disabled,
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
    fontSize: font.sm,
    color: ui.text.tertiary,
    background: ui.bg.input,
    borderRadius: 4,
    padding: "6px 8px",
  },
  clearTag: {
    background: "none",
    border: "none",
    color: ui.text.tertiary,
    cursor: "pointer",
    fontSize: font.md,
    padding: "0 2px",
    lineHeight: 1,
    display: "flex",
  },
};
