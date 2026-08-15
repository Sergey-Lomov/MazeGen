import React from "react";
import { useShallow } from "zustand/react/shallow";
import { useMazeStore } from "../../store/mazeStore";
import { activeFloorTessellationOf } from "../../store/storeHelpers";
import { ui, typography, muted, disabled, spacing, indent, dialogSpacing } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import { selectAnalyticsIssues } from "../../pixi/selectors/mazeSelectors";
import { IssuesBlock } from "../IssuesBlock";
import { ToggleRow } from "../ToggleRow";
import { SectionHeader } from "../SectionHeader";
import { Modal } from "../Modal";
import { SidePanel } from "../SidePanel";
import { canvas } from "../../pixi/colorTokens";
import { TileFaceEditor } from "./TileFaceEditor";
import { tileNodesForTopology } from "../../pixi/splitPatternTile";
import { titleKeyForTopology } from "../../pixi/splitPatternTitles";
import { resolveCheckLabel, resolveStrategyLabel } from "./qualityI18n";
import type { SplitGroupDto, TimingNodeDto, GenerationTimingDto, NodeStatsDto, SpatialEdgeStatsDto, ElementsStatsDto } from "../../wasm/types";
import * as m from "~/paraglide/messages";

const SPLIT_PREVIEW_ANCHOR: [number, number] = [0, 0];
const NOOP_FACE = () => {};
const NOOP_ROTATE = () => {};

const SPLIT_PATTERN_TITLES: Record<string, () => string> = {
  "split_pattern_title.split_fork": () => m["split_pattern_title.split_fork"](),
  "split_pattern_title.bridge": () => m["split_pattern_title.bridge"](),
  "split_pattern_title.diagonal_divider": () => m["split_pattern_title.diagonal_divider"](),
  "split_pattern_title.double_bridge": () => m["split_pattern_title.double_bridge"](),
  "split_pattern_title.triple_corridor": () => m["split_pattern_title.triple_corridor"](),
};

function messageFor(key: string): string {
  return SPLIT_PATTERN_TITLES[key]();
}

/** Compact, non-interactive tile preview for one split group's card in the "pattern statistics"
 *  modal — reuses `TileFaceEditor` itself, same rationale as `SplitPatternListEditor`'s own
 *  `PatternPreviewTile` (no separate rendering path to keep in sync). */
function SplitGroupPreviewTile({ topology, cfg }: { topology: SplitGroupDto["topology"]; cfg: ReturnType<typeof activeFloorTessellationOf> }) {
  return (
    <div style={styles.previewTile}>
      <TileFaceEditor
        point={SPLIT_PREVIEW_ANCHOR} cfg={cfg} nodes={tileNodesForTopology(topology, cfg)} activeIndex={null}
        onFaceClick={NOOP_FACE} onFaceRightClick={NOOP_FACE} onRotate={NOOP_ROTATE} showRotateControls={false}
      />
    </div>
  );
}

