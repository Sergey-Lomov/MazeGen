import React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { activeFloorTessellationOf } from "../../store/storeHelpers";
import { Modal } from "../Modal";
import { canvas } from "../../pixi/colorTokens";
import { TileFaceEditor } from "./TileFaceEditor";
import { tileNodesForTopology } from "../../pixi/splitPatternTile";
import { titleKeyForTopology } from "../../pixi/splitPatternTitles";
import { resolveCheckLabel, resolveParamLabel, resolveStrategyLabel, resolveIssueLabel } from "./qualityI18n";
import { buildValues } from "./useParamEditor";
import { StatRow, SubsectionTitle, formatMs } from "./AnalyticsSections";
import { styles, messageFor } from "./analyticsStyles";
import type { SplitGroupDto, TimingNodeDto, GenerationTimingDto } from "../../wasm/types";
import { useLocale } from "../../i18n/useLocale";
import * as m from "~/paraglide/messages";

const SPLIT_PREVIEW_ANCHOR: [number, number] = [0, 0];
const NOOP_FACE = () => {};
const NOOP_ROTATE = () => {};

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

export function SplitPatternStatsModal({ groups, tileCount, nodes, cfg, onClose }: {
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

export function RegionClassLegendModal({ onClose }: { onClose: () => void }) {
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

export function SidesInfoModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={m["analytics.sides_section"]()} onClose={onClose}>
      <div style={styles.legendDesc}>{m["analytics.sides_info_desc"]()}</div>
    </Modal>
  );
}

const SCORED_ENDPOINTS_STRATEGY_ID = "scored_endpoints";

/** Explains what the Path section's "Score" stat represents (GitHub issue #532/#534), and lists
 *  the project's currently configured `scored_endpoints` weights below a divider, the exact
 *  values `MazeAnalysis::route_score` computed the shown score from, resolved the same way
 *  `RuleStrategyPanel`'s live editor does (`buildValues`: stored override, falling back to the
 *  param's own default). The strategy is guaranteed configured whenever this modal can even open
 *  (the score is only ever non-null when it is, see `score_weights_from_rule_groups`/
 *  `score_weights_from_stages`), so no empty-state branch is needed here. */
export function ScoreInfoModal({ onClose }: { onClose: () => void }) {
  const availableStrategies = useMazeStore((s) => s.availableStrategies);
  const strategyParams = useMazeStore((s) => s.strategyParams);
  const descriptor = availableStrategies.find((s) => s.id === SCORED_ENDPOINTS_STRATEGY_ID);
  const values = descriptor ? buildValues(descriptor.params, strategyParams[SCORED_ENDPOINTS_STRATEGY_ID] ?? {}) : {};
  return (
    <Modal title={m["analytics.score"]()} onClose={onClose}>
      <div style={styles.legendDesc}>{m["analytics.score_info_desc"]()}</div>
      <div style={styles.legendDesc}>{m["analytics.score_info_visibility"]()}</div>
      <div style={styles.divider} />
      <div style={styles.scoreInfoWeights}>
        <SubsectionTitle label={m["analytics.score_info_current_weights"]()} />
        <div style={styles.scoreInfoValues}>
          {descriptor?.params.map((p) => (
            <StatRow key={p.id} label={resolveParamLabel(p.id, p.label, descriptor.id)} valueText={values[p.id]} />
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** Nesting level of one `TimingNodeDto` in the report tree, used to pick the right label resolver
 *  and prefix — depth 0 is the three synthetic top rows (already-localized labels, no prefix), 1 is
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
  const { locale } = useLocale();
  const stageNames = React.useMemo(() => new Map(stages.map((s) => [s.id, s.name])), [stages]);
  // `r.name` is `null` for a rule with no custom name — falls back to the issue kind's own
  // live-locale label, same as `useQualityViewModel`'s VM resolves it (GitHub issue #556).
  const ruleNames = React.useMemo(() => new Map(rules.map((r) => [r.id, r.name ?? resolveIssueLabel(r.kind)])), [rules, locale]);
  const checkIds = React.useMemo(() => new Set(availableChecks.map((c) => c.id)), [availableChecks]);
  const qcTotalMs = timing.qc.reduce((s, n) => s + n.total_ms, 0);
  const totalMs = timing.initial_build_ms + qcTotalMs + timing.snapshot_ms;
  const generationNode: TimingNodeDto = { id: m["analytics.timing_initial_build"](), total_ms: timing.initial_build_ms, calls: 0, children: [] };
  const qcNode: TimingNodeDto = { id: m["analytics.timing_qc_total"](), total_ms: qcTotalMs, calls: 0, children: timing.qc };
  const snapshotNode: TimingNodeDto = { id: m["analytics.timing_snapshot"](), total_ms: timing.snapshot_ms, calls: 0, children: [] };
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
            <TimingReportRow node={snapshotNode} kind="root" totalMs={totalMs} stageNames={stageNames} ruleNames={ruleNames} checkIds={checkIds} />
          </div>
        </div>
      }
    />
  );
}
