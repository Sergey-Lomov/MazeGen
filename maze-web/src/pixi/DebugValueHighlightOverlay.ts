import { Container } from "pixi.js";
import type { SeamHopContext } from "./graphSeams";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import type { DebugValueKind } from "../debug/eventTape";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";
import { SequenceHighlightRenderer } from "./renderers/SequenceHighlightRenderer";
import { MapHighlightRenderer } from "./renderers/MapHighlightRenderer";
import { VertexHighlightRenderer } from "./renderers/VertexHighlightRenderer";

const HIGHLIGHT_WIDTH = 3;
const HIGHLIGHT_ALPHA = 0.9;

export interface DebugValueHighlightData {
  nodes: NodeDto[];
  /** Reconstructed debug-value id lists at the current debug step (GitHub issue #131), keyed by
   *  name — e.g. `debugValues.get("recursion_stack")`. Order matters for `Sequence`-kind values
   *  (see `kindFor`); `Region`-kind values ignore order. Not used for `Map`-kind names — those
   *  read from `debugMaps` instead. */
  debugValues: Map<string, number[]>;
  /** Reconstructed map debug-value state at the current debug step (GitHub issue #145's
   *  follow-up), keyed by name — e.g. `debugMaps.get("current_walk")`. Only consulted for names
   *  whose `kindFor` resolves to `"map"`. */
  debugMaps: Map<string, Map<number, number>>;
  /** Reconstructed vertex debug-value state at the current debug step (GitHub issue #145's
   *  follow-up), keyed by name — e.g. `debugVertices.get("walk_head")`. Only consulted for names
   *  whose `kindFor` resolves to `"vertex"`. */
  debugVertices: Map<string, number | null>;
  /** Names currently toggled on in the debug panel — several may be active at once. */
  toggles: Set<string>;
  /** Resolves a toggled name's semantic kind (`DebugValueKind`) — from `debugArena.debugValueNames`,
   *  the same static declaration `debugValueNames` itself comes from. Determines which low-level
   *  renderer (`RegionHighlightRenderer` per-node fill vs. `SequenceHighlightRenderer` arrow
   *  chain) a name's layer uses. */
  kindFor: (name: string) => DebugValueKind;
  /** Resolves a debug value's highlight color — `GenerationRenderer` builds this via
   *  `resolveDebugValueColor` (GitHub issue #164): a predefined color per (algorithm, name) pair
   *  where one exists, so a name like `"visited"` reads consistently across runs of the same
   *  algorithm, falling back to a stable slot in the non-toxic random-looking palette
   *  (`colorUtils.ts`'s `buildPalette`) for undeclared names. */
  colorFor: (name: string) => number;
  /** Region-valued names that must remain one independent cell per value item instead of being
   *  merged into connected contours. Used by CustomVertexBased's frontier/reserve sets. */
  singleCellRegionNames?: ReadonlySet<string>;
  cfg: FieldConfig;
  /** Seam hop context (GitHub issue #841): a sequence or map arrow across a glue ends at its contour. */
  seam?: SeamHopContext;
}

type RendererEntry =
  | { kind: "region"; container: Container; renderer: RegionHighlightRenderer }
  | { kind: "sequence"; container: Container; renderer: SequenceHighlightRenderer }
  | { kind: "map"; container: Container; renderer: MapHighlightRenderer }
  | { kind: "vertex"; container: Container; renderer: VertexHighlightRenderer };

/** Persistent (not hover-only, unlike `DebugRefHighlightOverlay` from #130) canvas highlighting
 *  for toggled debug-value node sets (GitHub issue #131) — owned by `GenerationRenderer`, per the
 *  feature-renderer ownership rule (`maze-web/CLAUDE.md`).
 *
 *  Each debug value renders through one of three low-level renderers, picked by `kindFor`:
 *  - `Region` (e.g. `"visited"`) — `RegionHighlightRenderer`, one one-element "region" per id
 *    (`regionGroups: ids.map(id => [id])`), fill only (`skipPerimeter: true`) — a region debug
 *    value is an unordered set of unrelated members, not a contiguous area, so a per-cell
 *    perimeter would draw a closed outline around every single cell; with cell walls already
 *    rendered underneath, that reads as extra wall lines and makes real walls harder to read.
 *    Only the semi-transparent fill is drawn.
 *  - `Sequence` (e.g. `"recursion_stack"`) — `SequenceHighlightRenderer`, an open chain of arrows
 *    between consecutive ids in the list's order, reusing the graph/nav-graph edge visual
 *    (`BaseGraphRenderer.drawEdge`) — the ordering is the whole point of a sequence value.
 *  - `Map` (e.g. Wilson's `"current_walk"`, GitHub issue #145's follow-up) — `MapHighlightRenderer`,
 *    one independent directed arrow per key -> value pair (not a chain — pairs don't connect to
 *    each other, unlike `Sequence`).
 *  - `Vertex` (e.g. Wilson's `"walk_start"`/`"walk_head"`, GitHub issue #145's follow-up) —
 *    `VertexHighlightRenderer`, one enlarged filled circle at the slot's current occupant — a
 *    single reassignable node id, not a set or a chain.
 *
 *  Holds one renderer instance (and one child `Container`) *per debug-value name*, not one shared
 *  instance/call for every active toggle merged together — per explicit product direction:
 *  different debug values get independently distinct colors, and merging today would mean
 *  rewriting this class then instead of just changing what `colorFor` returns. Layers are created
 *  lazily as new names are toggled on and kept (cleared, not destroyed) when toggled off, so
 *  re-enabling a value doesn't pay reconstruction cost. If a name's `kind` changes between renders
 *  (shouldn't happen — `kindFor` is a static per-run declaration — but guarded defensively), the
 *  stale-kind entry is destroyed and rebuilt rather than fed data it can't render. */