function SplitPatternStatsModal({ groups, tileCount, nodes, cfg, onClose }: {
  groups: SplitGroupDto[];
  tileCount: number;
  nodes: { x: number; y: number }[];
  cfg: ReturnType<typeof activeFloorTessellationOf>;
  onClose: () => void;
}) {
  const sorted = [...groups].sort((a, b) => b.count - a.count);
  // Computed only while this modal is actually open/mounted, not on every AnalyticsFeature render.
  const fieldTileCount = React.useMemo(() => new Set(nodes.map((n) => `${n.x},${n.y}`)).size, [nodes]);
  return (
    <Modal title={m["analytics.split_pattern_stats_title"]()} onClose={onClose}>
      <div style={styles.patternStatsList}>
        {sorted.map((group, i) => {
          const titleKey = titleKeyForTopology(group.topology);
          const pctOfSplits = tileCount > 0 ? (group.count / tileCount) * 100 : 0;
          const pctOfTiles = fieldTileCount > 0 ? (group.count / fieldTileCount) * 100 : 0;
          return (
            <div key={i} style={styles.patternStatsRow}>
              <SplitGroupPreviewTile topology={group.topology} cfg={cfg} />
              <div style={styles.patternStatsInfo}>
                {titleKey && <div style={styles.patternStatsTitle}>{messageFor(titleKey)}</div>}
                <StatRow label={m["analytics.split_pattern_stats_count"]()} count={group.count} />
                <StatRow label={m["analytics.split_pattern_stats_pct_of_splits"]()} valueText={`${pctOfSplits.toFixed(1)}%`} />
                <StatRow label={m["analytics.split_pattern_stats_pct_of_tiles"]()} valueText={`${pctOfTiles.toFixed(1)}%`} />
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

const REGION_CLASS_LEGEND: { cls: keyof typeof canvas.region; label: () => string; desc: () => string }[] = [
  { cls: "path", label: () => m["analytics.region_class_path"](), desc: () => m["analytics.region_class_path_desc"]() },
  { cls: "alternative", label: () => m["analytics.region_class_alternative"](), desc: () => m["analytics.region_class_alternative_desc"]() },
  { cls: "unreachable", label: () => m["analytics.region_class_unreachable"](), desc: () => m["analytics.region_class_unreachable_desc"]() },
  { cls: "trap", label: () => m["analytics.region_class_trap"](), desc: () => m["analytics.region_class_trap_desc"]() },
];

function colorToCss(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function RegionClassLegendModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={m["analytics.region_class_legend_title"]()} onClose={onClose}>
      {REGION_CLASS_LEGEND.map(({ cls, label, desc }) => (
        <div key={cls} style={styles.legendRow}>
          <span style={{ ...styles.legendSwatch, background: colorToCss(canvas.region[cls]) }} />
          <div>
            <div style={styles.legendLabel}>{label()}</div>
            <div style={styles.legendDesc}>{desc()}</div>
          </div>
        </div>
      ))}
    </Modal>
  );
}

function StatRow({ label, count, pct, valueText }: { label: string; count?: number; pct?: number | null; valueText?: string }) {
  return (
    <div style={styles.statRow}>
      <span style={styles.statLabel}>{label}</span>
      <span style={styles.statCount}>{valueText ?? count}</span>
      {pct !== undefined && <span style={styles.statPct}>{pct == null ? "—" : `${pct.toFixed(1)}%`}</span>}
    </div>
  );
}

function formatMs(ms: number): string {
  return `${Math.round(ms)} ms`;
}

/** Nesting level of one `TimingNodeDto` in the report tree, used to pick the right label resolver
 *  and prefix — depth 0 is the two synthetic top rows (already-localized labels, no prefix), 1 is
 *  a stage id, 2 is a rule id, 3 is a check-type or strategy id. A rule's children are its own
 *  `per_check` entries plus (if dispatched) one `per_strategy` entry — `checkIds` (this run's
 *  `availableChecks` id set) is what tells the two apart at that leaf level. */
export type TimingRowKind = "root" | "stage" | "rule" | "check" | "strategy";

// Exported for direct unit testing — pure, no React/store involved.
export function leafKind(id: string, checkIds: Set<string>): TimingRowKind {
  return checkIds.has(id) ? "check" : "strategy";
}

// Exported for direct unit testing — pure, no React/store involved.
export function resolveTimingRowLabel(kind: TimingRowKind, id: string, stageNames: Map<string, string>, ruleNames: Map<string, string>): string {
  switch (kind) {
    case "root": return id;
    case "stage": return m["analytics.timing_report_prefix_stage"]({ name: stageNames.get(id) ?? id });
    case "rule": return m["analytics.timing_report_prefix_rule"]({ name: ruleNames.get(id) ?? id });
    case "check": return m["analytics.timing_report_prefix_check"]({ name: resolveCheckLabel(id, id) });
    case "strategy": return m["analytics.timing_report_prefix_strategy"]({ name: resolveStrategyLabel(id) });
  }
}

/** One row of the timing detailed-report table plus its own children, recursively — mirrors
 *  `NestedStrategyPanel`'s `entryStackWithWeight` pattern: the *children wrapper* (not each row
 *  individually) carries the `borderLeft`, so the line runs unbroken through every descendant
 *  row instead of one dashed segment per row. `pct` is always relative to the whole run's total
 *  time (`totalMs`), at every nesting level — see GitHub issue #285 — never to the immediate
 *  parent, so any row's contribution is directly comparable to any other row's regardless of
 *  depth. Highlights on hover only (`"hoverable"`, the shared class every other row/section in
 *  this feature uses) rather than a permanent striped background. */
function TimingReportRow({ node, kind, totalMs, stageNames, ruleNames, checkIds }: {
  node: TimingNodeDto; kind: TimingRowKind; totalMs: number;
  stageNames: Map<string, string>; ruleNames: Map<string, string>; checkIds: Set<string>;
}) {
  const pct = totalMs > 0 ? (node.total_ms / totalMs) * 100 : 0;
  const label = resolveTimingRowLabel(kind, node.id, stageNames, ruleNames);
  return (
    <div style={styles.timingReportNode}>
      <div className="hoverable" style={styles.timingReportRow}>
        <span style={styles.timingReportLabel}>{label}</span>
        <span style={styles.timingReportCalls}>{node.calls > 0 ? node.calls : ""}</span>
        <span style={styles.timingReportMs}>{formatMs(node.total_ms)}</span>
        <span style={styles.timingReportPct}>{pct.toFixed(1)}%</span>
      </div>
      {node.children.length > 0 && (
        <div style={styles.timingReportChildren}>
          {node.children.map((child, i) => (
            <TimingReportRow
              key={`${child.id}-${i}`} node={child}
              kind={kind === "root" ? "stage" : kind === "stage" ? "rule" : leafKind(child.id, checkIds)}
              totalMs={totalMs} stageNames={stageNames} ruleNames={ruleNames} checkIds={checkIds}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Exported for direct RTL testing of the recursive stage/rule/check-or-strategy kind flow.
export function TimingDetailedReportModal({ timing, onClose }: { timing: GenerationTimingDto; onClose: () => void }) {
  const stages = useMazeStore((s) => s.stages);
  const rules = useMazeStore((s) => s.rules);
  const availableChecks = useMazeStore((s) => s.availableChecks);
  const stageNames = React.useMemo(() => new Map(stages.map((s) => [s.id, s.name])), [stages]);
  const ruleNames = React.useMemo(() => new Map(rules.map((r) => [r.id, r.name])), [rules]);
  const checkIds = React.useMemo(() => new Set(availableChecks.map((c) => c.id)), [availableChecks]);
  const qcTotalMs = timing.qc.reduce((s, n) => s + n.total_ms, 0);
  const totalMs = timing.initial_build_ms + qcTotalMs;
  const generationNode: TimingNodeDto = { id: m["analytics.timing_initial_build"](), total_ms: timing.initial_build_ms, calls: 0, children: [] };
  const qcNode: TimingNodeDto = { id: m["analytics.timing_qc_total"](), total_ms: qcTotalMs, calls: 0, children: timing.qc };
  return (
    <Modal
      title={m["analytics.timing_detailed_report_title"]()}
      size="complex"
      onClose={onClose}
      rawBody={
        <div style={styles.timingReportRoot}>
          <div style={styles.timingReportHeader}>
            <span style={styles.timingReportLabel}>{m["analytics.timing_report_task"]()}</span>
            <span style={styles.timingReportCalls}>{m["analytics.timing_report_calls"]()}</span>
            <span style={styles.timingReportMs}>{m["analytics.timing_report_time"]()}</span>
            <span style={styles.timingReportPct}>{m["analytics.timing_report_pct"]()}</span>
          </div>
          <div style={styles.timingReportScroll}>
            <TimingReportRow node={generationNode} kind="root" totalMs={totalMs} stageNames={stageNames} ruleNames={ruleNames} checkIds={checkIds} />
            <TimingReportRow node={qcNode} kind="root" totalMs={totalMs} stageNames={stageNames} ruleNames={ruleNames} checkIds={checkIds} />
          </div>
        </div>
      }
    />
  );
}

function SidesInfoModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={m["analytics.sides_section"]()} onClose={onClose}>
      <div style={styles.legendDesc}>{m["analytics.sides_info_desc"]()}</div>
    </Modal>
  );
}

function GraphSection({ g }: { g: import("../../wasm/types").GraphStatsDto }) {
  return (
    <div style={styles.statBlock}>
      <StatRow label={m["analytics.graph_components"]()} count={g.component_count} />
      <StatRow label={m["analytics.graph_average_degree"]()} valueText={g.average_degree.toFixed(2)} />
      <StatRow label={m["analytics.graph_nodes"]()} count={g.node_count} />
      <StatRow label={m["analytics.graph_edges"]()} count={g.edge_count} />
      {!g.cycle_analysis_overflowed && (
        <>
          <StatRow label={m["analytics.graph_cycle_count"]()} count={g.cycle_count} />
          <StatRow label={m["analytics.graph_simple_cycle_count"]()} count={g.simple_cycle_count} />
          <StatRow label={m["analytics.graph_cycle_regions"]()} count={g.cycle_region_count} />
        </>
      )}
    </div>
  );
}

function CellsSection({ stats, cellCount }: { stats: NodeStatsDto; cellCount: number }) {
  const sorted = [...stats.junctions].sort((a, b) => a.degree - b.degree);
  const total = stats.dead_ends + stats.straight + stats.turns + sorted.reduce((s, j) => s + j.count, 0);
  const pct = (n: number) => total > 0 ? (n / total) * 100 : 0;
  return (
    <div style={styles.statBlock}>
      <StatRow label={m["analytics.total"]()} count={cellCount} pct={null} />
      <StatRow label={m["analytics.dead_ends"]()} count={stats.dead_ends} pct={pct(stats.dead_ends)} />
      <StatRow label={m["analytics.straight"]()} count={stats.straight} pct={pct(stats.straight)} />
      <StatRow label={m["analytics.turns"]()} count={stats.turns} pct={pct(stats.turns)} />
      {sorted.map((j) => (
        <StatRow key={j.degree} label={m["analytics.junction"]({ degree: j.degree })} count={j.count} pct={pct(j.count)} />
      ))}
    </div>
  );
}

function SidesSection({ stats, oneWayPassages }: { stats: SpatialEdgeStatsDto; oneWayPassages: number }) {
  const pct = (n: number) => stats.total_pairs > 0 ? (n / stats.total_pairs) * 100 : 0;
  return (
    <div style={styles.statBlock}>
      <StatRow label={m["analytics.total"]()} count={stats.total_pairs} pct={null} />
      <StatRow label={m["analytics.passages"]()} count={stats.bidirectional} pct={pct(stats.bidirectional)} />
      <StatRow label={m["analytics.one_way_edges"]()} count={oneWayPassages} pct={pct(oneWayPassages)} />
      <StatRow label={m["analytics.walls"]()} count={stats.walls} pct={pct(stats.walls)} />
    </div>
  );
}

function SubsectionTitle({ label, onOpenInfo }: { label: string; onOpenInfo?: () => void }) {
  return (
    <div style={styles.subsectionHeaderRow}>
      <div style={sharedStyles.sectionHeader}>{label}</div>
      {onOpenInfo && (
        <span role="button" tabIndex={0} className="hoverable" style={styles.infoIcon} onClick={onOpenInfo}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpenInfo(); }}>ℹ</span>
      )}
    </div>
  );
}

function ElementsSection({ stats, onOpenSplitStats }: { stats: ElementsStatsDto; onOpenSplitStats?: () => void }) {
  const namedSplitGroups = stats.split_groups.filter((g) => titleKeyForTopology(g.topology) != null);
  return (
    <div style={styles.statBlock}>
      <StatRow label={m["analytics.one_way_edges"]()} count={stats.one_way_passages} />
      <StatRow label={m["analytics.two_way_teleports"]()} count={stats.two_way_teleports} />
      <StatRow label={m["analytics.one_way_teleports"]()} count={stats.one_way_teleports} />
      <StatRow label={m["analytics.split_tile_count"]()} count={stats.split_tile_count} />
      <StatRow label={m["analytics.split_node_count"]()} count={stats.split_node_count} />
      {namedSplitGroups.map((group, i) => (
        <StatRow key={i} label={messageFor(titleKeyForTopology(group.topology)!)} count={group.count} />
      ))}
      {onOpenSplitStats && stats.split_groups.length > 0 && (
        <button className="hoverable" style={{ ...sharedStyles.btnMuted, ...styles.patternStatsButton }} onClick={onOpenSplitStats}>
          {m["analytics.split_pattern_stats_button"]()}
        </button>
      )}
    </div>
  );
}

function VerticalSection({ stats }: { stats: import("../../wasm/types").VerticalStatsDto }) {
  return (
    <div style={styles.statBlock}>
      <StatRow label={m["analytics.vertical_bidirectional_passages"]()} count={stats.bidirectional_passages} />
      <StatRow label={m["analytics.vertical_one_way_up"]()} count={stats.one_way_passages_up} />
      <StatRow label={m["analytics.vertical_one_way_down"]()} count={stats.one_way_passages_down} />
      <StatRow label={m["analytics.vertical_elevator_groups"]()} count={stats.elevator_groups} />
      <StatRow label={m["analytics.vertical_cross_floor_teleports"]()} count={stats.cross_floor_teleports} />
    </div>
  );
}

function StatGroup({ nested, children }: { nested?: boolean; children: React.ReactNode }) {
  return <div style={nested ? styles.nestedGroup : styles.statGroup}>{children}</div>;
}

export function DetailedReportPanel({ statistics, floors, cfg, nodes, onClose }: {
  statistics: import("../../wasm/types").MazeStatisticsDto;
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
        const totalMs = timing.initial_build_ms + qcTotalMs;
        return (
          <>
            <div style={styles.divider} />
            <SectionHeader label={m["analytics.timing"]()} expanded={isExpanded("timing")} onToggle={() => toggleSection("timing")} />
            {isExpanded("timing") && (
              <div style={styles.statBlock}>
                <StatRow label={m["analytics.timing_total"]()} valueText={formatMs(totalMs)} />
                <StatRow label={m["analytics.timing_initial_build"]()} valueText={formatMs(timing.initial_build_ms)} />
                <StatRow label={m["analytics.timing_qc_total"]()} valueText={formatMs(qcTotalMs)} />
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

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  statBlock: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  statRow: { display: "flex", alignItems: "center", gap: spacing.itemGap },
  statLabel: { flex: 1, ...muted(typography.body) },
  statCount: { ...typography.caption, minWidth: 32, textAlign: "right" },
  statPct: { ...disabled(typography.body), minWidth: 44, textAlign: "right" },
  scoreRow: { display: "flex", alignItems: "center", gap: spacing.itemGap },
  // `rawBody` layout (see `TimingDetailedReportModal`) — the header row sits outside the
  // scrolling area so only the tree itself scrolls when the report is tall, and the two root
  // nodes ("Initial generation"/"Quality control") stack with no gap between them, matching every
  // other row-to-row gap in the tree.
  timingReportRoot: { display: "flex", flexDirection: "column" as const, flex: 1, minHeight: 0 },
  timingReportScroll: { flex: 1, overflowY: "auto" as const, minHeight: 0, padding: `0 ${dialogSpacing.paddingX}px ${dialogSpacing.bodyPadding}px` },
  timingReportHeader: {
    display: "flex", alignItems: "center", gap: spacing.groupGap, flexShrink: 0,
    padding: `${dialogSpacing.bodyPadding}px ${dialogSpacing.paddingX}px ${spacing.itemGap}px`,
    borderBottom: `1px solid ${ui.border.default}`,
    ...disabled(typography.body),
  },
  // One node's own row plus its children wrapper, stacked with no gap — rows must sit flush
  // against each other with no gap of their own — the taller row height below (via padding, not
  // a gap) is what gives the table breathing room instead.
  timingReportNode: { display: "flex", flexDirection: "column" as const },
  timingReportRow: {
    display: "flex", alignItems: "center", gap: spacing.groupGap, minHeight: 20,
    padding: `${spacing.itemGap}px 0 ${spacing.itemGap}px ${spacing.groupGap}px`,
    borderRadius: 3,
  },
  // Mirrors `NestedStrategyPanel`'s `entryStackWithWeight` — one continuous vertical line down
  // the left of a node's *entire* children block (not one dashed segment per row), ties every
  // descendant row visually to the parent it's nested under.
  timingReportChildren: {
    display: "flex", flexDirection: "column" as const,
    borderLeft: `1px solid ${ui.border.default}`, marginLeft: spacing.groupGap, paddingLeft: indent.tree - spacing.groupGap,
  },
  timingReportLabel: { flex: 1, ...typography.body, minWidth: 0, overflowWrap: "break-word" as const },
  timingReportCalls: { ...typography.caption, minWidth: 48, textAlign: "center" as const },
  timingReportMs: { ...typography.caption, minWidth: 64, textAlign: "right" as const },
  timingReportPct: { ...typography.caption, minWidth: 56, textAlign: "right" as const },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
  panelBody: { display: "flex", flexDirection: "column", gap: spacing.itemGap, padding: dialogSpacing.bodyPadding },
  // One indentation level for a nested section's own content, relative to its `SectionHeader` —
  // `report_general`/`report_by_floors` -> subsection -> stat rows is 2 levels deep at most.
  statGroup: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  nestedGroup: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  floorSectionBody: { paddingBottom: 8 },
  subsectionHeaderRow: { display: "flex", alignItems: "center", gap: spacing.itemGap },
  infoIcon: { ...muted(typography.icon), lineHeight: 1, flexShrink: 0, cursor: "default", borderRadius: 3 },
  toggleBlock: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  legendRow: { display: "flex", alignItems: "center", gap: spacing.groupGap },
  legendSwatch: { width: 14, height: 14, borderRadius: 3, flexShrink: 0 },
  legendLabel: { ...typography.body, fontWeight: "bold" as const },
  legendDesc: { ...muted(typography.body) },
  patternStatsButton: { width: "100%", boxSizing: "border-box" as const, marginTop: spacing.itemGap },
  patternStatsList: { display: "flex", flexDirection: "column", gap: spacing.groupGap },
  patternStatsRow: {
    display: "flex", alignItems: "center", gap: spacing.groupGap,
    padding: spacing.itemGap, border: `1px solid ${ui.border.default}`, borderRadius: 6,
  },
  previewTile: { width: 56, height: 56, flexShrink: 0 },
  patternStatsInfo: { flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  patternStatsTitle: { ...typography.body, fontWeight: "bold" as const },
};
