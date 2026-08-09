import type { StateCreator } from "zustand";
import type { MazeStore, AnalyticsOverlayState, AnalyticsOverlayActions } from "../storeTypes";

export const createAnalyticsOverlaySlice: StateCreator<MazeStore, [], [], AnalyticsOverlayState & AnalyticsOverlayActions> = (set) => ({
  showMazeOverlay: true,
  showComponentsOverlay: false,
  showGraphOverlay: false,
  showNavGraphOverlay: false,
  showPureCyclesOverlay: false,
  showRouteOverlay: false,
  showRegionClassesOverlay: false,
  regionClassLegendOpen: false,
  hoveredIssueLoopEdges: null,
  hoveredIssueRegionGroups: null,
  analyticsSectionsExpanded: { layers: true, issues: true },
  showFullyPresetLockedIssues: true,

  setShowMazeOverlay: (v) => set({ showMazeOverlay: v }),
  setShowComponentsOverlay: (v) => set({ showComponentsOverlay: v }),
  setShowGraphOverlay: (v) => set({ showGraphOverlay: v }),
  setShowNavGraphOverlay: (v) => set({ showNavGraphOverlay: v }),
  setShowPureCyclesOverlay: (v) => set({ showPureCyclesOverlay: v }),
  setShowRouteOverlay: (v) => set({ showRouteOverlay: v }),
  setShowRegionClassesOverlay: (v) => set({ showRegionClassesOverlay: v }),
  setRegionClassLegendOpen: (v) => set({ regionClassLegendOpen: v }),
  setHoveredIssueLoopEdges: (edges) => set({ hoveredIssueLoopEdges: edges }),
  setHoveredIssueRegionGroups: (groups) => set({ hoveredIssueRegionGroups: groups }),
  setAnalyticsSectionExpanded: (id, expanded) =>
    set((s) => ({ analyticsSectionsExpanded: { ...s.analyticsSectionsExpanded, [id]: expanded } })),
  setShowFullyPresetLockedIssues: (v) => set({ showFullyPresetLockedIssues: v }),
});
