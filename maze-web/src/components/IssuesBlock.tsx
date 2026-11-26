import { useMemo, useState } from "react";
import { ui, typography, muted, spacing, indent } from "../styles/theme";
import { darken } from "../styles/palette";
import { Modal } from "./Modal";
import { useMazeStore } from "../store/mazeStore";
import "./features/nodeShapeVocabulary";
import { resolveIssue, resolveIssueSourceLabel, resolveIssueSourceDescription, presetLockElementsFor, TILE_GRANULARITY_CHECKS, isFullyPresetLocked } from "./issueRegistry";
import { resolveIssueHighlight, type NormalizedIssuePayload, type NormalizedEdgeGroup, type NormalizedRegionGroup } from "./issueHighlight";
import { embeddedNotificationStyle, notificationPalette } from "./EmbeddedNotification";
import { SectionHeader } from "./SectionHeader";
import { ToggleRow } from "./ToggleRow";
import { selectNodeLevelResolver } from "../domain/selectors/mazeSelectors";
import { FloorBadgeRow } from "./FloorBadgeRow";
import { ZoneIdChips } from "./features/ZoneProblemChips";
import { parseZoneScopeId } from "../domain/qcZoneScope";
import { zoneDisplayName, zoneGroupDisplayName } from "../domain/selectors/zoneSelectors";
import { nodeCoordinateTargets, type CoordinateWarning } from "../domain/coordinateWarning";
import * as m from "~/paraglide/messages";
import type React from "react";
import type { IssueDto, IssueEdgeGroupPayload } from "../wasm/types";
import type { IssueHighlightEdge } from "../store/postEditFullTypes";

/// Whether every element in `elements` (this bubble's own source-check slice, from
/// `presetLockElementsFor`) is `preset_locked` -- GitHub issue #245. `null`/empty resolves
/// `false`: a bubble with no preset-lock data at all (a kind with no source check, e.g.
/// `cycle_analysis_overflowed`) is never "fully preset-locked" by this check, it just doesn't
/// participate in the toggle.
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

/// Normalizes one `IssueEdgeGroupPayload`/`IssueRegionPayload` (DTO's snake_case shape) into
/// `resolveIssueHighlight`'s shared input shape (GitHub issue #623).
function toEdgeGroup(g: IssueEdgeGroupPayload): NormalizedEdgeGroup<number> {
  return { edges: g.edges };
}
function toRegionGroup(g: { region: number[]; preset_locked: boolean }): NormalizedRegionGroup<number> {
  return { nodes: g.region };
}

/// Highlight payload of an issue with no source check (raised by the engine, not by a `Check`):
/// today only `indeterminate_distance`, whose undecided pairs are pointed at on hover (GitHub issue
/// #838).
function normalizeSourcelessPayload(payload: IssueDto["payload"]): NormalizedIssuePayload<number> | null {
  if (payload.kind !== "indeterminate_distance") return null;
  return { kind: "indeterminateDistance", pairs: payload.pairs.map((p) => [p.nodes[0], p.nodes[1]] as [number, number]) };
}

