import type { StateCreator } from "zustand";
import type { MazeStore } from "../storeTypes";
import type { CompositionState, CompositionActions } from "../../composition/compositionTypes";
import { emptyComposition, withElementAdded, withElementMoved, withElementPatched, withElementRemoved, type Composition } from "../../composition/compositionModel";
import { resolveElementType } from "../../composition/elementTypes";

/** Resting value of the composition selection and panel; loading a project resets them. */
export const compositionTransientUi = {
  selectedCompositionElementId: null,
  compositionPanelOpen: false,
} satisfies Partial<CompositionState>;

export const DEFAULT_COMPOSITION_ID = "composition_1";

export function defaultCompositionState(): Pick<CompositionState, "compositions" | "activeCompositionId" | "nextCompositionNumber" | "nextElementNumber"> {
  return {
    compositions: [emptyComposition(DEFAULT_COMPOSITION_ID, "Composition 1")],
    activeCompositionId: DEFAULT_COMPOSITION_ID,
    nextCompositionNumber: 2,
    nextElementNumber: 1,
  };
}

function activeOf(s: CompositionState): Composition | undefined {
  return s.compositions.find((c) => c.id === s.activeCompositionId);
}

/** Applies `edit` to the active composition; an edit that changes nothing leaves the state untouched. */
function editActive(s: CompositionState, edit: (c: Composition) => Composition): Pick<CompositionState, "compositions"> | Record<string, never> {
  const current = activeOf(s);
  if (!current) return {};
  const edited = edit(current);
  if (edited === current) return {};
  return { compositions: s.compositions.map((c) => (c === current ? edited : c)) };
}

export const createCompositionSlice: StateCreator<MazeStore, [], [], CompositionState & CompositionActions> = (set) => ({
  ...defaultCompositionState(),
  ...compositionTransientUi,

  addCompositionElement: (typeId) => set((s) => {
    const type = resolveElementType(typeId);
    if (!type) return {};
    const ordinal = (activeOf(s)?.elements.filter((e) => e.type === typeId).length ?? 0) + 1;
    const id = `element_${s.nextElementNumber}`;
    const element = { id, type: typeId, name: type.defaultName(ordinal), visible: true, locked: false, data: type.createData(ordinal) };
    return {
      ...editActive(s, (c) => withElementAdded(c, element)),
      nextElementNumber: s.nextElementNumber + 1,
      selectedCompositionElementId: id,
    };
  }),
  removeCompositionElement: (elementId) => set((s) => {
    if (activeOf(s)?.elements.find((e) => e.id === elementId)?.locked !== false) return {};
    return {
      ...editActive(s, (c) => withElementRemoved(c, elementId)),
      selectedCompositionElementId: s.selectedCompositionElementId === elementId ? null : s.selectedCompositionElementId,
    };
  }),
  moveCompositionElement: (elementId, toIndex) => set((s) => editActive(s, (c) => withElementMoved(c, elementId, toIndex))),
  renameCompositionElement: (elementId, name) => set((s) => {
    const trimmed = name.trim();
    const target = activeOf(s)?.elements.find((e) => e.id === elementId);
    if (!target || target.locked || trimmed === "" || trimmed === target.name) return {};
    return editActive(s, (c) => withElementPatched(c, elementId, { name: trimmed }));
  }),
  setCompositionElementVisible: (elementId, visible) => set((s) => editActive(s, (c) => withElementPatched(c, elementId, { visible }))),
  setCompositionElementLocked: (elementId, locked) => set((s) => editActive(s, (c) => withElementPatched(c, elementId, { locked }))),
  selectCompositionElement: (elementId) => set({ selectedCompositionElementId: elementId }),
  setCompositionPanelOpen: (open) => set({ compositionPanelOpen: open }),
});
