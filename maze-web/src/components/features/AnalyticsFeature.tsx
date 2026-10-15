import React from "react";
import { useShallow } from "zustand/react/shallow";
import { useMazeStore } from "../../store/mazeStore";
import { activeFloorTessellationOf } from "../../store/storeHelpers";
import { Button } from "../Button";
import { selectAnalyticsIssues } from "../../pixi/selectors/mazeSelectors";
import { IssuesBlock } from "../IssuesBlock";
import { ToggleRow } from "../ToggleRow";
import { SectionHeader } from "../SectionHeader";
import { SidePanel } from "../SidePanel";
import { RegionClassLegendModal, ScoreInfoModal, SidesInfoModal, SplitPatternStatsModal, TimingDetailedReportModal } from "./AnalyticsModals";
import { StatRow, formatMs, formatScore, GraphSection, CellsSection, SidesSection, SubsectionTitle, ElementsSection, VerticalSection, StatGroup } from "./AnalyticsSections";
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
  const fieldConfig = useMazeStore((s) => activeFloorTessellationOf(s));

  const statistics = postEditAnalytics?.statistics ?? generatedStatistics;
  const routeInfo = postEditAnalytics != null ? postEditAnalytics.routeInfo : generatedRouteInfo;
  // Backend leaves region_classes empty whenever start or finish is unset — the same condition
  // the issue calls "unavailable otherwise" (independent of whether a route actually exists).
  const regionClassesUnavailable = Object.keys(statistics?.graph_stats.region_classes ?? {}).length === 0;
  const [timingReportOpen, setTimingReportOpen] = React.useState(false);
  const [detailedReportOpen, setDetailedReportOpen] = React.useState(false);
  const [scoreInfoOpen, setScoreInfoOpen] = React.useState(false);

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

      {/* Path block — visible whenever start/finish are both set (same gate the backend uses for
          `region_classes`, see `regionClassesUnavailable` above), even if no route connects them
          (GitHub issue #534) — shows a "no path" notice instead of disappearing, so the maze
          state (disconnected regions) doesn't look like a missing feature. Each element-type row
          (GitHub issue #531) shows only when the maze has at least one instance of that element,
          maze-wide — otherwise it's skipped entirely rather than showing a misleading
          always-zero row. */}
      {!regionClassesUnavailable && (
        <>
          <div style={styles.divider} />
          <SectionHeader label={m["analytics.path"]()} expanded={isExpanded("path")} onToggle={() => toggleSection("path")} />
          {isExpanded("path") && (
            <div style={styles.topLevelStatBlock}>
              {routeInfo == null ? (
                <div style={styles.noRouteText}>{m["analytics.no_route"]()}</div>
              ) : (
                <>
                  {routeInfo.score != null && (
                    <StatRow
                      label={m["analytics.score"]()}
                      valueText={formatScore(routeInfo.score)}
                      onOpenInfo={() => setScoreInfoOpen(true)}
                    />
                  )}
                  <StatRow label={m["analytics.path_length"]()} count={routeInfo.path_length} />
                  <StatRow label={m["analytics.junction_count"]()} count={routeInfo.junction_count} />
                  {(statistics?.elements_stats.total.one_way_passages ?? 0) > 0 && (
                    <StatRow label={m["analytics.one_way_count"]()} count={routeInfo.one_way_count} />
                  )}
                  {(statistics != null && (statistics.elements_stats.total.two_way_teleports + statistics.elements_stats.total.one_way_teleports) > 0) && (
                    <StatRow label={m["analytics.teleport_count"]()} count={routeInfo.teleport_count} />
                  )}
                  {(statistics?.elements_stats.total.split_tile_count ?? 0) > 0 && (
                    <StatRow label={m["analytics.split_count"]()} count={routeInfo.split_count} />
                  )}
                  {(statistics?.vertical_stats.bidirectional_passages ?? 0) > 0 && (
                    <StatRow label={m["analytics.vertical_bidirectional_count"]()} count={routeInfo.vertical_bidirectional_count} />
                  )}
                  {(statistics != null && (statistics.vertical_stats.one_way_passages_up + statistics.vertical_stats.one_way_passages_down) > 0) && (
                    <StatRow label={m["analytics.vertical_one_way_count"]()} count={routeInfo.vertical_one_way_count} />
                  )}
                  {(statistics?.vertical_stats.elevator_groups ?? 0) > 0 && (
                    <StatRow label={m["analytics.elevator_count"]()} count={routeInfo.elevator_count} />
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      {scoreInfoOpen && <ScoreInfoModal onClose={() => setScoreInfoOpen(false)} />}

      {/* Summary statistics block — GitHub issue #364 */}
      {statistics != null && (
        <>
          <div style={styles.divider} />
          <SectionHeader label={m["analytics.stats_summary"]()} expanded={isExpanded("stats_summary")} onToggle={() => toggleSection("stats_summary")} />
          {isExpanded("stats_summary") && (
            <div style={styles.topLevelStatBlock}>
              <StatRow label={m["analytics.floor_count"]()} count={statistics.graph_stats.floor_count} />
              <StatRow label={m["analytics.cell_count"]()} count={statistics.cell_count.total} />
              <StatRow label={m["analytics.graph_components"]()} count={statistics.graph_stats.component_count} />
              <StatRow label={m["analytics.graph_cycle_count"]()} count={statistics.graph_stats.cycle_count} />
              <StatRow label={m["analytics.graph_average_degree"]()} valueText={statistics.graph_stats.average_degree.toFixed(2)} />
              <Button variant="secondary" layoutStyle={styles.patternStatsButton} onClick={() => setDetailedReportOpen(true)}>
                {m["analytics.detailed_report_button"]()}
              </Button>
            </div>
          )}
        </>
      )}

      {detailedReportOpen && statistics != null && (
        <DetailedReportPanel
          statistics={statistics}
          floors={floors}
          cfg={fieldConfig}
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
              <div style={styles.topLevelStatBlock}>
                <StatRow label={m["analytics.timing_total"]()} valueText={formatMs(totalMs)} />
                <StatRow label={m["analytics.timing_initial_build"]()} valueText={formatMs(timing.initial_build_ms)} />
                <StatRow label={m["analytics.timing_qc_total"]()} valueText={formatMs(qcTotalMs)} />
                <StatRow label={m["analytics.timing_snapshot"]()} valueText={formatMs(timing.snapshot_ms)} />
                <Button variant="secondary" layoutStyle={styles.patternStatsButton} onClick={() => setTimingReportOpen(true)}>
                  {m["analytics.timing_detailed_report_button"]()}
                </Button>
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