export function IssueBubble({ issue, sourceCheck }: { issue: IssueDto; sourceCheck: string | null }) {
  const [open, setOpen] = useState(false);
  const setHoveredIssueLoopEdges = useMazeStore((s) => s.setHoveredIssueLoopEdges);
  const setHoveredCoordinateWarning = useMazeStore((s) => s.setHoveredCoordinateWarning);
  const nodes = useMazeStore((s) => s.nodes);
  const showFullyPresetLockedIssues = useMazeStore((s) => s.showFullyPresetLockedIssues);
  const scope = useIssueScope(issue.scope_id);
  const scopeLine = scope ? m[scope.kind === "zone" ? "issue.scope_zone" : "issue.scope_group"]({ name: scope.name }) : null;
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
  const description = resolveIssueSourceDescription(issue.kind, typeId, details);
  const palette = notificationPalette(severity);

  // GitHub issue #245: this bubble's own source-check slice of the payload, reduced to just the
  // `preset_locked` flag per element -- covers EVERY payload kind uniformly (including kinds with
  // no per-element highlight data of their own, like `excessive_scc_count`, wrapped by
  // `presetLockElementsFor` as a one-element array). Single source of truth for "hide this bubble"
  // (`fullyPresetLocked` below) and "how many are locked" (`presetLockedCount` below) --
  // deliberately NOT re-derived from `normalizedPayload` below (that exists only for its own
  // highlight-specific shape), so a newly added payload kind only needs a branch in
  // `presetLockElementsFor` itself to participate correctly in both.
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

  // Normalizes this bubble's own source-check slice of `issue.payload` into
  // `resolveIssueHighlight`'s shared input shape (GitHub issue #623) -- the toggle filter above is
  // applied here, per-kind, at the same granularity the old bespoke code used (e.g. cross-element
  // pairs filtered at pair granularity, split tiles filtered at tile granularity for
  // `TILE_GRANULARITY_CHECKS`), before handing normalized groups to the shared resolver.
  const normalizedPayload: NormalizedIssuePayload<number> | null = sourceCheck == null ? normalizeSourcelessPayload(issue.payload) : (() => {
    const payload = issue.payload;
    switch (payload.kind) {
      case "invalid_loop": {
        const groups = payload.edges[sourceCheck] ?? null;
        return groups == null ? null : { kind: "invalidLoop" as const, groups: groups.filter(visibleGroup).map(toEdgeGroup) };
      }
      case "invalid_teleport": {
        const groups = payload.groups[sourceCheck] ?? null;
        return groups == null ? null : { kind: "invalidTeleport" as const, groups: groups.filter(visibleGroup).map(toEdgeGroup) };
      }
      case "invalid_one_way": {
        const groups = payload.groups[sourceCheck] ?? null;
        return groups == null ? null : { kind: "invalidOneWay" as const, groups: groups.filter(visibleGroup).map(toEdgeGroup) };
      }
      case "invalid_vertical_passage": {
        const groups = payload.groups[sourceCheck] ?? null;
        return groups == null ? null : { kind: "invalidVerticalPassage" as const, groups: groups.filter(visibleGroup).map(toEdgeGroup) };
      }
      case "invalid_elevator": {
        const groups = payload.groups[sourceCheck] ?? null;
        return groups == null ? null : { kind: "invalidElevator" as const, groups: groups.filter(visibleGroup).map(toEdgeGroup) };
      }
      case "missing_elevator_stop_count": {
        const groups = payload.groups[sourceCheck] ?? null;
        return groups == null ? null : { kind: "missingElevatorStopCount" as const, groups: groups.filter(visibleGroup).map(toEdgeGroup) };
      }
      case "region_needs_expansion": {
        const nodes = payload.nodes[sourceCheck] ?? null;
        return nodes == null ? null : { kind: "regionNeedsExpansion" as const, groups: nodes.filter(visibleGroup).map(toRegionGroup) };
      }
      case "region_needs_shrink": {
        const nodes = payload.nodes[sourceCheck] ?? null;
        return nodes == null ? null : { kind: "regionNeedsShrink" as const, groups: nodes.filter(visibleGroup).map(toRegionGroup) };
      }
      case "invalid_elevator_stop": {
        const nodes = payload.nodes[sourceCheck] ?? null;
        return nodes == null ? null : { kind: "invalidElevatorStop" as const, groups: nodes.filter(visibleGroup).map(toRegionGroup) };
      }
      case "invalid_dead_end": {
        const nodes = payload.nodes[sourceCheck] ?? null;
        return nodes == null ? null : { kind: "invalidDeadEnd" as const, groups: nodes.filter(visibleGroup).map(toRegionGroup) };
      }
      case "violated_node_shape_limits":
        // Flat payload (one check produces it), so `sourceCheck` does not narrow anything.
        return { kind: "violatedNodeShapeLimits" as const, nodes: payload.violations.flatMap((i) => i.nodes) };
      case "invalid_split_tile": {
        const groups = payload.groups[sourceCheck] ?? null;
        if (groups == null) return null;
        // `invalid_split_tile`'s payload is one entry per flagged "instance" (a single tile, or a
        // genuine multi-tile group for proximity/count/density checks — see
        // `IssueSplitGroupPayload`'s doc comment on the Rust side). `TILE_GRANULARITY_CHECKS`
        // filters at tile granularity instead of group granularity (see that constant's doc
        // comment).
        const tiles = groups.flatMap((g) =>
          TILE_GRANULARITY_CHECKS.has(typeId) ? g.tiles.filter(visibleGroup) : visibleGroup(g) ? g.tiles : []
        );
        return { kind: "invalidSplitTile" as const, groups: [{ tiles: tiles.map((t) => ({ nodes: t.nodes })) }] };
      }
      case "invalid_split_route": {
        const routes = payload.routes[sourceCheck] ?? null;
        return routes == null ? null : { kind: "invalidSplitRoute" as const, edges: routes.filter(visibleGroup).flatMap((r) => r.edges).map((e) => [e.from, e.to] as [number, number]) };
      }
      case "invalid_cross_element_group": {
        // Preset visibility (issue #376 follow-up point 5) is all-or-nothing PER PAIR, not per
        // element: a pair is hidden only when every one of its members is preset_locked; a pair
        // with at least one unlocked member shows ALL its members, including the preset-locked one.
        // So the toggle filter is applied here at pair granularity, before flattening -- the
        // per-element `visibleGroup` filter used by every other kind is deliberately NOT applied to
        // these entries.
        const entries = payload.groups[sourceCheck]
          ?.filter((pair) => showFullyPresetLockedIssues || pair.some((e) => !e.preset_locked))
          .flat() ?? null;
        return entries == null ? null : {
          kind: "invalidCrossElementGroup" as const,
          entries: entries.map((e) => ({ kind: e.kind, edges: e.edges, nodes: e.nodes, tile: e.tile != null ? { nodes: e.tile.nodes } : null })),
        };
      }
      case "invalid_cross_element": {
        const entries = payload.elements[sourceCheck]?.filter(visibleGroup) ?? null;
        return entries == null ? null : {
          kind: "invalidCrossElementGroup" as const,
          entries: entries.map((e) => ({ kind: e.kind, edges: e.edges, nodes: e.nodes, tile: e.tile != null ? { nodes: e.tile.nodes } : null })),
        };
      }
      default:
        return null;
    }
  })();
  const resolved = normalizedPayload != null ? resolveIssueHighlight(normalizedPayload) : null;

  // Wall/line edges (`setHoveredIssueLoopEdges`) and flagged cells (the shared coordinate warning
  // layer) are independent overlay states -- `invalid_cross_element_group` can populate both at once
  // (a one-way member drawn as a wall alongside other members drawn as cells), so both are set
  // together. Every region-shaped result of `resolveIssueHighlight` (endpoint cells of a teleport/
  // vertical passage/elevator, regions, split tiles, dead ends, ...) becomes coordinate groups.
  const highlightEdges: IssueHighlightEdge[] | null = resolved?.cycle != null
    ? resolved.cycle.edges.map(([from, to]) => ({ from, to, asWall: resolved.cycle!.asWall, severity }))
    : null;
  // Each region group is one merged contour (split tiles drawn outward, `isSplit`, GitHub issue #619); a
  // singleton group (endpoint cell, dead end, ...) is the same contour of one cell.
  const coordinateWarning: CoordinateWarning | null = resolved?.region != null
    ? {
        severity,
        targets: nodeCoordinateTargets(resolved.region.groups.flatMap((g) => g.nodes), nodes),
        groups: resolved.region.groups.map((g) => ({ targets: nodeCoordinateTargets(g.nodes, nodes), outset: g.isSplit })),
      }
    : null;
  const hasHover = highlightEdges != null || coordinateWarning != null;
  const handleMouseEnter = hasHover
    ? () => {
        if (highlightEdges != null) setHoveredIssueLoopEdges(highlightEdges);
        if (coordinateWarning != null) setHoveredCoordinateWarning(coordinateWarning);
      }
    : undefined;
  const handleMouseLeave = hasHover
    ? () => {
        if (highlightEdges != null) setHoveredIssueLoopEdges(null);
        if (coordinateWarning != null) setHoveredCoordinateWarning(null);
      }
    : undefined;

  // GitHub issue #245 (extended to node/route-based split kinds): count of this bubble's own
  // elements that are preset-locked, shown in the modal body as one summary phrase ("N instances
  // are set by presets and cannot be fixed") when at least one is locked. A per-element list was
  // tried first but read as noisy busywork once a bubble carried more than a couple of elements —
  // the user only needs to know how many, not enumerate every single one.
  //
  // `invalid_teleport` needs a dedup pass before counting: a two-way teleport is two directed
  // `EdgeKind::Teleport` edges in the base graph (`resolve_single_edge_map` on the Rust side
  // treats every directed edge as its own group), so it arrives here as two separate one-edge
  // groups — the *same* teleport counted twice. Collapsed by unordered endpoint pair, same
  // rationale as `buildTeleportEdges`'s own opposite-direction dedup (`mazeSelectors.ts`). Every
  // other kind's elements are already one logical unit per element, never split across two
  // directions, so `presetLockedElements` (computed above) is used as-is for the rest.
  const teleportGroupsForCount = sourceCheck != null && issue.payload.kind === "invalid_teleport"
    ? issue.payload.groups[sourceCheck] ?? null
    : null;
  const dedupedElements = teleportGroupsForCount != null
    ? dedupTeleportGroups(teleportGroupsForCount)
    : presetLockedElements;
  const presetLockedCount = dedupedElements?.filter((el) => el.preset_locked).length ?? 0;

  // GitHub issue #365: every maze node id this bubble's own visible elements touch -- union of the
  // same resolved edge/region data `handleMouseEnter` above already isolates per bubble (only this
  // source check's visible elements, not every contributing check's combined). Used only to find
  // which *floors* the bubble spans; the actual hover highlight is unaffected by this.
  const touchedNodeIds = [
    ...(highlightEdges ?? []).flatMap((e) => [e.from, e.to]),
    ...(resolved?.region?.groups ?? []).flatMap((g) => g.nodes),
  ];

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
        <div style={issueStyles.bubbleTopRow}>
          <span style={{ ...issueStyles.label, color: palette.text }}>{label}</span>
          {description && <span style={{ ...issueStyles.infoIcon, color: palette.text }}>ℹ</span>}
        </div>
        {/* `hoverable-tint`'s brightness filter on the outer bubble div would also wash out these
          * badges' own deliberately fixed bg/text contrast -- `hoverable-tint-counter` cancels it
          * back out (inverse brightness, filters compose multiplicatively) so the badges stay
          * exactly as dark/light regardless of the parent bubble's hover state. */}
        <IssueScopeBadges
          scope={scope}
          nodeIds={touchedNodeIds}
          bg={darken(palette.text, 0.2)}
          text={palette.bg}
          className={description ? "hoverable-tint-counter" : undefined}
        />
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
          {scopeLine && <p style={issueStyles.scopeLine} data-testid="issue-scope-line">{scopeLine}</p>}
        </Modal>
      )}
    </>
  );
}

