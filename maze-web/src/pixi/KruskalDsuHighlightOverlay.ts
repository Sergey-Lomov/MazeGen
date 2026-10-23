import { Container } from "pixi.js";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";
import { buildPalette } from "./colorUtils";

const HIGHLIGHT_WIDTH = 2;
const HIGHLIGHT_ALPHA = 0.6;

export interface KruskalDsuHighlightData {
  nodes: NodeDto[];
  /** Node id (joined `number`) -> current DSU root, reconstructed at the current debug step —
   *  see `DebugMazeView.dsuGroups`. `null`/empty clears the overlay. */
  dsuGroups: Map<number, number> | null;
  cfg: FieldConfig;
}

// Palette large enough that a color is rarely reused across simultaneously-visible groups even on
// a big field — colors are looked up by index into this fixed-size, precomputed palette (see
// colorForRoot below), not resized per render, so a given index's color never changes.
const PALETTE_SIZE = 64;
const PALETTE = buildPalette(PALETTE_SIZE);

/** Groups `dsuGroups`' entries by root, keeping only non-singleton groups — pulled out of
 *  `KruskalDsuHighlightOverlay.render` as a standalone pure function so this data-transformation
 *  logic (the actual bug-prone part — see the class doc comment's "Color stability" note) is unit
 *  testable without constructing a real pixi.js `Container`/`Graphics`. Skips singleton groups (a
 *  node not yet merged into anything) — highlighting every isolated cell individually would paint
 *  almost the entire field on the first replay step and read as noise rather than signal; only
 *  actual merges are interesting to see. Root order in the returned array is Map-insertion order
 *  of first appearance among `dsuGroups`' entries — callers must not depend on any particular
 *  order beyond "stable for a given `dsuGroups` snapshot", since colors are looked up by root value
 *  (`colorForRoot`), not by position in this array. */
export function groupNonSingletonsByRoot(dsuGroups: Map<number, number>): Map<number, number[]> {
  const groupsByRoot = new Map<number, number[]>();
  for (const [id, root] of dsuGroups) {
    let group = groupsByRoot.get(root);
    if (!group) { group = []; groupsByRoot.set(root, group); }
    group.push(id);
  }
  for (const [root, group] of groupsByRoot) {
    if (group.length <= 1) groupsByRoot.delete(root);
  }
  return groupsByRoot;
}

/** Maps a DSU root id to a stable palette color — a simple integer hash (Knuth multiplicative)
 *  rather than `root % PALETTE.length` directly, since node ids tend to be assigned in a
 *  spatially-clustered order (e.g. row-major), so a plain modulo would make adjacent-id groups
 *  land on adjacent, visually similar palette entries. Exported as a standalone pure function (not
 *  a private class method) so its hash distribution/stability can be unit tested directly — see
 *  the class doc comment's "Color stability" note for why this matters: an earlier implementation
 *  colored by a group's *position* in that render's list instead, which flipped colors on unrelated
 *  merges and was only caught by manual browser testing, not a unit test. */
export function colorForRoot(root: number): number {
  const hashed = Math.imul(root ^ (root >>> 16), 0x45d9f3b) >>> 0;
  return PALETTE[hashed % PALETTE.length];
}

/** Persistent (not hover-only) canvas highlighting for Kruskal's union-find groups (GitHub issue
 *  #146's DSU-groups extension) — owned by `GenerationRenderer`, per the feature-renderer
 *  ownership rule (`maze-web/CLAUDE.md`). Unlike `DebugValueHighlightOverlay` (#131, one layer per
 *  *named* value, toggled individually), this renders every current DSU group at once — the group
 *  count and membership change on every replay step (a merge reduces the group count by one), so
 *  there's no stable per-group name to key a toggle or a persistent layer by; the whole picture is
 *  rebuilt each render.
 *
 *  Color stability: a group's *root id* only changes when that exact group merges with another
 *  (`union_by_min` always keeps the smaller of the two roots) — so as long as a group doesn't
 *  merge, its root id stays the same across replay steps, and coloring by
 *  `hash(root) % PALETTE.length` keeps that group's color stable too. Naively re-running
 *  `buildPalette(groupCount)` and assigning by array position every render (the original
 *  implementation) instead colored by a group's *position* in that render's group list — since
 *  `Map` iteration order (and thus which position a group lands in) isn't tied to the group's
 *  identity, an unrelated group merging elsewhere could shift every other group's position and
 *  flip its color, even though that group itself didn't change. */
export class KruskalDsuHighlightOverlay {
  private readonly container: Container;
  // One RegionHighlightRenderer per currently-drawn group, since `RegionHighlightRenderer.render`
  // clears-and-redraws its own single `Graphics` on every call (one color per instance) — a
  // shared instance can't hold several simultaneously-colored groups at once. Rebuilt in full on
  // every render (see the class doc comment: group membership/count changes every replay step, so
  // there's no stable per-group identity to diff against and reuse instances by).
  private renderers: RegionHighlightRenderer[] = [];

  constructor(container: Container) {
    this.container = container;
  }

  private resize(count: number): void {
    while (this.renderers.length < count) {
      this.renderers.push(new RegionHighlightRenderer(this.container));
    }
    while (this.renderers.length > count) {
      this.renderers.pop()!.destroy();
    }
  }

  render(data: KruskalDsuHighlightData): void {
    const { nodes, dsuGroups, cfg } = data;
    if (!dsuGroups || dsuGroups.size === 0 || nodes.length === 0) {
      this.resize(0);
      return;
    }

    const groupsByRoot = groupNonSingletonsByRoot(dsuGroups);
    const roots = Array.from(groupsByRoot.keys());

    this.resize(roots.length);
    for (let i = 0; i < roots.length; i++) {
      this.renderers[i].render({
        nodes,
        regionGroups: [groupsByRoot.get(roots[i])!],
        color: colorForRoot(roots[i]),
        width: HIGHLIGHT_WIDTH,
        alpha: HIGHLIGHT_ALPHA,
        cfg,
        skipPerimeter: true,
      });
    }
  }

  clear(): void {
    this.resize(0);
  }

  destroy(): void {
    this.resize(0);
  }
}
