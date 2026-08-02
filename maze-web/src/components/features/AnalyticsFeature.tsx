import React from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { activeTessellationOf } from "../../store/storeHelpers";
import { ui, typography, muted, disabled, spacing, indent, dialogSpacing } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import { selectAnalyticsIssues } from "../../pixi/selectors/mazeSelectors";
import { IssuesBlock } from "../IssuesBlock";
import { ToggleRow } from "../ToggleRow";
import { Modal } from "../Modal";
import { canvas } from "../../pixi/colorTokens";
import { TileFaceEditor } from "./TileFaceEditor";
import { tileNodesForTopology } from "../../pixi/splitPatternTile";
import { titleKeyForTopology } from "../../pixi/splitPatternTitles";
import { resolveCheckLabel, resolveStrategyLabel } from "./qualityI18n";
import type { SplitGroupDto, TimingNodeDto, GenerationTimingDto } from "../../wasm/types";
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
function SplitGroupPreviewTile({ topology, cfg }: { topology: SplitGroupDto["topology"]; cfg: ReturnType<typeof activeTessellationOf> }) {
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
  cfg: ReturnType<typeof activeTessellationOf>;
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

function SectionHeader({ label, expanded, onToggle }: { label: string; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="hoverable" style={styles.sectionHeaderRow} onClick={onToggle}>
      {expanded ? <ChevronDown size={14} color={ui.text.tertiary} /> : <ChevronRight size={14} color={ui.text.tertiary} />}
      <div style={sharedStyles.sectionHeader}>{label}</div>
    </div>
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

export function AnalyticsFeature() {
  const generatedNodeStats = useMazeStore((s) => s.nodeStats);
  const generatedEdgeStats = useMazeStore((s) => s.edgeStats);
  const generatedTeleportEdgeStats = useMazeStore((s) => s.teleportEdgeStats);
  const generatedRouteInfo = useMazeStore((s) => s.routeInfo);
  const generatedGraphAnalytics = useMazeStore((s) => s.graphAnalytics);
  const generatedSplitAnalytics = useMazeStore((s) => s.splitAnalytics);
  const timing = useMazeStore((s) => s.timing);
  const postEditAnalytics = useMazeStore((s) => s.postEditAnalytics);
  const issues = useMazeStore(useShallow(selectAnalyticsIssues));
  const nodes = useMazeStore((s) => s.nodes);
  const tessellationConfig = useMazeStore((s) => activeTessellationOf(s));

  const nodeStats = postEditAnalytics?.nodeStats ?? generatedNodeStats;
  const edgeStats = postEditAnalytics?.edgeStats ?? generatedEdgeStats;
  const teleportEdgeStats = postEditAnalytics?.teleportEdgeStats ?? generatedTeleportEdgeStats;
  const routeInfo = postEditAnalytics != null ? postEditAnalytics.routeInfo : generatedRouteInfo;
  const graphAnalytics = postEditAnalytics?.graphAnalytics ?? generatedGraphAnalytics;
  const splitAnalytics = postEditAnalytics?.splitAnalytics ?? generatedSplitAnalytics;
  // Backend leaves region_classes empty whenever start or finish is unset — the same condition
  // the issue calls "unavailable otherwise" (independent of whether a route actually exists).
  const regionClassesUnavailable = Object.keys(graphAnalytics?.region_classes ?? {}).length === 0;
  const [splitPatternStatsOpen, setSplitPatternStatsOpen] = React.useState(false);
  const [timingReportOpen, setTimingReportOpen] = React.useState(false);
  const namedSplitGroups = (splitAnalytics?.groups ?? []).filter((g) => titleKeyForTopology(g.topology) != null);

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
          <ToggleRow label={m["analytics.layer_pure_cycles"]()} checked={showPureCyclesOverlay} onChange={setShowPureCyclesOverlay} disabled={(graphAnalytics?.cycle_count ?? 0) === 0} />
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

      {/* Graph analytics block */}
      {graphAnalytics != null && (
        <>
          <div style={styles.divider} />
          <SectionHeader label={m["analytics.graph"]()} expanded={isExpanded("graph")} onToggle={() => toggleSection("graph")} />
          {isExpanded("graph") && (
            <div style={styles.statBlock}>
              <StatRow label={m["analytics.graph_nodes"]()} count={graphAnalytics.node_count} />
              <StatRow label={m["analytics.graph_edges"]()} count={graphAnalytics.edge_count} />
              <StatRow label={m["analytics.graph_components"]()} count={graphAnalytics.component_count} />
              {!graphAnalytics.cycle_analysis_overflowed && (
                <>
                  <StatRow label={m["analytics.graph_cycle_count"]()} count={graphAnalytics.cycle_count} />
                  <StatRow label={m["analytics.graph_simple_cycle_count"]()} count={graphAnalytics.simple_cycle_count} />
                  <StatRow label={m["analytics.graph_cycle_regions"]()} count={graphAnalytics.cycle_region_count} />
                </>
              )}
            </div>
          )}
        </>
      )}

      <div style={styles.divider} />

      {/* Path block — hidden when no route */}
      {routeInfo != null && (
        <>
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
          <div style={styles.divider} />
        </>
      )}

      {/* Nodes block */}
      <SectionHeader label={m["analytics.node_elements"]()} expanded={isExpanded("nodes")} onToggle={() => toggleSection("nodes")} />
      {isExpanded("nodes") && nodeStats ? (() => {
        const sorted = [...nodeStats.junctions].sort((a, b) => a.degree - b.degree);
        const total = nodeStats.dead_ends + nodeStats.straight + nodeStats.turns
          + sorted.reduce((s, j) => s + j.count, 0);
        const pct = (n: number) => total > 0 ? (n / total) * 100 : 0;
        return (
          <div style={styles.statBlock}>
            <StatRow label={m["analytics.dead_ends"]()} count={nodeStats.dead_ends} pct={pct(nodeStats.dead_ends)} />
            <StatRow label={m["analytics.straight"]()} count={nodeStats.straight} pct={pct(nodeStats.straight)} />
            <StatRow label={m["analytics.turns"]()} count={nodeStats.turns} pct={pct(nodeStats.turns)} />
            {sorted.map((j) => (
              <StatRow
                key={j.degree}
                label={m["analytics.junction"]({ degree: j.degree })}
                count={j.count}
                pct={pct(j.count)}
              />
            ))}
            <StatRow label={m["analytics.teleport_entries"]()} count={nodeStats.teleport_entries} pct={pct(nodeStats.teleport_entries)} />
          </div>
        );
      })() : null}

      <div style={styles.divider} />

      {/* Edges block */}
      <SectionHeader label={m["analytics.edge_elements"]()} expanded={isExpanded("edges")} onToggle={() => toggleSection("edges")} />
      {isExpanded("edges") && edgeStats ? (() => {
        const total = edgeStats.bidirectional + edgeStats.one_way_passages + edgeStats.walls;
        const pct = (n: number) => total > 0 ? (n / total) * 100 : 0;
        return (
          <div style={styles.statBlock}>
            <StatRow label={m["analytics.passages"]()} count={edgeStats.bidirectional} pct={pct(edgeStats.bidirectional)} />
            <StatRow label={m["analytics.one_way_edges"]()} count={edgeStats.one_way_passages} pct={pct(edgeStats.one_way_passages)} />
            <StatRow label={m["analytics.walls"]()} count={edgeStats.walls} pct={pct(edgeStats.walls)} />
            {teleportEdgeStats ? (
              <>
                <StatRow label={m["analytics.two_way_teleports"]()} count={teleportEdgeStats.two_way} pct={null} />
                <StatRow label={m["analytics.one_way_teleports"]()} count={teleportEdgeStats.one_way} pct={null} />
              </>
            ) : null}
          </div>
        );
      })() : null}

      {/* Splits block — GitHub issue #262 */}
      {splitAnalytics != null && (
        <>
          <div style={styles.divider} />
          <SectionHeader label={m["analytics.splits"]()} expanded={isExpanded("splits")} onToggle={() => toggleSection("splits")} />
          {isExpanded("splits") && (
            <div style={styles.statBlock}>
              <StatRow label={m["analytics.split_tile_count"]()} count={splitAnalytics.tile_count} />
              <StatRow label={m["analytics.split_node_count"]()} count={splitAnalytics.node_count} />
              {namedSplitGroups.map((group, i) => (
                <StatRow
                  key={i}
                  label={messageFor(titleKeyForTopology(group.topology)!)}
                  count={group.count}
                />
              ))}
              {splitAnalytics.groups.length > 0 && (
                <button className="hoverable" style={{ ...sharedStyles.btnMuted, ...styles.patternStatsButton }} onClick={() => setSplitPatternStatsOpen(true)}>
                  {m["analytics.split_pattern_stats_button"]()}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {splitPatternStatsOpen && splitAnalytics != null && (
        <SplitPatternStatsModal
          groups={splitAnalytics.groups}
          tileCount={splitAnalytics.tile_count}
          nodes={nodes}
          cfg={tessellationConfig}
          onClose={() => setSplitPatternStatsOpen(false)}
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
  sectionHeaderRow: {
    display: "flex", alignItems: "center", gap: spacing.itemGap, cursor: "default", borderRadius: 3,
    padding: `${spacing.itemGap}px 0`, margin: `-${spacing.itemGap}px 0`,
  },
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
