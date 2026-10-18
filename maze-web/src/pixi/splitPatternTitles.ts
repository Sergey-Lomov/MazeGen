/** Title registry for named split-tile patterns — a small, curated subset of the maze-wide
 *  canonical topologies `AnalyticsFeature`'s split stats group tiles by (see
 *  `maze_core::graph::split_topology`). Deliberately independent from `splitBlueprints.ts`'s
 *  `SplitNodeBlueprint` registry (both describe similar shapes, but a blueprint is an editor
 *  action template with no title of its own; this registry exists purely to label a handful of
 *  recognizable shapes in the stats UI) — core only groups split tiles by topology, attaching a
 *  human title to a specific group is a client-only concern.
 *
 *  Keyed by the exact canonical topology core already computed (`SplitGroupDto.topology`,
 *  `maze_core::graph::split_topology::canonical_split_topology`'s output) — since core already
 *  reduces every tile to one fixed representative among all allowed transforms/node orderings,
 *  matching here is plain structural equality (`topologyEquals`, below), no rotation search
 *  needed on this side. Each entry's `topology` is in the canonical face order of the shape
 *  template, computed once (not derived at runtime) as the minimum, over the template's dihedral
 *  group, of the sorted node rows — the same reduction `canonical_split_topology` performs.
 *
 *  Filtered by tile degree (`topology[0].length`), same convention as `blueprintsFor`. */

import type { SplitFaceRequirement } from "../wasm/types";
import * as m from "~/paraglide/messages";

const PASSAGE: SplitFaceRequirement = { kind: "passage" };
const WALL: SplitFaceRequirement = { kind: "wall" };

export interface SplitPatternTitleEntry {
  /** Canonical topology this title applies to — must match a `SplitGroupDto.topology` value
   *  exactly (same node order, same face order) to take effect. */
  topology: SplitFaceRequirement[][];
  /** i18n message key (paraglide, `split_pattern_title.*`). */
  titleKey: string;
}

// Triangle (degree 3).
const TRIANGLE_TITLES: SplitPatternTitleEntry[] = [
  {
    // "Split fork" — the tessellation's only built-in triangle blueprint.
    topology: [
      [PASSAGE, PASSAGE, WALL],
      [PASSAGE, WALL, PASSAGE],
    ],
    titleKey: "split_pattern_title.split_fork",
  },
];

// Square (degree 4).
const SQUARE_TITLES: SplitPatternTitleEntry[] = [
  {
    // "Bridge" — two nodes, each a straight-through opposite-face pair.
    topology: [
      [PASSAGE, WALL, PASSAGE, WALL],
      [WALL, PASSAGE, WALL, PASSAGE],
    ],
    titleKey: "split_pattern_title.bridge",
  },
  {
    // "Diagonal divider" — two nodes, each an adjacent-face pair.
    topology: [
      [PASSAGE, PASSAGE, WALL, WALL],
      [WALL, WALL, PASSAGE, PASSAGE],
    ],
    titleKey: "split_pattern_title.diagonal_divider",
  },
];

// Hex (degree 6).
const HEX_TITLES: SplitPatternTitleEntry[] = [
  {
    // "Diagonal divider" — two nodes owning opposite groups of three adjacent faces.
    topology: [
      [PASSAGE, PASSAGE, PASSAGE, WALL, WALL, WALL],
      [WALL, WALL, WALL, PASSAGE, PASSAGE, PASSAGE],
    ],
    titleKey: "split_pattern_title.diagonal_divider",
  },
  {
    // "Bridge" — two nodes, each a straight-through opposite-face pair.
    topology: [
      [PASSAGE, WALL, WALL, PASSAGE, WALL, WALL],
      [WALL, PASSAGE, WALL, WALL, PASSAGE, WALL],
    ],
    titleKey: "split_pattern_title.bridge",
  },
  {
    // "Double bridge" — three nodes, all opposite-face pairs.
    topology: [
      [PASSAGE, WALL, WALL, PASSAGE, WALL, WALL],
      [WALL, PASSAGE, WALL, WALL, PASSAGE, WALL],
      [WALL, WALL, PASSAGE, WALL, WALL, PASSAGE],
    ],
    titleKey: "split_pattern_title.double_bridge",
  },
  {
    // "Triple corridor" — one opposite-face pair plus two adjacent-face pairs.
    topology: [
      [PASSAGE, PASSAGE, WALL, WALL, WALL, WALL],
      [WALL, WALL, PASSAGE, WALL, WALL, PASSAGE],
      [WALL, WALL, WALL, PASSAGE, PASSAGE, WALL],
    ],
    titleKey: "split_pattern_title.triple_corridor",
  },
];

const TITLES_BY_DEGREE: Record<number, SplitPatternTitleEntry[]> = {
  3: TRIANGLE_TITLES,
  4: SQUARE_TITLES,
  6: HEX_TITLES,
};

function requirementEquals(a: SplitFaceRequirement, b: SplitFaceRequirement): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "one_way" && b.kind === "one_way") return a.direction === b.direction;
  return true;
}

function topologyEquals(a: SplitFaceRequirement[][], b: SplitFaceRequirement[][]): boolean {
  if (a.length !== b.length) return false;
  return a.every((nodeFaces, i) =>
    nodeFaces.length === b[i].length && nodeFaces.every((req, j) => requirementEquals(req, b[i][j])),
  );
}

/** Looks up a title key for `topology`, or `null` if this shape has no registered title (shown
 *  only in the "pattern statistics" modal, not the main stats block). */
export function titleKeyForTopology(topology: SplitFaceRequirement[][]): string | null {
  const degree = topology[0]?.length ?? 0;
  const entries = TITLES_BY_DEGREE[degree] ?? [];
  return entries.find((e) => topologyEquals(e.topology, topology))?.titleKey ?? null;
}

/** Every `titleKey` this registry (and `splitBlueprints.ts`'s own hand-assigned `titleKey` field,
 *  GitHub issue #545) can produce, mapped to its resolved message — a plain `Record` lookup rather
 *  than dynamic `m[key]()` indexing, since paraglide's generated `m` object isn't meant to be
 *  indexed by an arbitrary runtime string. */
const TITLE_MESSAGES: Record<string, () => string> = {
  "split_pattern_title.split_fork": () => m["split_pattern_title.split_fork"](),
  "split_pattern_title.bridge": () => m["split_pattern_title.bridge"](),
  "split_pattern_title.diagonal_divider": () => m["split_pattern_title.diagonal_divider"](),
  "split_pattern_title.double_bridge": () => m["split_pattern_title.double_bridge"](),
  "split_pattern_title.triple_corridor": () => m["split_pattern_title.triple_corridor"](),
  "split_pattern_title.parallel_divider": () => m["split_pattern_title.parallel_divider"](),
  "split_pattern_title.adjacent_divider": () => m["split_pattern_title.adjacent_divider"](),
  "split_pattern_title.bridge_2x3": () => m["split_pattern_title.bridge_2x3"](),
};

/** Resolves a `titleKey` (from `titleKeyForTopology` or a `SplitNodeBlueprint`'s own field) to its
 *  message text. */
export function messageForTitleKey(key: string): string {
  return TITLE_MESSAGES[key]();
}
