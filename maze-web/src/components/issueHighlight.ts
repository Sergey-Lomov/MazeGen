/** Shared issue-highlight resolution (GitHub issue #623) — both Analytics (`IssuesBlock.tsx`,
 *  `number`/snake_case `IssuePayloadDto`) and the debug tree (`algorithmRegistry.ts`,
 *  `bigint`/camelCase `IssuePayload` from `eventTape`) resolve an issue's payload into the same
 *  cycle/region highlight shape, but used to do it via two independently-maintained `switch`
 *  statements over the payload kind, one in each shape — the source of the #619 highlighting bugs,
 *  where a fix landed on one side and not the other. `resolveIssueHighlight` is the single place
 *  that walks payload kinds; each side only has to normalize its own wire shape into
 *  `NormalizedIssuePayload<Id>` first (a thin adapter, no highlight-specific logic of its own).
 *
 *  Generic over `Id` (`number` for Analytics, `bigint` for the debug tree) so both callers get a
 *  fully-typed result without either laundering through `unknown`/`any`. */

/** One flagged cycle/group's edges — normalized shape of both `IssueEdgeGroupPayload` (DTO) and
 *  `EdgeGroup` (`eventTape`). Preset-lock filtering happens upstream of normalization on both call
 *  sites (`IssuesBlock.tsx`'s `visibleGroup`, `algorithmRegistry.ts`), so the normalized shape
 *  carries no `presetLocked` field of its own (GitHub issue #624). */
export interface NormalizedEdgeGroup<Id> {
  edges: [Id, Id][];
}

/** One flagged region's member node ids — normalized shape of both `IssueRegionPayload` (DTO) and
 *  `RegionGroup` (`eventTape`). See `NormalizedEdgeGroup`'s doc comment on preset-lock filtering. */
export interface NormalizedRegionGroup<Id> {
  nodes: Id[];
}

/** One tile's own node list inside a flagged split element — normalized shape of both
 *  `IssueSplitTilePayload` (DTO) and `SplitTile` (`eventTape`). See `NormalizedEdgeGroup`'s doc
 *  comment on preset-lock filtering. */
export interface NormalizedSplitTile<Id> {
  nodes: Id[];
}

/** One flagged split-tile "instance" (a single tile or a genuine multi-tile group) — normalized
 *  shape of both `IssueSplitGroupPayload` (DTO) and `SplitGroup` (`eventTape`). See
 *  `NormalizedEdgeGroup`'s doc comment on preset-lock filtering. */
export interface NormalizedSplitGroup<Id> {
  tiles: NormalizedSplitTile<Id>[];
}

/** One logical element of a flagged cross-element proximity pair — normalized shape of both
 *  `CrossElementPayloadEntry` (DTO) and `CrossElementEntry` (`eventTape`). */
export interface NormalizedCrossElementEntry<Id> {
  kind: string;
  edges: [Id, Id][];
  nodes: Id[];
  tile: NormalizedSplitTile<Id> | null;
}

/** Normalized union mirroring `IssuePayload`/`IssuePayloadDto`'s variants — each side's own
 *  adapter (`normalizeIssuePayload` in `IssuesBlock.tsx`/`algorithmRegistry.ts`) maps its wire
 *  shape into this one before calling `resolveIssueHighlight`. Only the variants that carry
 *  structural highlight data need a case in `resolveIssueHighlight`; `none`/`excessiveSccCount`/
 *  `areaDeficit` all resolve to "no highlight" by construction (mirrors `IssuePayload::None` /
 *  `ExcessiveSccCount` / `AreaDeficit` having no edge/node payload). */
export type NormalizedIssuePayload<Id> =
  | { kind: "none" }
  | { kind: "invalidLoop"; groups: NormalizedEdgeGroup<Id>[] }
  | { kind: "regionNeedsExpansion" | "regionNeedsShrink"; groups: NormalizedRegionGroup<Id>[] }
  | { kind: "invalidTeleport"; groups: NormalizedEdgeGroup<Id>[] }
  | { kind: "invalidOneWay"; groups: NormalizedEdgeGroup<Id>[] }
  | { kind: "invalidSplitTile"; groups: NormalizedSplitGroup<Id>[] }
  | { kind: "invalidSplitRoute"; edges: [Id, Id][] }
  | { kind: "excessiveSccCount" }
  | { kind: "invalidVerticalPassage"; groups: NormalizedEdgeGroup<Id>[] }
  | { kind: "invalidElevator"; groups: NormalizedEdgeGroup<Id>[] }
  | { kind: "invalidElevatorStop"; groups: NormalizedRegionGroup<Id>[] }
  | { kind: "areaDeficit" }
  | { kind: "missingElevatorStopCount"; groups: NormalizedEdgeGroup<Id>[] }
  | { kind: "invalidCrossElementGroup"; entries: NormalizedCrossElementEntry<Id>[] };

/** A resolved cycle highlight — connected edges drawn as a line (`asWall: false`, loop/teleport/
 *  split-route groups) or as the shared wall between two adjacent cells (`asWall: true`, a
 *  single-edge one-way problem or a one-way cross-element member). Mirrors style 1.5/1.6 in
 *  `Specs/highlighting.md`. */
export interface ResolvedIssueCycle<Id> {
  edges: [Id, Id][];
  asWall: boolean;
}

/** One resolved region-highlight group — `isSplit` picks the outward "split" inset instead of the
 *  normal inward one (GitHub issue #619), set explicitly from the payload kind that produced the
 *  group, never guessed from the group's own geometry. */
export interface ResolvedIssueRegionGroup<Id> {
  nodes: Id[];
  isSplit: boolean;
}

