import { Container } from "pixi.js";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { DebugValueKind } from "../debug/eventTape";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";
import { SequenceHighlightRenderer } from "./renderers/SequenceHighlightRenderer";

const HIGHLIGHT_WIDTH = 3;
const HIGHLIGHT_ALPHA = 0.9;

export interface DebugValueHighlightData {
  nodes: NodeDto[];
  /** Reconstructed debug-value id lists at the current debug step (GitHub issue #131), keyed by
   *  name — e.g. `debugValues.get("recursion_stack")`. Order matters for `Sequence`-kind values
   *  (see `kindFor`); `Region`-kind values ignore order. */
  debugValues: Map<string, number[]>;
  /** Names currently toggled on in the debug panel — several may be active at once. */
  toggles: Set<string>;
  /** Resolves a toggled name's semantic kind (`DebugValueKind`) — from `debugArena.debugValueNames`,
   *  the same static declaration `debugValueNames` itself comes from. Determines which low-level
   *  renderer (`RegionHighlightRenderer` per-node fill vs. `SequenceHighlightRenderer` arrow
   *  chain) a name's layer uses. */
  kindFor: (name: string) => DebugValueKind;
  /** Resolves a debug value's highlight color — `GenerationRenderer` builds this from
   *  `buildDebugValuePalette(debugValueNames.length)` indexed by position in the declared name
   *  list — a small set of calm, analogous hues (not the full-spectrum palette regions use),
   *  varied by lightness, so simultaneously-toggled debug values read as related shades rather
   *  than clashing colors, without a hand-picked constant per name. */
  colorFor: (name: string) => number;
  cfg: TessellationConfig;
}

type RendererEntry =
  | { kind: "region"; container: Container; renderer: RegionHighlightRenderer }
  | { kind: "sequence"; container: Container; renderer: SequenceHighlightRenderer };

/** Persistent (not hover-only, unlike `DebugRefHighlightOverlay` from #130) canvas highlighting
 *  for toggled debug-value node sets (GitHub issue #131) — owned by `GenerationRenderer`, per the
 *  feature-renderer ownership rule (`maze-web/CLAUDE.md`).
 *
 *  Each debug value renders through one of two low-level renderers, picked by `kindFor`:
 *  - `Region` (e.g. `"visited"`) — `RegionHighlightRenderer`, one one-element "region" per id
 *    (`regionGroups: ids.map(id => [id])`), fill only (`skipPerimeter: true`) — a region debug
 *    value is an unordered set of unrelated members, not a contiguous area, so a per-cell
 *    perimeter would draw a closed outline around every single cell; with cell walls already
 *    rendered underneath, that reads as extra wall lines and makes real walls harder to read.
 *    Only the semi-transparent fill is drawn.
 *  - `Sequence` (e.g. `"recursion_stack"`) — `SequenceHighlightRenderer`, an open chain of arrows
 *    between consecutive ids in the list's order, reusing the graph/nav-graph edge visual
 *    (`BaseGraphRenderer.drawEdge`) — the ordering is the whole point of a sequence value.
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
      entry = kind === "sequence"
        ? { kind: "sequence", container: layerContainer, renderer: new SequenceHighlightRenderer(layerContainer) }
        : { kind: "region", container: layerContainer, renderer: new RegionHighlightRenderer(layerContainer) };
      this.renderersByName.set(name, entry);
    }
    return entry;
  }

  render(data: DebugValueHighlightData): void {
    const { nodes, debugValues, toggles, kindFor, colorFor, cfg } = data;

    for (const [name, entry] of this.renderersByName) {
      if (!toggles.has(name)) entry.renderer.clear();
    }

    if (nodes.length === 0) return;

    for (const name of toggles) {
      const ids = debugValues.get(name) ?? [];
      const kind = kindFor(name);
      const entry = this.rendererFor(name, kind);
      const color = colorFor(name);
      if (entry.kind === "sequence") {
        entry.renderer.render({ nodes, sequence: ids, color, cfg });
      } else {
        const regionGroups = ids.map((id) => [id]);
        entry.renderer.render({ nodes, regionGroups, color, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg, skipPerimeter: true });
      }
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
