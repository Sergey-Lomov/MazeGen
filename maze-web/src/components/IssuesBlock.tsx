import { useState } from "react";
import { ui, typography, muted } from "../styles/theme";
import { sharedStyles } from "../styles/shared";
import { Modal } from "./Modal";
import { useMazeStore } from "../store/mazeStore";
import { resolveIssue, resolveIssueSourceLabel } from "./issueRegistry";
import { embeddedNotificationStyle, notificationPalette } from "./EmbeddedNotification";
import * as m from "~/paraglide/messages";
import type React from "react";
import type { IssueDto } from "../wasm/types";

export function IssueBubble({ issue, sourceCheck }: { issue: IssueDto; sourceCheck: string | null }) {
  const [open, setOpen] = useState(false);
  const setHoveredIssueLoopEdges = useMazeStore((s) => s.setHoveredIssueLoopEdges);
  const setHoveredIssueRegionGroups = useMazeStore((s) => s.setHoveredIssueRegionGroups);
  const { description, severity } = resolveIssue(issue.kind);
  // No source check (e.g. `cycle_analysis_overflowed`, `repair_limit_reached` — neither is a
  // toggleable `Check<T>`) still checks `details` under the issue's own kind string — the only
  // way an issue without a check id can vary its label (see `repair_limit_reached`'s `limit`
  // detail, keyed this way in `build_analytics_snapshot`).
  const detailsKey = sourceCheck ?? issue.kind;
  const details = issue.details[detailsKey];
  // No source check -> fall back to the issue's own kind string as the DETAIL_LABELS key (e.g.
  // `repair_limit_reached`, not a toggleable `Check<T>` — see `issueRegistry.ts`'s doc comment
  // on that entry).
  const typeId = sourceCheck != null ? issue.source_check_types[sourceCheck] ?? sourceCheck : issue.kind;
  const label = resolveIssueSourceLabel(issue.kind, typeId, details);
  // Only this bubble's own source check's cycles — not every contributing check's cycles
  // combined (see `IssuePayloadDto`'s doc comment).
  const loopEdges = sourceCheck != null && issue.payload.kind === "invalid_loop"
    ? issue.payload.edges[sourceCheck] ?? null
    : null;
  // `invalid_teleport`/`invalid_teleport_group` share the same `invalid_teleport` payload shape
  // (a single flagged teleport is a group of size one — see `IssuePayloadDto`'s doc comment) —
  // flattened and rendered through the same edge-highlight path as `loopEdges`, no dedicated
  // renderer needed.
  const teleportEdges = sourceCheck != null && issue.payload.kind === "invalid_teleport"
    ? issue.payload.groups[sourceCheck] ?? null
    : null;
  // `invalid_one_way`/`invalid_one_way_group` share the same `invalid_one_way` payload shape (a
  // single flagged one-way is a group of size one — see `IssuePayloadDto`'s doc comment) —
  // flattened and rendered through the same edge-highlight path as `loopEdges`/`teleportEdges`,
  // no dedicated renderer needed.
  const oneWayEdges = sourceCheck != null && issue.payload.kind === "invalid_one_way"
    ? issue.payload.groups[sourceCheck] ?? null
    : null;
  // Same per-check isolation as `loopEdges` above — only this bubble's own source check's
  // flagged regions, not every contributing check's regions combined. Covers both
  // `region_needs_expansion` (undersized) and `region_needs_shrink` (oversized) — both highlight
  // the same way, just flagged for opposite reasons.
  const regionNodes = sourceCheck != null && (issue.payload.kind === "region_needs_expansion" || issue.payload.kind === "region_needs_shrink")
    ? issue.payload.nodes[sourceCheck] ?? null
    : null;
  const palette = notificationPalette(severity);

  const handleMouseEnter = loopEdges != null
    ? () => setHoveredIssueLoopEdges(loopEdges.flat())
    : teleportEdges != null
    ? () => setHoveredIssueLoopEdges(teleportEdges.flat())
    : oneWayEdges != null
    ? () => setHoveredIssueLoopEdges(oneWayEdges.flat())
    : regionNodes != null
    ? () => setHoveredIssueRegionGroups(regionNodes)
    : undefined;
  const handleMouseLeave = loopEdges != null || teleportEdges != null || oneWayEdges != null
    ? () => setHoveredIssueLoopEdges(null)
    : regionNodes != null
    ? () => setHoveredIssueRegionGroups(null)
    : undefined;

  return (
    <>
      <div
        className={description ? "hoverable-tint" : undefined}
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
    ...embeddedNotificationStyle,
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  bubbleClickable: {
    cursor: "default",
  },
  label: { flex: 1, ...typography.body, lineHeight: 1.4 },
  infoIcon: { ...typography.icon, flexShrink: 0, lineHeight: 1 },
  description: {
    margin: 0,
    ...muted(typography.body),
    lineHeight: 1.5,
  },
  divider: {
    borderTop: `1px solid`,
    borderColor: ui.border.default,
    margin: "4px 0",
  },
};
