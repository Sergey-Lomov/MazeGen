import type { Composition } from "./compositionModel";

export interface CompositionState {
  compositions: Composition[];
  /** Always names an entry of `compositions`, which is never empty. */
  activeCompositionId: string;
  nextCompositionNumber: number;
  nextElementNumber: number;
  /** Selected element of the active composition; `null` while none is. */
  selectedCompositionElementId: string | null;
  compositionPanelOpen: boolean;
}

export interface CompositionActions {
  /** Appends a new element of registered type `typeId` on top of the active composition and selects it. */
  addCompositionElement: (typeId: string) => void;
  removeCompositionElement: (elementId: string) => void;
  /** Moves an element to `toIndex` in the z-order (bottom is 0). */
  moveCompositionElement: (elementId: string, toIndex: number) => void;
  renameCompositionElement: (elementId: string, name: string) => void;
  setCompositionElementVisible: (elementId: string, visible: boolean) => void;
  setCompositionElementLocked: (elementId: string, locked: boolean) => void;
  selectCompositionElement: (elementId: string | null) => void;
  setCompositionPanelOpen: (open: boolean) => void;
}
