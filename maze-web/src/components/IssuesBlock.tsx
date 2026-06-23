import { useState } from "react";
import { colors, font } from "../styles/theme";
import { sharedStyles } from "../styles/shared";
import { Modal } from "./Modal";
import { useMazeStore } from "../store/mazeStore";
import { resolveIssue } from "./issueRegistry";
import * as m from "~/paraglide/messages";
import type React from "react";
import type { IssueDto } from "../wasm/types";

export function IssueBubble({ issue }: { issue: IssueDto }) {
  const [open, setOpen] = useState(false);
  const setHoveredIssueLoopEdges = useMazeStore((s) => s.setHoveredIssueLoopEdges);
  const { label, description, severity } = resolveIssue(issue.kind);
  const loopEdges = issue.short_loop_edges;
  const palette = severity === "critical"
    ? { bg: colors.bgError, text: colors.textError }
    : { bg: colors.bgWarning, text: colors.textWarning };

  const handleMouseEnter = loopEdges != null
    ? () => setHoveredIssueLoopEdges(loopEdges.flat())
    : undefined;
  const handleMouseLeave = loopEdges != null
    ? () => setHoveredIssueLoopEdges(null)
    : undefined;

  return (
    <>
      <div
        style={{
          ...issueStyles.bubble,
          background: palette.bg,
          borderColor: palette.text,
          ...(description ? issueStyles.bubbleClickable : {}),
        }}
        onClick={description ? () => setOpen(true) : undefined}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <span style={{ ...issueStyles.label, color: palette.text }}>{label}</span>
        {description && <span style={{ ...issueStyles.infoIcon, color: palette.text }}>ℹ</span>}
      </div>
      {open && (
        <Modal title={label} onClose={() => setOpen(false)}>
          <p style={issueStyles.description}>{description}</p>
        </Modal>
      )}
    </>
  );
}

export function IssuesBlock({ issues }: { issues: IssueDto[] }) {
  if (issues.length === 0) return null;
  return (
    <>
      <div style={sharedStyles.sectionHeader}>{m["analytics.issues"]()}</div>
      <div style={issueStyles.block}>
        {issues.map((issue, i) => (
          <IssueBubble key={i} issue={issue} />
        ))}
      </div>
      <div style={issueStyles.divider} />
    </>
  );
}

const issueStyles: Record<string, React.CSSProperties> = {
  block: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  bubble: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: 6,
    padding: "4px 8px",
  },
  bubbleClickable: {
    cursor: "pointer",
  },
  label: { flex: 1, fontSize: font.sm, lineHeight: 1.4 },
  infoIcon: { fontSize: font.xl, flexShrink: 0, lineHeight: 1 },
  description: {
    margin: 0,
    fontSize: font.md,
    color: colors.textMuted,
    lineHeight: 1.5,
  },
  divider: {
    borderTop: `1px solid`,
    borderColor: colors.borderMid,
    margin: "4px 0",
  },
};
