import { useState } from "react";
import { ui, typography, muted, spacing } from "../styles/theme";
import { Modal } from "./Modal";
import { useMazeStore } from "../store/mazeStore";
import { resolveIssue, resolveIssueSourceLabel, resolveIssueSourceDescription, presetLockElementsFor, TILE_GRANULARITY_CHECKS } from "./issueRegistry";
import { embeddedNotificationStyle, notificationPalette } from "./EmbeddedNotification";
import { SectionHeader } from "./SectionHeader";
import { ToggleRow } from "./ToggleRow";
import * as m from "~/paraglide/messages";
import type React from "react";
import type { IssueDto, IssueEdgeGroupPayload } from "../wasm/types";

/// Whether every element in `elements` (this bubble's own source-check slice, from
/// `presetLockElementsFor`) is `preset_locked` -- GitHub issue #245. `null`/empty resolves
/// `false`: a bubble with no preset-lock data at all (a kind with no source check, e.g.
/// `cycle_analysis_overflowed`) is never "fully preset-locked" by this check, it just doesn't
/// participate in the toggle.
function isFullyPresetLocked(elements: { preset_locked: boolean }[] | null): boolean {
  return elements != null && elements.length > 0 && elements.every((e) => e.preset_locked);
}

/// Collapses a two-way teleport's opposite-direction groups into one -- each direction of a
/// two-way teleport is its own base-graph `Teleport` edge, so the Rust side's per-edge grouping
/// (`resolve_single_edge_map`) reports it as two separate one-edge groups, keyed by the same
/// unordered endpoint pair. Only used for counting "how many teleport instances" (the preset-
/// locked summary phrase) -- a two-way teleport is one logical instance to the user, not two. Same
/// dedup rationale as `buildTeleportEdges`'s own opposite-direction collapsing (`mazeSelectors.ts`)
/// -- a pair only counts as locked if *both* directions are (a one-way-locked pair still means the
/// teleport as a whole is only partly preset-protected, so repair could still act on it).
function dedupTeleportGroups(groups: IssueEdgeGroupPayload[]): IssueEdgeGroupPayload[] {
  const byPair = new Map<string, IssueEdgeGroupPayload[]>();
  for (const g of groups) {
    const [from, to] = g.edges[0] ?? [];
    if (from === undefined || to === undefined) continue;
    const key = from < to ? `${from},${to}` : `${to},${from}`;
    const list = byPair.get(key);
    if (list) list.push(g); else byPair.set(key, [g]);
  }
  return Array.from(byPair.values()).map((pair) => ({
    edges: pair.flatMap((g) => g.edges),
    preset_locked: pair.every((g) => g.preset_locked),
  }));
}

