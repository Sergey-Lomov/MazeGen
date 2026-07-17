import { buildPalette, hslToRgb } from "./colorUtils";

// Predefined debug-value highlight colors (GitHub issue #164) — keyed by (scope, name), not a
// combined string, so the lookup stays extensible to non-algorithm scopes later (e.g. QC/repair
// debug values) without inventing a delimiter/parsing convention. `scope` is today always the
// generation algorithm's `EventedEventKind` (`debugArena.algorithmKind`), mirroring the
// `scope_name` concept `qualify_debug_value_names` already uses on the Rust side.
//
// The same name is declared independently by several algorithms (e.g. "visited" — Recursive
// Backtracker, Wilson, CustomEdgeBased, CustomVertexBased all declare it, see
// debug_value_names() in maze-core/src/generation/*.rs). Deliberately keyed per-scope rather than
// giving a name one global color: colors are assigned independently per algorithm below (e.g.
// "visited" gets a different hue in each algorithm's table) so a name's color still identifies
// *which algorithm's* run is being viewed, not just the semantic meaning of the name. Scopes/names
// not listed here (e.g. Kruskal, which declares no debug values yet) fall back to the palette
// below.
const PREDEFINED_COLORS: Record<string, Record<string, number>> = {
  recursive_backtracker: {
    recursion_stack: hslToRgb(140, 0.55, 0.5),
    visited: hslToRgb(140, 0.55, 0.5),
  },
  wilson: {
    visited: hslToRgb(140, 0.55, 0.5),
    current_walk: hslToRgb(140, 0.55, 0.35),
    walk_start: hslToRgb(140, 0.9, 0.35),
    walk_head: hslToRgb(140, 0.9, 0.35),
  },
  edge_based: {
    active: hslToRgb(140, 0.55, 0.5),
    visited: hslToRgb(140, 0.55, 0.3),
  },
  vertex_based: {
    visited: hslToRgb(140, 0.55, 0.3),
    frontier: hslToRgb(140, 0.55, 0.5),
    reserve: hslToRgb(140, 0.55, 0.15),
  },
};

// Fallback palette for names with no predefined color — same "random-looking but non-toxic"
// golden-angle palette the analytics region overlay uses (colorUtils.ts's buildPalette), not the
// old analogous-hue-family scheme. Large enough that collisions across a single scope's declared
// names are rare; looked up by index into a fixed-size precomputed table (mirrors
// KruskalDsuHighlightOverlay.colorForRoot's approach) so a given index's color never changes.
const FALLBACK_PALETTE_SIZE = 32;
const FALLBACK_PALETTE = buildPalette(FALLBACK_PALETTE_SIZE);

/** Resolves a debug value's highlight color: predefined per-(scope, name) color first, falling
 *  back to a stable slot in the non-toxic random-looking palette for anything undeclared.
 *  `fallbackIndex` is the name's position among its scope's declared debug values (e.g. its index
 *  in `debugArena.debugValueNames`) — used only for the fallback slot, so two undeclared names
 *  within the same scope still land on different colors.
 *
 *  `name` may be qualified with a `"{scope_name}:"` prefix (Rust's `qualify_debug_value_names`,
 *  `maze-core/src/generation/mod.rs`) whenever more than one event-log source is present — e.g.
 *  `"generation:recursion_stack"` once a QC/repair source runs alongside generation. That
 *  `scope_name` is a *tape-source* label ("generation"/"quality_control"), unrelated to the
 *  *algorithm* `scope` this function keys colors by, so it's stripped before the lookup — matching
 *  against the un-qualified name only, never against the caller-supplied `scope`. */
export function resolveDebugValueColor(
  scope: string,
  name: string,
  fallbackIndex: number,
): number {
  const unqualifiedName = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
  const predefined = PREDEFINED_COLORS[scope]?.[unqualifiedName];
  if (predefined !== undefined) return predefined;
  return FALLBACK_PALETTE[fallbackIndex % FALLBACK_PALETTE.length];
}
