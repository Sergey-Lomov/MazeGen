import { beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import type { FieldConfig } from "../fieldConfig";
import { fieldOf } from "./fieldConfigFixtures";
import { resetNotifications } from "../notifications/notificationStore";

/** Patches the active floor's own field config — presetConnectionsSlice reads fieldConfig/
 * fieldPoints/isEditingField through floorFields[activeFloorId] (GitHub issue #338). */
export function setActiveFieldConfig(patch: { fieldConfig?: FieldConfig; isEditingField?: boolean; fieldPoints?: Set<number> }) {
  const state = useMazeStore.getState();
  useMazeStore.setState({
    floorFields: {
      ...state.floorFields,
      [state.activeFloorId]: { ...state.floorFields[state.activeFloorId], ...patch },
    },
  });
}

/** Resets notifications and the store to a 3x3 square field with empty preset state. */
export function resetPresetState() {
  resetNotifications();
  useMazeStore.setState(baseStoreState());
  useMazeStore.setState({
    tessellationKind: "square",
    presetConnections: new Map(),
    lockedNodes: new Map(),
    autoLockedNodes: new Set(),
    autoLock: true,
    defaultEdgeState: "undefined",
  });
  setActiveFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }), isEditingField: false, fieldPoints: new Set<number>() });
}

/** Shared `beforeEach` for the `presetConnectionsSlice.*.test.ts` files. */
export function usePresetStateReset() {
  beforeEach(resetPresetState);
}

/** Appends a floor whose field config is a copy of the active floor's (in-bounds points all exist). */
export function addFloor(id: string, title: string) {
  const state = useMazeStore.getState();
  useMazeStore.setState({
    floors: [...state.floors, { id, title }],
    floorFields: { ...state.floorFields, [id]: { ...state.floorFields[state.activeFloorId] } },
  });
}