/// Row of solid `L{n}` badges inside a bubble, shown whenever the maze itself has more than one
/// floor (GitHub issue #365, extended by #423 to match the Preset Connections unreachable-split-node
/// warning's always-show-on-multi-floor behavior) -- a floor-scoped canvas highlight only shows
/// the active floor's own entities, so this is the one place a user can discover "this problem
/// also exists on floor 3" without switching floors themselves, even when the bubble's own
/// elements happen to sit on a single floor. `color` matches the parent bubble's own text color
/// (same as the label/info-icon), not a fixed hue. Distinct floor *indices* (`NodeDto.level ?? 0`,
/// the same convention `selectNodeLevelResolver`/`navigateToFloor` already use), not floor ids --
/// sorted ascending so the row always reads bottom-to-top regardless of `nodeIds`' own order.
/// Renders nothing on a single-floor maze, same as every other cross-floor indicator in the app.
function IssueFloorBadges({ nodeIds, bg, text, className }: { nodeIds: number[]; bg: string; text: string; className?: string }) {
  const nodes = useMazeStore((s) => s.nodes);
  // Memoized on `nodes` identity, not rebuilt per render -- `nodes` only changes on
  // generate/reset/load, while this component can re-render far more often (any store update
  // touching the Analytics panel), and rebuilding the full node->level Map per bubble per render
  // would be wasted work at scale (many issue bubbles x many nodes).
  const resolveNodeLevel = useMemo(() => selectNodeLevelResolver(nodes), [nodes]);
  const levels = Array.from(new Set([
    ...nodeIds.map((id) => resolveNodeLevel(id)).filter((l): l is number => l !== undefined),
  ])).sort((a, b) => a - b);
  return <FloorBadgeRow levels={levels} bg={bg} text={text} className={className} />;
}

