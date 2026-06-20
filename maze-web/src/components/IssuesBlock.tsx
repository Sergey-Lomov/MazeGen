import { useState } from "react";
import { colors, font } from "../styles/theme";
import { sharedStyles } from "../styles/shared";
import { Modal } from "./Modal";
import * as m from "~/paraglide/messages";
import type React from "react";

type IssueInfo = { label: string; description: string };

const KNOWN_ISSUES: Record<string, () => IssueInfo> = {
  missing_endpoints: () => ({ label: m["issue.missing_endpoints.label"](), description: m["issue.missing_endpoints.description"]() }),
  unreachable_finish: () => ({ label: m["issue.unreachable_finish.label"](), description: m["issue.unreachable_finish.description"]() }),
  min_loops_count: () => ({ label: m["issue.min_loops_count.label"](), description: m["issue.min_loops_count.description"]() }),
};

function resolveIssue(kind: string): IssueInfo {
  return KNOWN_ISSUES[kind]?.() ?? { label: kind, description: "" };
}

export function IssueBubble({ kind }: { kind: string }) {
  const [open, setOpen] = useState(false);
  const { label, description } = resolveIssue(kind);
  return (
    <>
      <div
        style={{ ...issueStyles.bubble, ...(description ? issueStyles.bubbleClickable : {}) }}
        onClick={description ? () => setOpen(true) : undefined}
      >
        <span style={issueStyles.label}>{label}</span>
        {description && <span style={issueStyles.infoIcon}>ℹ</span>}
      </div>
      {open && (
        <Modal title={label} onClose={() => setOpen(false)}>
          <p style={issueStyles.description}>{description}</p>
        </Modal>
      )}
    </>
  );
}

export function IssuesBlock({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <>
      <div style={sharedStyles.sectionHeader}>{m["analytics.issues"]()}</div>
      <div style={issueStyles.block}>
        {warnings.map((w, i) => (
          <IssueBubble key={i} kind={w} />
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
    background: colors.bgWarning,
    border: `1px solid ${colors.textWarning}`,
    borderRadius: 6,
    padding: "4px 8px",
  },
  bubbleClickable: {
    cursor: "pointer",
  },
  label: { flex: 1, fontSize: font.sm, color: colors.textWarning, lineHeight: 1.4 },
  infoIcon: { color: colors.textWarning, fontSize: font.xl, flexShrink: 0, lineHeight: 1 },
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