export class DebugValueHighlightOverlay {
  private readonly container: Container;
  private readonly renderersByName = new Map<string, RendererEntry>();

  constructor(container: Container) {
    this.container = container;
  }

  private rendererFor(name: string, kind: DebugValueKind): RendererEntry {
    let entry = this.renderersByName.get(name);
    if (entry && entry.kind !== kind) {
      entry.renderer.destroy();
      entry.container.destroy();
      entry = undefined;
    }
    if (!entry) {
      const layerContainer = new Container();
      this.container.addChild(layerContainer);
      // `switch` (not a ternary chain) so TS's exhaustiveness check catches a future 5th
      // `DebugValueKind` at compile time instead of it silently falling into the `region` branch.
      switch (kind) {
        case "sequence":
          entry = { kind: "sequence", container: layerContainer, renderer: new SequenceHighlightRenderer(layerContainer) };
          break;
        case "map":
          entry = { kind: "map", container: layerContainer, renderer: new MapHighlightRenderer(layerContainer) };
          break;
        case "vertex":
          entry = { kind: "vertex", container: layerContainer, renderer: new VertexHighlightRenderer(layerContainer) };
          break;
        case "region":
          entry = { kind: "region", container: layerContainer, renderer: new RegionHighlightRenderer(layerContainer) };
          break;
      }
      this.renderersByName.set(name, entry);
    }
    return entry;
  }

  render(data: DebugValueHighlightData): void {
    const { nodes, debugValues, debugMaps, debugVertices, toggles, kindFor, colorFor, singleCellRegionNames, cfg, seam } = data;

    for (const [name, entry] of this.renderersByName) {
      if (!toggles.has(name)) entry.renderer.clear();
    }

    if (nodes.length === 0) return;

    for (const name of toggles) {
      const kind = kindFor(name);
      const entry = this.rendererFor(name, kind);
      const color = colorFor(name);
      // `switch` on `entry.kind` (not `if`/`else if`/`else`) so TS's exhaustiveness check catches
      // a future 5th `RendererEntry` kind at compile time instead of it silently falling into the
      // `region` branch.
      switch (entry.kind) {
        case "sequence": {
          const ids = debugValues.get(name) ?? [];
          entry.renderer.render({ nodes, sequence: ids, color, cfg, seam });
          break;
        }
        case "map": {
          const entries = debugMaps.get(name) ?? new Map();
          entry.renderer.render({ nodes, entries, color, cfg, seam });
          break;
        }
        case "vertex": {
          const id = debugVertices.get(name) ?? null;
          entry.renderer.render({ nodes, id, color, cfg });
          break;
        }
        case "region": {
          const ids = debugValues.get(name) ?? [];
          // Most region values are one connected region and should merge adjacent cells into one
          // contour. Frontier/reserve in CustomVertexBased are working sets, where each cell is a
          // separate item even when adjacent, so keep those as independent one-cell groups.
          const regionGroups = singleCellRegionNames?.has(name)
            ? ids.map((id) => [id])
            : ids.length > 0 ? [ids] : [];
          entry.renderer.render({ nodes, regionGroups, color, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg, skipPerimeter: true });
          break;
        }
      }
    }

    // `Vertex` layers (e.g. Wilson's `"walk_start"`/`"walk_head"`) always draw on top of `Map`
    // layers (e.g. `"current_walk"`) regardless of toggle order — a walk's endpoint markers would
    // otherwise be hidden under the pair-arrow layer whenever that name happened to be toggled on
    // later. Only re-appends a vertex layer's container when it isn't already last — `render()`
    // runs on every debug-step tick during scrubbing/autoplay, and `Container.addChild` always
    // does a real splice + dirties Pixi's render group even when the child is already in place, so
    // skipping the no-op case matters on a path that already runs at UI-interaction frequency.
    const lastChild = this.container.children[this.container.children.length - 1];
    let topContainer = lastChild;
    for (const entry of this.renderersByName.values()) {
      if (entry.kind !== "vertex") continue;
      if (entry.container !== topContainer) {
        this.container.addChild(entry.container);
      }
      topContainer = entry.container;
    }
  }

  clear(): void {
    for (const { renderer } of this.renderersByName.values()) renderer.clear();
  }

  destroy(): void {
    for (const { renderer, container } of this.renderersByName.values()) {
      renderer.destroy();
      container.destroy();
    }
    this.renderersByName.clear();
  }
}
