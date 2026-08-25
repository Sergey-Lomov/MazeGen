import { sharedStyles } from "../../styles/shared";
import type { NodeStatsDto, SpatialEdgeStatsDto, ElementsStatsDto, GraphStatsDto, VerticalStatsDto } from "../../wasm/types";
import { titleKeyForTopology } from "../../pixi/splitPatternTitles";
import { styles, messageFor } from "./analyticsStyles";
import * as m from "~/paraglide/messages";
import React from "react";

export function StatRow({ label, count, pct, valueText }: { label: string; count?: number; pct?: number | null; valueText?: string }) {
  return (
    <div style={styles.statRow}>
      <span style={styles.statLabel}>{label}</span>
      <span style={styles.statCount}>{valueText ?? count}</span>
      {pct !== undefined && <span style={styles.statPct}>{pct == null ? "—" : `${pct.toFixed(1)}%`}</span>}
    </div>
  );
}

export function formatMs(ms: number): string {
  return `${Math.round(ms)} ms`;
}

export function GraphSection({ g }: { g: GraphStatsDto }) {
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

export function CellsSection({ stats, cellCount }: { stats: NodeStatsDto; cellCount: number }) {
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

export function SidesSection({ stats, oneWayPassages }: { stats: SpatialEdgeStatsDto; oneWayPassages: number }) {
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

export function SubsectionTitle({ label, onOpenInfo }: { label: string; onOpenInfo?: () => void }) {
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

export function ElementsSection({ stats, onOpenSplitStats }: { stats: ElementsStatsDto; onOpenSplitStats?: () => void }) {
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

export function VerticalSection({ stats }: { stats: VerticalStatsDto }) {
  return (
    <div style={styles.statBlock}>
      <StatRow label={m["analytics.vertical_bidirectional_passages"]()} count={stats.bidirectional_passages} />
      <StatRow label={m["analytics.vertical_one_way_up"]()} count={stats.one_way_passages_up} />
      <StatRow label={m["analytics.vertical_one_way_down"]()} count={stats.one_way_passages_down} />
      <StatRow label={m["analytics.vertical_elevator_groups"]()} count={stats.elevator_groups} />
      <StatRow label={m["analytics.vertical_elevator_stop_count"]()} count={stats.elevator_stop_count} />
      <StatRow label={m["analytics.vertical_average_elevator_stops"]()} valueText={stats.average_elevator_stops.toFixed(2)} />
      <StatRow label={m["analytics.vertical_cross_floor_teleports"]()} count={stats.cross_floor_teleports} />
    </div>
  );
}

export function StatGroup({ nested, children }: { nested?: boolean; children: React.ReactNode }) {
  return <div style={nested ? styles.nestedGroup : styles.statGroup}>{children}</div>;
}