/** `cycle`/`region` are independent, not mutually exclusive — an `invalidCrossElementGroup` mixing
 *  a one-way member (wall) with a split/region member needs both drawn at once. */
export interface ResolvedIssueHighlight<Id> {
  cycle: ResolvedIssueCycle<Id> | null;
  region: { groups: ResolvedIssueRegionGroup<Id>[] } | null;
}

/** Resolves a normalized issue payload into `{cycle, region}` highlight data — the single place
 *  that maps payload kind to merge/inset/wall-vs-region highlight shape (GitHub issue #623). Every
 *  case here has a direct counterpart in `Specs/highlighting.md`'s "Applications by feature"
 *  section; keep both in sync when adding a payload kind. */
export function resolveIssueHighlight<Id>(payload: NormalizedIssuePayload<Id>): ResolvedIssueHighlight<Id> {
  switch (payload.kind) {
    case "none":
    case "excessiveSccCount":
    case "areaDeficit":
      // No structural highlight data — these issues never point at specific edges/regions on the
      // canvas (mirrors `IssuePayload::ExcessiveSccCount`/`AreaDeficit`'s doc comments).
      return { cycle: null, region: null };

    case "invalidLoop": {
      // Loop edges form a cycle — drawn as connected lines, never as walls.
      const edges = payload.groups.flatMap((g) => g.edges);
      return edges.length > 0 ? { cycle: { edges, asWall: false }, region: null } : { cycle: null, region: null };
    }

    case "invalidOneWay": {
      // Each flagged one-way is an independent single-edge problem between two adjacent cells
      // (GitHub issue #377) — highlighted as the wall between them rather than a line.
      const edges = payload.groups.flatMap((g) => g.edges);
      return edges.length > 0 ? { cycle: { edges, asWall: true }, region: null } : { cycle: null, region: null };
    }

    case "invalidTeleport":
    case "invalidVerticalPassage":
    case "invalidElevator":
    case "missingElevatorStopCount": {
      // A teleport/vertical-passage/elevator warning describes endpoint cells, not a traversable
      // on-field segment — a connector line reads as a stray diagonal (teleports have no geometric
      // adjacency at all; a vertical passage/elevator connects two floors at the same x-y point).
      // Highlighted as independent singleton cell groups over the edges' endpoint nodes instead
      // (style 1.2 in `Specs/highlighting.md`; invariant #6; GitHub issue #466) — one flat
      // deduplicated node set first, so a node touched by two flagged edges (e.g. two proximity
      // pairs through the same passage) isn't filled/stroked twice, then one group per node so
      // adjacent flagged cells never merge into a single contour the way a region does.
      const nodes = dedupe(payload.groups.flatMap((g) => g.edges.flat()));
      return nodes.length > 0 ? { cycle: null, region: { groups: nodes.map((n) => ({ nodes: [n], isSplit: false })) } } : { cycle: null, region: null };
    }

    case "regionNeedsExpansion":
    case "regionNeedsShrink":
    case "invalidElevatorStop": {
      // One region-highlight group per flagged region/stop (not one merged group) -- an
      // `invalid_elevator_stop`'s stops aren't necessarily adjacent the way a region's own member
      // cells are (GitHub issue #399), and two distinct `region_needs_expansion`/`_shrink` regions
      // must stay visually separate even if they happen to sit next to each other.
      const groups = payload.groups.map((g) => ({ nodes: g.nodes, isSplit: false }));
      return groups.length > 0 ? { cycle: null, region: { groups } } : { cycle: null, region: null };
    }

    case "invalidSplitTile": {
      // Flagged split tiles always merge with each other, one region group with the outward split
      // inset (GitHub issue #619).
      const nodes = dedupe(payload.groups.flatMap((g) => g.tiles.flatMap((t) => t.nodes)));
      return nodes.length > 0 ? { cycle: null, region: { groups: [{ nodes, isSplit: true }] } } : { cycle: null, region: null };
    }

    case "invalidSplitRoute":
      // The route's own edge order and per-edge split-tile flag only matter to the repair
      // strategy's candidate filtering, not to highlighting the whole path on hover.
      return payload.edges.length > 0 ? { cycle: { edges: payload.edges, asWall: false }, region: null } : { cycle: null, region: null };

    case "invalidCrossElementGroup": {
      // A cross-element pair can mix a one-way member (wall) with region-shaped members (split/
      // teleport/vertical passage/elevator-stop/start/finish) — both are drawn at once, not one or
      // the other (GitHub issue #376). Every `split` member merges into one deduplicated group
      // (splits always merge with each other); every other region-shaped member keeps its own
      // separate group so two distinct flagged elements never merge into one contour just for
      // sharing the same pair (GitHub issue #619).
      const oneWayEntries = payload.entries.filter((e) => e.kind === "one_way");
      const splitEntries = payload.entries.filter((e) => e.kind === "split");
      const otherEntries = payload.entries.filter((e) => e.kind !== "one_way" && e.kind !== "split");
      const groups: ResolvedIssueRegionGroup<Id>[] = [
        ...otherEntries.map((e) => ({ nodes: dedupe([...e.edges.flat(), ...e.nodes]), isSplit: false })),
        ...(splitEntries.length > 0
          ? [{ nodes: dedupe(splitEntries.flatMap((e) => e.tile?.nodes ?? [])), isSplit: true }]
          : []),
      ];
      const cycle = oneWayEntries.length > 0 ? { edges: oneWayEntries.flatMap((e) => e.edges), asWall: true } : null;
      const region = groups.length > 0 ? { groups } : null;
      return { cycle, region };
    }
  }
}

function dedupe<Id>(ids: Id[]): Id[] {
  return Array.from(new Set(ids));
}