type IssueScope = { kind: "zone" | "group"; id: number; name: string };

/// The zone or group an issue was found in (`IssueDto.scope_id`) with its display name; `null` without a scope or when
/// the zone or group no longer exists (deleted since the analytics snapshot).
function useIssueScope(scopeId: string | null | undefined): IssueScope | null {
  const zones = useMazeStore((s) => s.zones);
  const groups = useMazeStore((s) => s.zoneGroups);
  const floors = useMazeStore((s) => s.floors);
  const target = parseZoneScopeId(scopeId);
  if (target == null) return null;
  if (target.kind === "zone") {
    const zone = zones.find((z) => z.id === target.id);
    return zone ? { ...target, name: zoneDisplayName(zone, floors) } : null;
  }
  const group = groups.find((g) => g.id === target.id);
  return group ? { ...target, name: zoneGroupDisplayName(group) } : null;
}

/// Where an issue belongs (GitHub issue #1093): the zone or group its rule was limited to, as a zone
/// badge, replacing the floor badges (a zone is the more specific place; floors stay reachable
/// through the zone badge, which goes to the zone's lowest floor). An iteration group yields one
/// issue per zone, so each bubble carries one zone badge. A scope that no longer names an existing
/// zone or group (deleted since the analytics snapshot) falls back to the floor badges.
function IssueScopeBadges({ scope, nodeIds, bg, text, className }: { scope: IssueScope | null; nodeIds: number[]; bg: string; text: string; className?: string }) {
  if (scope == null) return <IssueFloorBadges nodeIds={nodeIds} bg={bg} text={text} className={className} />;
  // A chip click must not also open the bubble's description modal; the wrapper counters the bubble's hover brightening.
  return (
    <div className={className} onClick={(e) => e.stopPropagation()}>
      <ZoneIdChips zoneIds={scope.kind === "zone" ? [scope.id] : []} groupIds={scope.kind === "group" ? [scope.id] : []} />
    </div>
  );
}

