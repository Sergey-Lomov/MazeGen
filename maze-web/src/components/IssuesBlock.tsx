import { useMemo, useState } from "react";
import { ui, typography, muted, spacing, indent } from "../styles/theme";
import { darken } from "../styles/palette";
import { Modal } from "./Modal";
import { useMazeStore } from "../store/mazeStore";
import { resolveIssue, resolveIssueSourceLabel, resolveIssueSourceDescription, presetLockElementsFor, TILE_GRANULARITY_CHECKS } from "./issueRegistry";
import { embeddedNotificationStyle, notificationPalette } from "./EmbeddedNotification";
import { SectionHeader } from "./SectionHeader";
import { ToggleRow } from "./ToggleRow";
import { selectNodeLevelResolver, selectNodeIdsForLevel } from "../pixi/selectors/mazeSelectors";
import { FloorBadgeRow } from "./FloorBadgeRow";
import * as m from "~/paraglide/messages";
import type React from "react";
import type { IssueDto, IssueEdgeGroupPayload } from "../wasm/types";
import type { IssueHighlightEdge } from "../store/postEditFullTypes";

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
  const mazeNodes = useMazeStore((s) => s.nodes);
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
  // `invalid_vertical_passage`/`invalid_vertical_passage_group` share the same
  // `invalid_vertical_passage` payload shape (a single flagged edge is a group of size one — see
  // `IssuePayloadDto`'s doc comment) — flattened and rendered through the same edge-highlight path
  // as `teleportGroups`/`oneWayGroups`, no dedicated renderer needed.
  const verticalPassageGroups = sourceCheck != null && issue.payload.kind === "invalid_vertical_passage"
    ? issue.payload.groups[sourceCheck] ?? null
    : null;
  // `invalid_elevator` (GitHub issue #397) reuses the same edge-group payload shape as
  // `invalid_vertical_passage` and highlights the same way -- a flagged elevator's fan edges span
  // multiple floors, so a line-per-edge highlight would read as stray diagonals; rendered as
  // region squares over the elevator's own stop nodes instead (see `verticalPassageCellNodes`).
  const elevatorGroups = sourceCheck != null && issue.payload.kind === "invalid_elevator"
    ? issue.payload.groups[sourceCheck] ?? null
    : null;
  // `invalid_elevator_stop`/`invalid_elevator_stop_group` (GitHub issue #399) share the same
  // single-node "region" payload shape as `region_needs_expansion`/`region_needs_shrink` -- each
  // flagged stop (or, for a group, each stop in the group) highlights as its own independent
  // single-node region square, not a merged multi-node region.
  const elevatorStopNodes = sourceCheck != null && issue.payload.kind === "invalid_elevator_stop"
    ? issue.payload.nodes[sourceCheck] ?? null
    : null;
  // `missing_elevator_stop_count` (GitHub issue #402) reuses `elevatorGroups`' own highlight shape
  // -- only the elevator's own real fan edges, drawn as region squares like `elevatorCellNodes`.
  // Deliberately excludes each group's `available` floor nodes (candidate stops the repair
  // strategy could add) -- those aren't part of the elevator yet, so highlighting them on hover
  // would read as "the elevator stops here", which is false. `missing_elevator_height`/
  // `excessive_elevator_stop_gap` reuse `InvalidElevator`'s payload shape instead and highlight
  // via `elevatorGroups` above.
  const missingStopGroups = sourceCheck != null && issue.payload.kind === "missing_elevator_stop_count"
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
  // `area_deficit` (hover-highlight follow-up to GitHub issue #408) — a floor-level deficit, not a
  // specific node/edge set. `Some(levelIndex)` entries resolve to "every cell on that floor";
  // `null` (`RepairArea::WholeMaze`, e.g. `missing_elevators`'s only scope) has no specific floor
  // to highlight and contributes nothing here, same "no per-element highlight" precedent as
  // `excessive_scc_count` above.
  const areaDeficitEntries = sourceCheck != null && issue.payload.kind === "area_deficit"
    ? issue.payload.areas[sourceCheck] ?? null
    : null;
  // `invalid_cross_element_group` (GitHub issue #376) -- one entry per flagged pair member, mixing
  // edge elements (teleport/one-way/vertical passage/elevator) with point elements
  // (split/start/finish). Most kinds highlight as region squares over each member's cells (same
  // rationale as `verticalPassageCellNodes`/`elevatorCellNodes` -- a node shared by two members
  // would otherwise double-fill/stroke), but `one_way` is split out below and highlighted as a
  // wall like every other one-way highlight (`oneWayEdges`) instead -- a one-way is a single edge
  // between two adjacent cells, and filling both cells as a region reads as "these two cells", not
  // "this directed connection between them". The maze-core resolver has already narrowed each
  // member to just the occurrence(s) within the proximity threshold (issue #376 follow-up point
  // 4), so a teleport close to the other element by one end highlights that end only.
  //
  // Preset visibility (issue #376 follow-up point 5) is all-or-nothing PER PAIR, not per element:
  // a pair is hidden only when every one of its members is preset_locked; a pair with at least one
  // unlocked member shows ALL its members, including the preset-locked one. So the toggle filter
  // is applied here at pair granularity, then the surviving pairs are flattened -- the per-element
  // `visibleGroup` filter used by every other kind is deliberately NOT applied to these entries.
  const crossElementEntries = sourceCheck != null && issue.payload.kind === "invalid_cross_element_group"
    ? issue.payload.groups[sourceCheck]
        ?.filter((pair) => showFullyPresetLockedIssues || pair.some((e) => !e.preset_locked))
        .flat() ?? null
    : null;
  const crossElementOneWayEntries = crossElementEntries?.filter((e) => e.kind === "one_way") ?? null;
  // Kept as one group per non-`one_way` member (not one merged group across every member of every
  // pair) -- two flagged pairs, or two members of the same pair, must never merge into one contour
  // just because they're both part of the same bubble, even when they happen to sit right next to
  // each other (that's exactly the "too close" fact a proximity check reports, GitHub issue #619).
  const crossElementRegionEntries = crossElementEntries?.filter((e) => e.kind !== "one_way") ?? null;
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
  const asHighlightEdges = (pairs: [number, number][], asWall: boolean): IssueHighlightEdge[] =>
    pairs.map(([from, to]) => ({ from, to, asWall }));
  // Loop edges form a cycle -- drawn as connected lines, never as walls (see
  // `IssueHighlightEdge`'s doc comment).
  const loopEdges = loopGroups != null
    ? asHighlightEdges(loopGroups.filter(visibleGroup).flatMap((g) => g.edges), false)
    : null;
  // A teleport warning describes the two endpoint cells, not a traversable on-field segment.
  // Highlight both ends as one region group and never draw the geometric line between them.
  // Keeping one deduplicated group also prevents a shared endpoint from being filled/stroked
  // several times when a warning contains multiple teleport pairs.
  const teleportCellNodes = teleportGroups != null
    ? (() => {
        const nodes = Array.from(new Set(teleportGroups.filter(visibleGroup).flatMap((g) => g.edges.flat())));
        return nodes.map((id) => [id]);
      })()
    : null;
  const oneWayEdges = oneWayGroups != null
    ? asHighlightEdges(oneWayGroups.filter(visibleGroup).flatMap((g) => g.edges), true)
    : null;
  // Unlike teleport/one-way (thin directed edges, highlighted as lines), a vertical passage
  // connects two floors at the same x-y point -- a line between its endpoints reads as a stray
  // diagonal rather than "these cells". Highlighted as region squares instead, one flat
  // deduplicated group (not one group per edge) -- `RegionHighlightRenderer` fills each group
  // independently, so a node shared by two flagged edges (e.g. two proximity pairs through the
  // same passage) would otherwise get double-filled/double-stroked.
  const verticalPassageCellNodes = verticalPassageGroups != null
    ? Array.from(new Set(verticalPassageGroups.filter(visibleGroup).flatMap((g) => g.edges).flat())).map((id) => [id])
    : null;
  const elevatorCellNodes = elevatorGroups != null
    ? Array.from(new Set(elevatorGroups.filter(visibleGroup).flatMap((g) => g.edges).flat())).map((id) => [id])
    : null;
  // One region-highlight group per flagged stop (not one merged group) -- mirrors
  // `visibleRegionGroups` below but keeps each stop independently toggleable/highlightable, since
  // stops in a group aren't necessarily adjacent the way a region's member cells are.
  const elevatorStopCellNodes = elevatorStopNodes != null
    ? elevatorStopNodes.filter(visibleGroup).map((n) => n.region)
    : null;
  // Elevator fan edges only (same shape as `elevatorCellNodes`) -- one flat deduplicated group,
  // same rationale as `verticalPassageCellNodes` (a node touched by two groups would otherwise
  // double-fill/stroke). `available` candidate floor nodes are excluded, see `missingStopGroups`.
  const missingStopCellNodes = missingStopGroups != null
    ? [Array.from(new Set(missingStopGroups.filter(visibleGroup).flatMap((g) => g.edges.flat())))]
    : null;
  // No per-element `visibleGroup` filter here -- `crossElementEntries` above already dropped whole
  // pairs whose every member is preset-locked, and a surviving pair shows all its members. Every
  // `split` member merges into one deduplicated group with the outward split inset (GitHub issue
  // #619 -- splits always merge with each other, same as a plain `invalid_split_tile` bubble); each
  // other, non-split member keeps its own separate group so two distinct flagged elements (e.g. a
  // teleport and a vertical passage) never merge into one contour just because they're both part of
  // the same flagged pair.
  const crossElementSplitEntries = crossElementRegionEntries?.filter((e) => e.kind === "split") ?? null;
  const crossElementOtherRegionEntries = crossElementRegionEntries?.filter((e) => e.kind !== "split") ?? null;
  const crossElementCellNodes = crossElementRegionEntries != null && crossElementRegionEntries.length > 0
    ? [
        ...(crossElementOtherRegionEntries ?? []).map((e) => ({
          nodes: Array.from(new Set([...e.edges.flat(), ...e.nodes])),
          isSplit: false,
        })),
        ...(crossElementSplitEntries != null && crossElementSplitEntries.length > 0
          ? [{ nodes: Array.from(new Set(crossElementSplitEntries.flatMap((e) => e.tile?.nodes ?? []))), isSplit: true }]
          : []),
      ]
    : null;
  // Same wall-edge rendering as `oneWayEdges` above -- see the doc comment on
  // `crossElementOneWayEntries`.
  const crossElementOneWayEdges = crossElementOneWayEntries != null && crossElementOneWayEntries.length > 0
    ? asHighlightEdges(crossElementOneWayEntries.flatMap((e) => e.edges), true)
    : null;
  // The visible tiles keep their own lock/filtering granularity, but are sent as one region group
  // so adjacent tiles can share a contour and merge exactly like ordinary regions -- unlike
  // `invalid_cross_element_group` (GitHub issue #619), a plain `invalid_split_tile` bubble has no
  // "these two are a flagged pair" semantics to protect: it's just a list of flagged tiles, and
  // two of them sitting next to each other should read as one merged region same as any other.
  const splitTileNodes = splitGroups != null
    ? (() => {
        const tiles = splitGroups.flatMap((g) =>
          TILE_GRANULARITY_CHECKS.has(typeId)
            ? g.tiles.filter(visibleGroup)
            : visibleGroup(g) ? g.tiles : []
        );
        const nodes = Array.from(new Set(tiles.flatMap((tile) => tile.nodes)));
        return nodes.length > 0 ? [nodes] : [];
      })()
    : null;
  const splitRouteEdges = splitRoutePayload != null
    ? [splitRoutePayload.filter(visibleGroup).flatMap((r) => r.edges).map((e) => [e.from, e.to] as [number, number])]
    : null;
  const splitRouteHighlightEdges = splitRouteEdges != null
    ? asHighlightEdges(splitRouteEdges.flat(), false)
    : null;
  const visibleRegionGroups = regionNodes != null
    ? regionNodes.filter(visibleGroup).map((r) => r.region)
    : null;
  // One region-highlight group per floor-scoped deficit entry -- `null` entries (whole-maze
  // deficits) are dropped, not highlighted as a fallback (no per-element highlight data for them,
  // same as `excessive_scc_count`).
  const areaDeficitCellNodes = areaDeficitEntries != null
    ? areaDeficitEntries
        .filter((level): level is number => level !== null)
        .map((level) => selectNodeIdsForLevel(mazeNodes, level))
    : null;

  // Wall/line edges (`setHoveredIssueLoopEdges`) and region-square cells
  // (`setHoveredIssueRegionGroups`) are independent overlay states -- normally a bubble only ever
  // populates one of the two families, but `invalid_cross_element_group` can populate both at once
  // (a one-way member drawn as a wall alongside other members drawn as region squares), so both are
  // set together rather than picking just the first match.
  const highlightEdges = loopEdges ?? oneWayEdges ?? splitRouteHighlightEdges ?? crossElementOneWayEdges;
  const asRegionGroups = (groups: number[][], isSplit: boolean) => groups.map((nodes) => ({ nodes, isSplit }));
  const highlightRegionGroups = visibleRegionGroups != null ? asRegionGroups(visibleRegionGroups, false)
    : splitTileNodes != null ? asRegionGroups(splitTileNodes, true)
    : teleportCellNodes != null ? asRegionGroups(teleportCellNodes, false)
    : verticalPassageCellNodes != null ? asRegionGroups(verticalPassageCellNodes, false)
    : elevatorCellNodes != null ? asRegionGroups(elevatorCellNodes, false)
    : elevatorStopCellNodes != null ? asRegionGroups(elevatorStopCellNodes, false)
    : (areaDeficitCellNodes != null && areaDeficitCellNodes.length > 0) ? asRegionGroups(areaDeficitCellNodes, false)
    : missingStopCellNodes != null ? asRegionGroups(missingStopCellNodes, false)
    : crossElementCellNodes;
  const handleMouseEnter = highlightEdges != null || highlightRegionGroups != null
    ? () => {
        if (highlightEdges != null) setHoveredIssueLoopEdges(highlightEdges);
        if (highlightRegionGroups != null) setHoveredIssueRegionGroups(highlightRegionGroups);
      }
    : undefined;
  const handleMouseLeave = highlightEdges != null || highlightRegionGroups != null
    ? () => {
        if (highlightEdges != null) setHoveredIssueLoopEdges(null);
        if (highlightRegionGroups != null) setHoveredIssueRegionGroups(null);
      }
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

  // GitHub issue #365: every maze node id this bubble's own visible elements touch, across
  // whichever payload shape is in play -- union of the same edge/group sources `handleMouseEnter`
  // above already isolates per bubble (only this source check's visible elements, not every
  // contributing check's combined). Used only to find which *floors* the bubble spans; the actual
  // hover highlight is unaffected by this.
  const touchedNodeIds = [
    ...(loopEdges ?? []),
    ...(crossElementOneWayEdges ?? []),
  ].flatMap((e) => [e.from, e.to]).concat((splitRouteEdges?.flat() ?? []).flat(), (splitTileNodes ?? []).flat(), (teleportCellNodes ?? []).flat(), (visibleRegionGroups ?? []).flat(), (verticalPassageCellNodes ?? []).flat(), (elevatorCellNodes ?? []).flat(), (elevatorStopCellNodes ?? []).flat(), (areaDeficitCellNodes ?? []).flat(), (missingStopCellNodes ?? []).flat(), (crossElementCellNodes ?? []).flatMap((g) => g.nodes));

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
        <IssueFloorBadges
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
        </Modal>
      )}
    </>
  );
}

