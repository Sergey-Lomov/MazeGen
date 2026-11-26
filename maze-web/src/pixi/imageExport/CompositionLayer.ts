import { Container } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import type { Composition } from "../../composition/compositionModel";
import { COMPOSITION_ELEMENT_DISPLAYS } from "./compositionElementDisplays";

/** The Pixi object built for one element, kept while its `type` and `data` stay the same. */
interface BuiltDisplay {
  type: string;
  data: unknown;
  display: Container;
}

/** Draws the active composition's visible elements on the main canvas, bottom of the z-order first (GitHub issue #1099).
 *  Owned by `ImageExportRenderer`. It knows only the common element shell: each element's Pixi object comes from
 *  its type's display factory. An element of a type without a factory is skipped. A display is reused across
 *  rebuilds while its element's `type` and `data` are unchanged (data is replaced, never mutated), so a rename,
 *  a lock or a reorder does not recreate it. */
export class CompositionLayer {
  private readonly root: Container;
  private unsubscribe: (() => void) | null = null;
  private shown: Composition | undefined;
  private readonly built = new Map<string, BuiltDisplay>();

  constructor(parent: Container) {
    this.root = new Container();
    parent.addChild(this.root);
    this.rebuild(activeComposition(useMazeStore.getState()));
    this.unsubscribe = useMazeStore.subscribe((state) => {
      const active = activeComposition(state);
      if (active !== this.shown) this.rebuild(active);
    });
  }

  private rebuild(composition: Composition | undefined): void {
    this.shown = composition;
    const kept = new Set<string>();
    const ordered: Container[] = [];
    for (const element of composition?.elements ?? []) {
      if (!element.visible) continue;
      const factory = COMPOSITION_ELEMENT_DISPLAYS[element.type];
      if (!factory) continue;
      let entry = this.built.get(element.id);
      if (!entry || entry.type !== element.type || entry.data !== element.data) {
        entry?.display.destroy({ children: true });
        entry = { type: element.type, data: element.data, display: factory(element.data) };
        this.built.set(element.id, entry);
      }
      kept.add(element.id);
      ordered.push(entry.display);
    }
    // Hidden or removed elements lose their display; it is rebuilt when they come back.
    for (const [id, entry] of this.built) {
      if (kept.has(id)) continue;
      entry.display.destroy({ children: true });
      this.built.delete(id);
    }
    // `removeChildren` detaches without destroying, so the reused displays survive the reorder.
    this.root.removeChildren();
    for (const display of ordered) this.root.addChild(display);
  }

  destroy(): void {
    this.unsubscribe?.();
    this.built.clear();
    this.root.destroy({ children: true });
  }
}

function activeComposition(state: ReturnType<typeof useMazeStore.getState>): Composition | undefined {
  return state.compositions.find((c) => c.id === state.activeCompositionId);
}
