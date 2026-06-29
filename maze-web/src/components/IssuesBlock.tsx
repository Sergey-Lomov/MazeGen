import { useState } from "react";
import { ui, font } from "../styles/theme";
import { sharedStyles } from "../styles/shared";
import { Modal } from "./Modal";
import { useMazeStore } from "../store/mazeStore";
import { resolveIssue, resolveIssueSourceLabel } from "./issueRegistry";
import * as m from "~/paraglide/messages";
import type React from "react";
import type { IssueDto } from "../wasm/types";

export function IssueBubble({ issue, sourceCheck }: { issue: IssueDto; sourceCheck: string | null }) {
  const [open, setOpen] = useState(false);
  const setHoveredIssueLoopEdges = useMazeStore((s) => s.setHoveredIssueLoopEdges);
  const setHoveredIssueRegionGroups = useMazeStore((s) => s.setHoveredIssueRegionGroups);
  const rules = useMazeStore((s) => s.rules);
  const { description, severity } = resolveIssue(issue.kind);
  // No source check (e.g. `cycle_analysis_overflowed`, `repair_limit_reached` — neither is a
  // toggleable `Check<T>`) still checks `details` under the issue's own kind string — the only
  // way an issue without a check id can vary its label (see `repair_limit_reached`'s `limit`
  // detail, keyed this way in `build_analytics_snapshot`).
  const detailsKey = sourceCheck ?? issue.kind;
  let details = issue.details[detailsKey];
  // `qc_no_progress`'s `rule_ids` detail is core rule ids (opaque, e.g. "rule_6") — core has no
  // concept of the user-facing `name` the web store assigns each rule (`QcRuleState.name`), so
  // the substitution happens here, the only place with store access.
  if (issue.kind === "qc_no_progress" && details?.rule_ids !== undefined) {
    const names = details.rule_ids.split(", ").map((id) => rules.find((r) => r.id === id)?.name ?? id).join(", ");
    details = { ...details, rule_ids: names };
  }
  // No source check -> fall back to the issue's own kind string as the DETAIL_LABELS key (e.g.
  // `repair_limit_reached`/`qc_no_progress`, neither a toggleable `Check<T>` — see
  // `issueRegistry.ts`'s doc comment on those two entries).
  const typeId = sourceCheck != null ? issue.source_check_types[sourceCheck] ?? sourceCheck : issue.kind;
  const label = resolveIssueSourceLabel(issue.kind, typeId, details);
  // Only this bubble's own source check's cycles — not every contributing check's cycles
  // combined (see `IssueDto.invalid_loop_edges`'s doc comment).
  const loopEdges = sourceCheck != null ? issue.invalid_loop_edges[sourceCheck] ?? null : null;
  // Same per-check isolation as `loopEdges` above — only this bubble's own source check's
  // flagged regions, not every contributing check's regions combined.
  const regionNodes = sourceCheck != null ? issue.region_needs_expansion_nodes[sourceCheck] ?? null : null;
  const palette = severity === "critical"
    ? { bg: ui.bg.error, text: ui.text.error }
    : { bg: ui.bg.warning, text: ui.text.warning };

  const handleMouseEnter = loopEdges != null
    ? () => setHoveredIssueLoopEdges(loopEdges.flat())
    : regionNodes != null
    ? () => setHoveredIssueRegionGroups(regionNodes)
    : undefined;
  const handleMouseLeave = loopEdges != null
    ? () => setHoveredIssueLoopEdges(null)
    : regionNodes != null
    ? () => setHoveredIssueRegionGroups(null)
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
  // One bubble per contributing check, not per issue -- a merged `invalid_loop` issue can carry
  // both `min_loop_length` and `max_loop_length` at once, and each reads as a distinct, specific
  // message (see `resolveIssueSourceLabel`). An issue with no source check (e.g.
  // `cycle_analysis_overflowed`, not a toggleable check) renders as a single generic bubble.
  const bubbles = issues.flatMap((issue, i) =>
    issue.source_checks.length > 0
      ? issue.source_checks.map((sourceCheck) => (
          <IssueBubble key={`${i}-${sourceCheck}`} issue={issue} sourceCheck={sourceCheck} />
        ))
      : [<IssueBubble key={i} issue={issue} sourceCheck={null} />]
  );
  return (
    <>
      <div style={sharedStyles.sectionHeader}>{m["analytics.issues"]()}</div>
      <div style={issueStyles.block}>
        {bubbles}
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
    color: ui.text.secondary,
    lineHeight: 1.5,
  },
  divider: {
    borderTop: `1px solid`,
    borderColor: ui.border.default,
    margin: "4px 0",
  },
};