export function IssuesBlock({ issues }: { issues: IssueDto[] }) {
  const showFullyPresetLockedIssues = useMazeStore((s) => s.showFullyPresetLockedIssues);
  const setShowFullyPresetLockedIssues = useMazeStore((s) => s.setShowFullyPresetLockedIssues);
  const sectionsExpanded = useMazeStore((s) => s.analyticsSectionsExpanded);
  const setAnalyticsSectionExpanded = useMazeStore((s) => s.setAnalyticsSectionExpanded);
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
        label={
          <span
            className={issues.length > 0 ? "problem-section-attention" : undefined}
          >
            {m["common.problems"]()} ({issues.length})
          </span>
        }
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
    // One indent level for the section's own content, relative to its `SectionHeader` label —
    // same shared `indent.tree` token every other feature-card section nests its body under
    // (GitHub issue #511), not a bespoke padding just for this block.
    paddingLeft: indent.tree,
  },
  bubble: {
    ...embeddedNotificationStyle,
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap / 2,
  },
  bubbleTopRow: {
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
    // Bullet lists in a description (`node_shape_limits`) are newline-separated.
    whiteSpace: "pre-line",
  },
  // A separate paragraph under the description, so a blank line sits between them.
  scopeLine: {
    margin: `${spacing.itemGap * 2}px 0 0`,
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