export function IssueBubble({ issue, sourceCheck }: { issue: IssueDto; sourceCheck: string | null }) {
  const [open, setOpen] = useState(false);
  const setHoveredIssueLoopEdges = useMazeStore((s) => s.setHoveredIssueLoopEdges);
  const setHoveredIssueRegionGroups = useMazeStore((s) => s.setHoveredIssueRegionGroups);
  const showFullyPresetLockedIssues = useMazeStore((s) => s.showFullyPresetLockedIssues);
  const { severity } = resolveIssue(issue.kind);
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
  // Per-check description override (GitHub issue #257's teleport_split_intersection, whose
  // behavior diverges from invalid_teleport's generic wording) — same rationale as `label` above.
  const description = resolveIssueSourceDescription(issue.kind, typeId);
  // Only this bubble's own source check's cycles — not every contributing check's cycles
  // combined (see `IssuePayloadDto`'s doc comment). Each element also carries `preset_locked`
  // (GitHub issue #245) — whether every edge of that specific cycle/group is a user-placed
  // preset connection, so repair can never fix it.
  const loopGroups = sourceCheck != null && issue.payload.kind === "invalid_loop"
    ? issue.payload.edges[sourceCheck] ?? null
    : null;
  // `invalid_teleport`/`invalid_teleport_group` share the same `invalid_teleport` payload shape
  // (a single flagged teleport is a group of size one — see `IssuePayloadDto`'s doc comment) —
  // flattened and rendered through the same edge-highlight path as `loopGroups`, no dedicated
  // renderer needed.
  const teleportGroups = sourceCheck != null && issue.payload.kind === "invalid_teleport"
    ? issue.payload.groups[sourceCheck] ?? null
    : null;
  // `invalid_one_way`/`invalid_one_way_group`/`invalid_split_node_connection_group` share the
  // same `invalid_one_way` payload shape (a single flagged one-way is a group of size one, and
  // `invalid_split_node_connection_group` reuses this wire variant too — see `IssuePayloadDto`'s
  // doc comment; narrowing is on `payload.kind`, not `issue.kind`, so this branch already covers
  // all three) — flattened and rendered through the same edge-highlight path as
  // `loopGroups`/`teleportGroups`, no dedicated renderer needed.
  const oneWayGroups = sourceCheck != null && issue.payload.kind === "invalid_one_way"
    ? issue.payload.groups[sourceCheck] ?? null
    : null;
  // Same per-check isolation as `loopGroups` above — only this bubble's own source check's
  // flagged regions, not every contributing check's regions combined. Covers both
  // `region_needs_expansion` (undersized) and `region_needs_shrink` (oversized) — both highlight
  // the same way, just flagged for opposite reasons.
  const regionNodes = sourceCheck != null && (issue.payload.kind === "region_needs_expansion" || issue.payload.kind === "region_needs_shrink")
    ? issue.payload.nodes[sourceCheck] ?? null
    : null;
  // `invalid_split_tile`'s payload is one entry per flagged "instance" (a single tile, or a
  // genuine multi-tile group for proximity/count/density checks — see `IssueSplitGroupPayload`'s
  // doc comment on the Rust side).
  const splitGroups = sourceCheck != null && issue.payload.kind === "invalid_split_tile"
    ? issue.payload.groups[sourceCheck] ?? null
    : null;
  // `invalid_split_route`'s payload is one entry per route, each carrying its own ordered
  // {from, to, is_split_edge} edge list plus a route-level `preset_locked`.
  const splitRoutePayload = sourceCheck != null && issue.payload.kind === "invalid_split_route"
    ? issue.payload.routes[sourceCheck] ?? null
    : null;
  const palette = notificationPalette(severity);

  // GitHub issue #245: this bubble's own source-check slice of the payload, reduced to just the
  // `preset_locked` flag per element -- covers EVERY payload kind uniformly (including kinds with
  // no per-element highlight data of their own, like `excessive_scc_count`, wrapped by
  // `presetLockElementsFor` as a one-element array). Single source of truth for "hide this bubble"
  // (`fullyPresetLocked` below) and "how many are locked" (`presetLockedCount` below) --
  // deliberately NOT re-derived per payload kind the way `loopGroups`/`teleportGroups`/etc. above
  // are (those exist only for their own highlight-specific shape), so a newly added payload kind
  // only needs a branch in `presetLockElementsFor` itself to participate correctly in both.
  const presetLockedElements = sourceCheck != null ? presetLockElementsFor(issue, sourceCheck) : null;

  // Hide a bubble only when every one of its own preset-lockable elements is preset_locked (the
  // issue is genuinely, entirely unfixable by design, not merely unrepaired). A bubble with at
  // least one unlocked element (or no preset-lock data at all, e.g. region kinds) is unaffected by
  // this toggle.
  const fullyPresetLocked = isFullyPresetLocked(presetLockedElements);
  if (fullyPresetLocked && !showFullyPresetLockedIssues) {
    return null;
  }

  // When the toggle is off, a bubble that survives (has at least one unlocked element) must only
  // highlight its unlocked elements on hover -- a preset-locked element hidden from view by the
  // toggle must not still light up on the canvas. Applied identically across every preset-lockable
  // kind (loop/teleport/one-way/split-tile/split-route/region — confirmed with the user, no
  // asymmetry). `RegionHighlightRenderer` draws each group independently with no positional
  // contract, so filtering out locked regions before mapping to `.region` is safe.
  const visibleGroup = (e: { preset_locked: boolean }) => showFullyPresetLockedIssues || !e.preset_locked;
  const loopEdges = loopGroups?.filter(visibleGroup).flatMap((g) => g.edges) ?? null;
  const teleportEdges = teleportGroups?.filter(visibleGroup).flatMap((g) => g.edges) ?? null;
  const oneWayEdges = oneWayGroups?.filter(visibleGroup).flatMap((g) => g.edges) ?? null;
  // Renders every visible tile as its own region-highlight group (one fill+perimeter per distinct
  // tile, `RegionHighlightRenderer`'s per-point dedup) -- visibility is decided at whichever
  // granularity `TILE_GRANULARITY_CHECKS` selects (tile-level for max_split_count/max_split_density,
  // group-level for everything else), so a locked tile within an otherwise-visible proximity pair
  // still hides only when the *whole pair* is locked, while a locked tile in a max_split_count
  // bundle hides on its own.
  const splitTileNodes = splitGroups != null
    ? splitGroups.flatMap((g) =>
        TILE_GRANULARITY_CHECKS.has(typeId)
          ? g.tiles.filter(visibleGroup).map((t) => t.nodes)
          : visibleGroup(g) ? g.tiles.map((t) => t.nodes) : []
      )
    : null;
  const splitRouteEdges = splitRoutePayload != null
    ? [splitRoutePayload.filter(visibleGroup).flatMap((r) => r.edges).map((e) => [e.from, e.to] as [number, number])]
    : null;
  const visibleRegionGroups = regionNodes != null
    ? regionNodes.filter(visibleGroup).map((r) => r.region)
    : null;

  const handleMouseEnter = loopEdges != null
    ? () => setHoveredIssueLoopEdges(loopEdges)
    : teleportEdges != null
    ? () => setHoveredIssueLoopEdges(teleportEdges)
    : oneWayEdges != null
    ? () => setHoveredIssueLoopEdges(oneWayEdges)
    : splitRouteEdges != null
    ? () => setHoveredIssueLoopEdges(splitRouteEdges.flat())
    : visibleRegionGroups != null
    ? () => setHoveredIssueRegionGroups(visibleRegionGroups)
    : splitTileNodes != null
    ? () => setHoveredIssueRegionGroups(splitTileNodes)
    : undefined;
  const handleMouseLeave = loopEdges != null || teleportEdges != null || oneWayEdges != null || splitRouteEdges != null
    ? () => setHoveredIssueLoopEdges(null)
    : visibleRegionGroups != null || splitTileNodes != null
    ? () => setHoveredIssueRegionGroups(null)
    : undefined;

  // GitHub issue #245 (extended to node/route-based split kinds): count of this bubble's own
  // elements that are preset-locked, shown in the modal body as one summary phrase ("N instances
  // are set by presets and cannot be fixed") when at least one is locked. A per-element list was
  // tried first but read as noisy busywork once a bubble carried more than a couple of elements —
  // the user only needs to know how many, not enumerate every single one.
  //
  // `teleportGroups` needs a dedup pass before counting: a two-way teleport is two directed
  // `EdgeKind::Teleport` edges in the base graph (`resolve_single_edge_map` on the Rust side
  // treats every directed edge as its own group), so it arrives here as two separate one-edge
  // groups — the *same* teleport counted twice. Collapsed by unordered endpoint pair, same
  // rationale as `buildTeleportEdges`'s own opposite-direction dedup (`mazeSelectors.ts`). Every
  // other kind's elements are already one logical unit per element, never split across two
  // directions, so `presetLockedElements` (computed above) is used as-is for the rest.
  const dedupedElements = teleportGroups != null
    ? dedupTeleportGroups(teleportGroups)
    : presetLockedElements;
  const presetLockedCount = dedupedElements?.filter((el) => el.preset_locked).length ?? 0;

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
          {presetLockedCount > 0 && (
            <p style={issueStyles.presetLockedSummary}>
              {presetLockedCount === 1
                ? m["issue.preset_locked_summary"]({ count: presetLockedCount })
                : m["issue.preset_locked_summary_plural"]({ count: presetLockedCount })}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}

export function IssuesBlock({ issues }: { issues: IssueDto[] }) {
  const showFullyPresetLockedIssues = useMazeStore((s) => s.showFullyPresetLockedIssues);
  const setShowFullyPresetLockedIssues = useMazeStore((s) => s.setShowFullyPresetLockedIssues);
  const sectionsExpanded = useMazeStore((s) => s.analyticsSectionsExpanded);
  const setAnalyticsSectionExpanded = useMazeStore((s) => s.setAnalyticsSectionExpanded);
  if (issues.length === 0) return null;
  const expanded = sectionsExpanded["issues"] ?? false;
  // One bubble per contributing check, not per issue -- a merged `invalid_loop` issue can carry
  // both `min_loop_length` and `max_loop_length` at once, and each reads as a distinct, specific
  // message (see `resolveIssueSourceLabel`). An issue with no source check (e.g.
  // `cycle_analysis_overflowed`, not a toggleable check) renders as a single generic bubble.
  // `IssueBubble` itself returns `null` when `showFullyPresetLockedIssues` is off and every one
  // of its own edge-group elements is preset_locked (GitHub issue #245).
  const bubbles = issues.flatMap((issue, i) =>
    issue.source_checks.length > 0
      ? issue.source_checks.map((sourceCheck) => (
          <IssueBubble key={`${i}-${sourceCheck}`} issue={issue} sourceCheck={sourceCheck} />
        ))
      : [<IssueBubble key={i} issue={issue} sourceCheck={null} />]
  );
  return (
    <>
      {/* Issues block — same collapsible-section shape as every other Analytics block (GitHub
        * issue #245's follow-up: it used to be a bespoke header, out of step with the rest of the
        * feature card). */}
      <SectionHeader
        label={m["analytics.issues"]()}
        expanded={expanded}
        onToggle={() => setAnalyticsSectionExpanded("issues", !expanded)}
      />
      {expanded && (
        <div style={issueStyles.block}>
          <ToggleRow
            label={m["issue.fully_preset_locked_toggle_label"]()}
            checked={showFullyPresetLockedIssues}
            onChange={setShowFullyPresetLockedIssues}
          />
          {bubbles}
        </div>
      )}
      <div style={issueStyles.divider} />
    </>
  );
}

const issueStyles: Record<string, React.CSSProperties> = {
  block: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
  },
  bubble: {
    ...embeddedNotificationStyle,
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
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
  presetLockedSummary: {
    margin: `${spacing.itemGap}px 0 0`,
    ...muted(typography.body),
    lineHeight: 1.5,
  },
  divider: {
    borderTop: `1px solid`,
    borderColor: ui.border.default,
    margin: `${spacing.itemGap}px 0`,
  },
};
