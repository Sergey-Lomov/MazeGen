import type React from "react";
import { ui, typography, muted, disabled, spacing, indent, dialogSpacing } from "../../styles/theme";
import * as m from "~/paraglide/messages";

const SPLIT_PATTERN_TITLES: Record<string, () => string> = {
  "split_pattern_title.split_fork": () => m["split_pattern_title.split_fork"](),
  "split_pattern_title.bridge": () => m["split_pattern_title.bridge"](),
  "split_pattern_title.diagonal_divider": () => m["split_pattern_title.diagonal_divider"](),
  "split_pattern_title.double_bridge": () => m["split_pattern_title.double_bridge"](),
  "split_pattern_title.triple_corridor": () => m["split_pattern_title.triple_corridor"](),
};

export function messageFor(key: string): string {
  return SPLIT_PATTERN_TITLES[key]();
}

export const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  statBlock: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  statRow: { display: "flex", alignItems: "center", gap: spacing.itemGap },
  statLabel: { flex: 1, ...muted(typography.body) },
  statCount: { ...typography.caption, minWidth: 32, textAlign: "right" },
  statPct: { ...disabled(typography.body), minWidth: 44, textAlign: "right" },
  scoreRow: { display: "flex", alignItems: "center", gap: spacing.itemGap },
  // `rawBody` layout (see `TimingDetailedReportModal`) — the header row sits outside the
  // scrolling area so only the tree itself scrolls when the report is tall, and the two root
  // nodes ("Initial generation"/"Quality control") stack with no gap between them, matching every
  // other row-to-row gap in the tree.
  timingReportRoot: { display: "flex", flexDirection: "column" as const, flex: 1, minHeight: 0 },
  timingReportScroll: { flex: 1, overflowY: "auto" as const, minHeight: 0, padding: `0 ${dialogSpacing.paddingX}px ${dialogSpacing.bodyPadding}px` },
  timingReportHeader: {
    display: "flex", alignItems: "center", gap: spacing.groupGap, flexShrink: 0,
    padding: `${dialogSpacing.bodyPadding}px ${dialogSpacing.paddingX}px ${spacing.itemGap}px`,
    borderBottom: `1px solid ${ui.border.default}`,
    ...disabled(typography.body),
  },
  // One node's own row plus its children wrapper, stacked with no gap — rows must sit flush
  // against each other with no gap of their own — the taller row height below (via padding, not
  // a gap) is what gives the table breathing room instead.
  timingReportNode: { display: "flex", flexDirection: "column" as const },
  timingReportRow: {
    display: "flex", alignItems: "center", gap: spacing.groupGap, minHeight: 20,
    padding: `${spacing.itemGap}px 0 ${spacing.itemGap}px ${spacing.groupGap}px`,
    borderRadius: 3,
  },
  // Mirrors `NestedStrategyPanel`'s `entryStackWithWeight` — one continuous vertical line down
  // the left of a node's *entire* children block (not one dashed segment per row), ties every
  // descendant row visually to the parent it's nested under.
  timingReportChildren: {
    display: "flex", flexDirection: "column" as const,
    borderLeft: `1px solid ${ui.border.default}`, marginLeft: spacing.groupGap, paddingLeft: indent.tree - spacing.groupGap,
  },
  timingReportLabel: { flex: 1, ...typography.body, minWidth: 0, overflowWrap: "break-word" as const },
  timingReportCalls: { ...typography.caption, minWidth: 48, textAlign: "center" as const },
  timingReportMs: { ...typography.caption, minWidth: 64, textAlign: "right" as const },
  timingReportPct: { ...typography.caption, minWidth: 56, textAlign: "right" as const },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
  panelBody: { display: "flex", flexDirection: "column", gap: spacing.itemGap, padding: dialogSpacing.bodyPadding },
  // One indentation level for a nested section's own content, relative to its `SectionHeader` —
  // `report_general`/`report_by_floors` -> subsection -> stat rows is 2 levels deep at most.
  statGroup: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  nestedGroup: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  floorSectionBody: { paddingBottom: 8 },
  subsectionHeaderRow: { display: "flex", alignItems: "center", gap: spacing.itemGap },
  toggleBlock: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  legendRow: { display: "flex", alignItems: "center", gap: spacing.groupGap },
  legendSwatch: { width: 14, height: 14, borderRadius: 3, flexShrink: 0 },
  legendLabel: { ...typography.body, fontWeight: "bold" as const },
  legendDesc: { ...muted(typography.body) },
  patternStatsButton: { width: "100%", boxSizing: "border-box" as const, marginTop: spacing.itemGap },
  patternStatsList: { display: "flex", flexDirection: "column", gap: spacing.groupGap },
  patternStatsRow: {
    display: "flex", alignItems: "center", gap: spacing.groupGap,
    padding: spacing.itemGap, border: `1px solid ${ui.border.default}`, borderRadius: 6,
  },
  previewTile: { width: 56, height: 56, flexShrink: 0 },
  patternStatsInfo: { flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  patternStatsTitle: { ...typography.body, fontWeight: "bold" as const },
};
