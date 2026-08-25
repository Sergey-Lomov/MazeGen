import React from "react";
import { useShallow } from "zustand/react/shallow";
import { useMazeStore } from "../../store/mazeStore";
import { activeFloorTessellationOf } from "../../store/storeHelpers";
import { sharedStyles } from "../../styles/shared";
import { selectAnalyticsIssues } from "../../pixi/selectors/mazeSelectors";
import { IssuesBlock } from "../IssuesBlock";
import { ToggleRow } from "../ToggleRow";
import { SectionHeader } from "../SectionHeader";
import { SidePanel } from "../SidePanel";
import { RegionClassLegendModal, SidesInfoModal, SplitPatternStatsModal, TimingDetailedReportModal } from "./AnalyticsModals";
import { StatRow, formatMs, GraphSection, CellsSection, SidesSection, SubsectionTitle, ElementsSection, VerticalSection, StatGroup } from "./AnalyticsSections";
import { styles } from "./analyticsStyles";
import type { MazeStatisticsDto } from "../../wasm/types";
import * as m from "~/paraglide/messages";

export function DetailedReportPanel({ statistics, floors, cfg, nodes, onClose }: {
  statistics: MazeStatisticsDto;
  floors: { id: string; title: string }[];
  cfg: ReturnType<typeof activeFloorTessellationOf>;
  nodes: { x: number; y: number }[];
  onClose: () => void;
}) {
  const sectionsExpanded = useMazeStore((s) => s.analyticsSectionsExpanded);
  const setAnalyticsSectionExpanded = useMazeStore((s) => s.setAnalyticsSectionExpanded);
  const isExpanded = (id: string) => sectionsExpanded[id] ?? false;
  const toggleSection = (id: string) => setAnalyticsSectionExpanded(id, !isExpanded(id));
  const [splitPatternStatsOpen, setSplitPatternStatsOpen] = React.useState(false);
  const [sidesInfoOpen, setSidesInfoOpen] = React.useState(false);

  // `floors` (live UI state) and `statistics.*.by_floor` (a snapshot from the last generate/
  // post-edit-confirm) can desync — e.g. the user adds a floor after generating, before
  // regenerating. Only render floors the snapshot actually has stats for, so a stale/missing
  // `by_floor` entry can't crash `CellsSection`/`SidesSection`/`ElementsSection` on `undefined`.
  const floorsWithStats = floors.filter((_, idx) => statistics.cell_stats.by_floor[idx] != null);
  const floorsTopFirst = [...floorsWithStats].reverse();

  return (
    <SidePanel title={m["analytics.stats_summary"]()} onClose={onClose}>
      <div style={styles.panelBody}>
        <SectionHeader label={m["analytics.general_stats"]()} expanded={isExpanded("report_general")} onToggle={() => toggleSection("report_general")} />
        {isExpanded("report_general") && (
          <StatGroup nested>
            <SubsectionTitle label={m["analytics.graph_section"]()} />
            <StatGroup nested><GraphSection g={statistics.graph_stats} /></StatGroup>

            <SubsectionTitle label={m["analytics.cells_section"]()} />
            <StatGroup nested><CellsSection stats={statistics.cell_stats.total} cellCount={statistics.cell_count.total} /></StatGroup>

            <SubsectionTitle label={m["analytics.sides_section"]()} onOpenInfo={() => setSidesInfoOpen(true)} />
            <StatGroup nested>
              <SidesSection stats={statistics.passage_stats.total} oneWayPassages={statistics.elements_stats.total.one_way_passages} />
            </StatGroup>

            <SubsectionTitle label={m["analytics.elements_section"]()} />
            <StatGroup nested>
              <ElementsSection stats={statistics.elements_stats.total} onOpenSplitStats={() => setSplitPatternStatsOpen(true)} />
            </StatGroup>

            {statistics.graph_stats.floor_count > 1 && (
              <>
                <SubsectionTitle label={m["analytics.vertical_section"]()} />
                <StatGroup nested>
                  <VerticalSection stats={statistics.vertical_stats} />
                </StatGroup>
              </>
            )}
          </StatGroup>
        )}

        <div style={styles.divider} />

        <SectionHeader
          label={m["analytics.by_floors_count"]({ count: floorsWithStats.length })}
          expanded={isExpanded("report_by_floors")}
          onToggle={() => toggleSection("report_by_floors")}
        />
        {isExpanded("report_by_floors") && (
          <StatGroup nested>
            {floorsTopFirst.map((floor) => {
              const idx = floors.indexOf(floor);
              const sectionId = `report_floor_${floor.id}`;
              return (
                <React.Fragment key={floor.id}>
                  <SectionHeader label={floor.title} expanded={isExpanded(sectionId)} onToggle={() => toggleSection(sectionId)} />
                  {isExpanded(sectionId) && (
                    <div style={styles.floorSectionBody}>
                      <StatGroup nested>
                        <SubsectionTitle label={m["analytics.cells_section"]()} />
                        <StatGroup nested>
                          <CellsSection stats={statistics.cell_stats.by_floor[idx]} cellCount={statistics.cell_count.by_floor[idx] ?? 0} />
                        </StatGroup>

                        <SubsectionTitle label={m["analytics.sides_section"]()} onOpenInfo={() => setSidesInfoOpen(true)} />
                        <StatGroup nested>
                          <SidesSection stats={statistics.passage_stats.by_floor[idx]} oneWayPassages={statistics.elements_stats.by_floor[idx].one_way_passages} />
                        </StatGroup>

                        <SubsectionTitle label={m["analytics.elements_section"]()} />
                        <StatGroup nested>
                          <ElementsSection stats={statistics.elements_stats.by_floor[idx]} />
                        </StatGroup>

                        {statistics.graph_stats.floor_count > 1 && (
                          <>
                            <SubsectionTitle label={m["analytics.vertical_section"]()} />
                            <StatGroup nested>
                              <StatRow label={m["analytics.vertical_elevator_stop_count"]()} count={statistics.elevator_stop_count.by_floor[idx] ?? 0} />
                            </StatGroup>
                          </>
                        )}
                      </StatGroup>
                      <div style={styles.divider} />
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </StatGroup>
        )}
      </div>

      {sidesInfoOpen && <SidesInfoModal onClose={() => setSidesInfoOpen(false)} />}

      {splitPatternStatsOpen && (
        <SplitPatternStatsModal
          groups={statistics.elements_stats.total.split_groups}
          tileCount={statistics.elements_stats.total.split_tile_count}
          nodes={nodes}
          cfg={cfg}
          onClose={() => setSplitPatternStatsOpen(false)}
        />
      )}
    </SidePanel>
  );
}

export function AnalyticsFeature() {
  const generatedStatistics = useMazeStore((s) => s.statistics);
  const generatedRouteInfo = useMazeStore((s) => s.routeInfo);
  const timing = useMazeStore((s) => s.timing);
  const postEditAnalytics = useMazeStore((s) => s.postEditAnalytics);
  const issues = useMazeStore(useShallow(selectAnalyticsIssues));
  const nodes = useMazeStore((s) => s.nodes);
  const floors = useMazeStore((s) => s.floors);
  const tessellationConfig = useMazeStore((s) => activeFloorTessellationOf(s));

  const statistics = postEditAnalytics?.statistics ?? generatedStatistics;
  const routeInfo = postEditAnalytics != null ? postEditAnalytics.routeInfo : generatedRouteInfo;
  // Backend leaves region_classes empty whenever start or finish is unset — the same condition
  // the issue calls "unavailable otherwise" (independent of whether a route actually exists).
  const regionClassesUnavailable = Object.keys(statistics?.graph_stats.region_classes ?? {}).length === 0;
  const [timingReportOpen, setTimingReportOpen] = React.useState(false);
  const [detailedReportOpen, setDetailedReportOpen] = React.useState(false);

  const showMazeOverlay = useMazeStore((s) => s.showMazeOverlay);
  const showComponentsOverlay = useMazeStore((s) => s.showComponentsOverlay);
  const showGraphOverlay = useMazeStore((s) => s.showGraphOverlay);
  const showNavGraphOverlay = useMazeStore((s) => s.showNavGraphOverlay);
  const showPureCyclesOverlay = useMazeStore((s) => s.showPureCyclesOverlay);
  const showRouteOverlay = useMazeStore((s) => s.showRouteOverlay);
  const showRegionClassesOverlay = useMazeStore((s) => s.showRegionClassesOverlay);
  const regionClassLegendOpen = useMazeStore((s) => s.regionClassLegendOpen);

  const setShowMazeOverlay = useMazeStore((s) => s.setShowMazeOverlay);
  const setShowComponentsOverlay = useMazeStore((s) => s.setShowComponentsOverlay);
  const setShowGraphOverlay = useMazeStore((s) => s.setShowGraphOverlay);
  const setShowNavGraphOverlay = useMazeStore((s) => s.setShowNavGraphOverlay);
  const setShowPureCyclesOverlay = useMazeStore((s) => s.setShowPureCyclesOverlay);
  const setShowRouteOverlay = useMazeStore((s) => s.setShowRouteOverlay);
  const setShowRegionClassesOverlay = useMazeStore((s) => s.setShowRegionClassesOverlay);
  const setRegionClassLegendOpen = useMazeStore((s) => s.setRegionClassLegendOpen);

  const sectionsExpanded = useMazeStore((s) => s.analyticsSectionsExpanded);
  const setAnalyticsSectionExpanded = useMazeStore((s) => s.setAnalyticsSectionExpanded);
  const isExpanded = (id: string) => sectionsExpanded[id] ?? false;
  const toggleSection = (id: string) => setAnalyticsSectionExpanded(id, !isExpanded(id));

  return (
    <div style={styles.root}>

      <IssuesBlock issues={issues} />

      {/* Layers block */}
      <SectionHeader label={m["analytics.layers"]()} expanded={isExpanded("layers")} onToggle={() => toggleSection("layers")} />
      {isExpanded("layers") && (
        <div style={styles.toggleBlock}>
          <ToggleRow label={m["analytics.layer_maze"]()} checked={showMazeOverlay} onChange={setShowMazeOverlay} />
          <ToggleRow label={m["analytics.layer_components"]()} checked={showComponentsOverlay} onChange={setShowComponentsOverlay} />
          <ToggleRow label={m["analytics.layer_graph"]()} checked={showGraphOverlay} onChange={setShowGraphOverlay} />
          <ToggleRow label={m["analytics.layer_nav_graph"]()} checked={showNavGraphOverlay} onChange={setShowNavGraphOverlay} />
          <ToggleRow label={m["analytics.layer_pure_cycles"]()} checked={showPureCyclesOverlay} onChange={setShowPureCyclesOverlay} disabled={(statistics?.graph_stats.cycle_count ?? 0) === 0} />
          <ToggleRow label={m["analytics.layer_route"]()} checked={showRouteOverlay} onChange={setShowRouteOverlay} disabled={routeInfo == null} />
          <ToggleRow
            label={m["analytics.layer_region_classes"]()}
            checked={showRegionClassesOverlay}
            onChange={setShowRegionClassesOverlay}
            disabled={regionClassesUnavailable}
            info={() => setRegionClassLegendOpen(true)}
          />
        </div>
      )}

      {regionClassLegendOpen && <RegionClassLegendModal onClose={() => setRegionClassLegendOpen(false)} />}

      {/* Path block — hidden when no route */}
      {routeInfo != null && (
        <>
          <div style={styles.divider} />
          <SectionHeader label={m["analytics.path"]()} expanded={isExpanded("path")} onToggle={() => toggleSection("path")} />
          {isExpanded("path") && (
            <div style={styles.statBlock}>
              <StatRow label={m["analytics.path_length"]()} count={routeInfo.path_length} />
              <StatRow label={m["analytics.junction_count"]()} count={routeInfo.junction_count} />
              <StatRow label={m["analytics.one_way_count"]()} count={routeInfo.one_way_count} />
              <StatRow label={m["analytics.split_count"]()} count={routeInfo.split_count} />
              {routeInfo.score != null && (
                <div style={styles.scoreRow}>
                  <span style={styles.statLabel}>{m["analytics.score"]()}</span>
                  <span style={styles.statCount}>{routeInfo.score.toFixed(2)}</span>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Summary statistics block — GitHub issue #364 */}
      {statistics != null && (
        <>
          <div style={styles.divider} />
          <SectionHeader label={m["analytics.stats_summary"]()} expanded={isExpanded("stats_summary")} onToggle={() => toggleSection("stats_summary")} />
          {isExpanded("stats_summary") && (
            <div style={styles.statBlock}>
              <StatRow label={m["analytics.floor_count"]()} count={statistics.graph_stats.floor_count} />
              <StatRow label={m["analytics.cell_count"]()} count={statistics.cell_count.total} />
              <StatRow label={m["analytics.graph_components"]()} count={statistics.graph_stats.component_count} />
              <StatRow label={m["analytics.graph_cycle_count"]()} count={statistics.graph_stats.cycle_count} />
              <StatRow label={m["analytics.graph_average_degree"]()} valueText={statistics.graph_stats.average_degree.toFixed(2)} />
              <button className="hoverable" style={{ ...sharedStyles.btnMuted, ...styles.patternStatsButton }} onClick={() => setDetailedReportOpen(true)}>
                {m["analytics.detailed_report_button"]()}
              </button>
            </div>
          )}
        </>
      )}

      {detailedReportOpen && statistics != null && (
        <DetailedReportPanel
          statistics={statistics}
          floors={floors}
          cfg={tessellationConfig}
          nodes={nodes}
          onClose={() => setDetailedReportOpen(false)}
        />
      )}

      {/* Timing block — generation runs only, see GitHub issue #56 */}
      {timing != null && (() => {
        const qcTotalMs = timing.qc.reduce((s, n) => s + n.total_ms, 0);
        const totalMs = timing.initial_build_ms + qcTotalMs + timing.snapshot_ms;
        return (
          <>
            <div style={styles.divider} />
            <SectionHeader label={m["analytics.timing"]()} expanded={isExpanded("timing")} onToggle={() => toggleSection("timing")} />
            {isExpanded("timing") && (
              <div style={styles.statBlock}>
                <StatRow label={m["analytics.timing_total"]()} valueText={formatMs(totalMs)} />
                <StatRow label={m["analytics.timing_initial_build"]()} valueText={formatMs(timing.initial_build_ms)} />
                <StatRow label={m["analytics.timing_qc_total"]()} valueText={formatMs(qcTotalMs)} />
                <StatRow label={m["analytics.timing_snapshot"]()} valueText={formatMs(timing.snapshot_ms)} />
                <button className="hoverable" style={{ ...sharedStyles.btnMuted, ...styles.patternStatsButton }} onClick={() => setTimingReportOpen(true)}>
                  {m["analytics.timing_detailed_report_button"]()}
                </button>
              </div>
            )}
          </>
        );
      })()}

      {timingReportOpen && timing != null && (
        <TimingDetailedReportModal timing={timing} onClose={() => setTimingReportOpen(false)} />
      )}

    </div>
  );
}

export type { TimingRowKind } from "./AnalyticsModals";
export { leafKind, resolveTimingRowLabel, TimingDetailedReportModal } from "./AnalyticsModals";