/// Row of solid `L{n}` badges inside a bubble, shown whenever the maze itself has more than one
/// floor (GitHub issue #365, extended by #423 to match the Preset Connections orphan-split-node
/// warning's always-show-on-multi-floor behavior) -- a floor-scoped canvas highlight only shows
/// the active floor's own entities, so this is the one place a user can discover "this problem
/// also exists on floor 3" without switching floors themselves, even when the bubble's own
/// elements happen to sit on a single floor. `color` matches the parent bubble's own text color
/// (same as the label/info-icon), not a fixed hue. Distinct floor *indices* (`NodeDto.level ?? 0`,
/// the same convention `selectNodeLevelResolver`/`navigateToFloor` already use), not floor ids --
/// sorted ascending so the row always reads bottom-to-top regardless of `nodeIds`' own order.
/// Renders nothing on a single-floor maze, same as every other cross-floor indicator in the app.
/// Also renders nothing when `nodeIds` resolves to zero floors (e.g. a whole-maze issue with no
/// per-element highlight data) -- there is nothing to badge in that case.
function IssueFloorBadges({ nodeIds, bg, text, className }: { nodeIds: number[]; bg: string; text: string; className?: string }) {
  const nodes = useMazeStore((s) => s.nodes);
  // Memoized on `nodes` identity, not rebuilt per render -- `nodes` only changes on
  // generate/reset/load, while this component can re-render far more often (any store update
  // touching the Analytics panel), and rebuilding the full node->level Map per bubble per render
  // would be wasted work at scale (many issue bubbles x many nodes).
  const resolveNodeLevel = useMemo(() => selectNodeLevelResolver(nodes), [nodes]);
  const levels = Array.from(new Set(nodeIds.map((id) => resolveNodeLevel(id)).filter((l): l is number => l !== undefined))).sort((a, b) => a - b);
  return <FloorBadgeRow levels={levels} bg={bg} text={text} className={className} />;
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
