import type { StateCreator } from "zustand";
import type { MazeStore, AnalyticsOverlayState, AnalyticsOverlayActions } from "../storeTypes";

/** Legend and hover highlights that never outlive the maze they describe (GitHub issue #946). */
export const analyticsTransientUi = {
  regionClassLegendOpen: false,
  hoveredIssueLoopEdges: null,
  hoveredIssueRegionGroups: null,
} satisfies Partial<AnalyticsOverlayState>;

export const createAnalyticsOverlaySlice: StateCreator<MazeStore, [], [], AnalyticsOverlayState & AnalyticsOverlayActions> = (set) => ({
  showMazeOverlay: true,
  showComponentsOverlay: false,
  showGraphOverlay: false,
  showNavGraphOverlay: false,
  showPureCyclesOverlay: false,
  showRouteOverlay: false,
  showRegionClassesOverlay: false,
  ...analyticsTransientUi,
  analyticsSectionsExpanded: { layers: true, issues: false },
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
