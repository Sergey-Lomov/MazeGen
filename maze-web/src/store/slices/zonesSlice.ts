import type { StateCreator } from "zustand";
import type { MazeStore, ZonesState, ZonesActions } from "../storeTypes";

/** Zones are not saved in the project file yet, so loading a project resets them with the toggles. */
export const zonesTransientUi = {
  zones: [],
  nextZoneId: 1,
  showAutoZones: true,
  showManualZones: true,
  hiddenZoneIds: [],
  zonesPanelOpen: false,
  zonesListMode: "auto",
  hoveredZoneId: null,
} satisfies Partial<ZonesState>;

export const createZonesSlice: StateCreator<MazeStore, [], [], ZonesState & ZonesActions> = (set) => ({
  ...zonesTransientUi,

  setShowAutoZones: (v) => set({ showAutoZones: v }),
  setShowManualZones: (v) => set({ showManualZones: v }),
  setZonesPanelOpen: (open) => set(open ? { zonesPanelOpen: true } : { zonesPanelOpen: false, hoveredZoneId: null }),
  setZonesListMode: (mode) => set({ zonesListMode: mode, hoveredZoneId: null }),
  setHoveredZone: (id) => set({ hoveredZoneId: id }),
  toggleZoneVisibility: (id) => set((s) => ({
    hiddenZoneIds: s.hiddenZoneIds.includes(id) ? s.hiddenZoneIds.filter((hidden) => hidden !== id) : [...s.hiddenZoneIds, id],
  })),
  // An unnamed zone shows as `#id` (`zoneDisplayName`).
  addManualZone: () => set((s) => ({
    zones: [...s.zones, { id: s.nextZoneId, name: "", kind: "manual", cells: [] }],
    nextZoneId: s.nextZoneId + 1,
  })),
  removeZone: (id) => set((s) => ({
    zones: s.zones.filter((zone) => zone.id !== id),
    hiddenZoneIds: s.hiddenZoneIds.filter((hidden) => hidden !== id),
    hoveredZoneId: s.hoveredZoneId === id ? null : s.hoveredZoneId,
  })),
});
