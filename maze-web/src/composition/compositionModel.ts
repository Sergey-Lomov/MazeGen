/** Export composition data model (GitHub issue #1099, `Specs/composition.md`).
 *
 * A composition is an ordered list of heterogeneous elements drawn on the main canvas, in its world units. The list, the canvas
 * and the project file only know the common `CompositionElement` shell; everything specific to an element
 * type lives in its opaque `data`, owned by that type's `CompositionElementType` (`elementTypes.ts`). */

/** One element of a composition. `data` is validated, created and drawn only by the element's type. */
export interface CompositionElement {
  id: string;
  /** Id of a registered `CompositionElementType`. */
  type: string;
  name: string;
  visible: boolean;
  /** A locked element is protected from edits: it cannot be removed, renamed or moved in the list. */
  locked: boolean;
  data: unknown;
}

export interface Composition {
  id: string;
  name: string;
  /** Z-order, bottom first: the last element is drawn on top. */
  elements: CompositionElement[];
}

export function emptyComposition(id: string, name: string): Composition {
  return { id, name, elements: [] };
}

export function withElementAdded(composition: Composition, element: CompositionElement): Composition {
  return { ...composition, elements: [...composition.elements, element] };
}

export function withElementRemoved(composition: Composition, elementId: string): Composition {
  const target = composition.elements.find((e) => e.id === elementId);
  if (!target || target.locked) return composition;
  return { ...composition, elements: composition.elements.filter((e) => e.id !== elementId) };
}

/** Moves an element to `toIndex` in the z-order (clamped); a locked element stays where it is. */
export function withElementMoved(composition: Composition, elementId: string, toIndex: number): Composition {
  const from = composition.elements.findIndex((e) => e.id === elementId);
  if (from < 0 || composition.elements[from].locked) return composition;
  const to = Math.max(0, Math.min(composition.elements.length - 1, toIndex));
  if (to === from) return composition;
  const elements = [...composition.elements];
  const [moved] = elements.splice(from, 1);
  elements.splice(to, 0, moved);
  return { ...composition, elements };
}

/** Patches one element; a patch that changes nothing returns the same composition, so subscribers (the canvas layer) do not rebuild. */
export function withElementPatched(composition: Composition, elementId: string, patch: Partial<Pick<CompositionElement, "name" | "visible" | "locked">>): Composition {
  const target = composition.elements.find((e) => e.id === elementId);
  if (!target || (Object.keys(patch) as (keyof typeof patch)[]).every((k) => target[k] === patch[k])) return composition;
  return { ...composition, elements: composition.elements.map((e) => (e.id === elementId ? { ...e, ...patch } : e)) };
}
