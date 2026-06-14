import React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { colors, font } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import * as m from "~/paraglide/messages";

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={switchStyles.wrap}>
      <input
        type="checkbox"
        style={switchStyles.input}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span style={{ ...switchStyles.track, ...(checked ? switchStyles.trackOn : {}) }}>
        <span style={{ ...switchStyles.thumb, ...(checked ? switchStyles.thumbOn : {}) }} />
      </span>
    </label>
  );
}

function SectionHeader({ label }: { label: string }) {
  return <div style={sharedStyles.sectionHeader}>{label}</div>;
}

function StatRow({ label, count, pct }: { label: string; count: number; pct?: number }) {
  return (
    <div style={styles.statRow}>
      <span style={styles.statLabel}>{label}</span>
      <span style={styles.statCount}>{count}</span>
      {pct !== undefined && <span style={styles.statPct}>{pct.toFixed(1)}%</span>}
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={styles.toggleRow}>
      <span style={styles.toggleLabel}>{label}</span>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

export function AnalyticsFeature() {
  const nodeStats = useMazeStore((s) => s.nodeStats);
  const edgeStats = useMazeStore((s) => s.edgeStats);
  const routeInfo = useMazeStore((s) => s.routeInfo);
  const warnings = useMazeStore((s) => s.warnings);

  const showMazeOverlay = useMazeStore((s) => s.showMazeOverlay);
  const showComponentsOverlay = useMazeStore((s) => s.showComponentsOverlay);
  const showGraphOverlay = useMazeStore((s) => s.showGraphOverlay);
  const showNavGraphOverlay = useMazeStore((s) => s.showNavGraphOverlay);
  const showRouteOverlay = useMazeStore((s) => s.showRouteOverlay);

  const setShowMazeOverlay = useMazeStore((s) => s.setShowMazeOverlay);
  const setShowComponentsOverlay = useMazeStore((s) => s.setShowComponentsOverlay);
  const setShowGraphOverlay = useMazeStore((s) => s.setShowGraphOverlay);
  const setShowNavGraphOverlay = useMazeStore((s) => s.setShowNavGraphOverlay);
  const setShowRouteOverlay = useMazeStore((s) => s.setShowRouteOverlay);

  return (
    <div style={styles.root}>

      {/* Issues block — hidden when no warnings */}
      {warnings.length > 0 && (
        <>
          <SectionHeader label={m["analytics.issues"]()} />
          <div style={styles.issueBlock}>
            {warnings.map((w, i) => (
              <div key={i} style={styles.issueRow}>{w}</div>
            ))}
          </div>
          <div style={styles.divider} />
        </>
      )}

      {/* Layers block */}
      <SectionHeader label={m["analytics.layers"]()} />
      <div style={styles.toggleBlock}>
        <ToggleRow label={m["analytics.layer_maze"]()} checked={showMazeOverlay} onChange={setShowMazeOverlay} />
        <ToggleRow label={m["analytics.layer_components"]()} checked={showComponentsOverlay} onChange={setShowComponentsOverlay} />
        <ToggleRow label={m["analytics.layer_graph"]()} checked={showGraphOverlay} onChange={setShowGraphOverlay} />
        <ToggleRow label={m["analytics.layer_nav_graph"]()} checked={showNavGraphOverlay} onChange={setShowNavGraphOverlay} />
        <ToggleRow label={m["analytics.layer_route"]()} checked={showRouteOverlay} onChange={setShowRouteOverlay} />
      </div>

      <div style={styles.divider} />

      {/* Path block — hidden when no route */}
      {routeInfo != null && (
        <>
          <SectionHeader label={m["analytics.path"]()} />
          <div style={styles.statBlock}>
            <StatRow label={m["analytics.path_length"]()} count={routeInfo.path_length} />
            <StatRow label={m["analytics.junction_count"]()} count={routeInfo.junction_count} />
            <StatRow label={m["analytics.one_way_count"]()} count={routeInfo.one_way_count} />
            {routeInfo.score != null && (
              <div style={styles.scoreRow}>
                <span style={styles.statLabel}>{m["analytics.score"]()}</span>
                <span style={styles.statCount}>{routeInfo.score.toFixed(2)}</span>
              </div>
            )}
          </div>
          <div style={styles.divider} />
        </>
      )}

      {/* Nodes block */}
      <SectionHeader label={m["analytics.node_elements"]()} />
      {nodeStats ? (() => {
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
          </div>
        );
      })() : null}

      <div style={styles.divider} />

      {/* Edges block */}
      <SectionHeader label={m["analytics.edge_elements"]()} />
      {edgeStats ? (() => {
        const total = edgeStats.bidirectional + edgeStats.one_way + edgeStats.walls;
        const pct = (n: number) => total > 0 ? (n / total) * 100 : 0;
        return (
          <div style={styles.statBlock}>
            <StatRow label={m["analytics.passages"]()} count={edgeStats.bidirectional} pct={pct(edgeStats.bidirectional)} />
            <StatRow label={m["analytics.one_way_edges"]()} count={edgeStats.one_way} pct={pct(edgeStats.one_way)} />
            <StatRow label={m["analytics.walls"]()} count={edgeStats.walls} pct={pct(edgeStats.walls)} />
          </div>
        );
      })() : null}

    </div>
  );
}

const switchStyles: Record<string, React.CSSProperties> = {
  wrap: { position: "relative", display: "inline-flex", alignItems: "center", cursor: "pointer", flexShrink: 0 },
  input: { position: "absolute", opacity: 0, width: 0, height: 0 },
  track: { display: "inline-block", width: 32, height: 18, background: colors.borderStrong, borderRadius: 9, position: "relative", transition: "background 0.2s" },
  trackOn: { background: colors.bgBtnPrimary },
  thumb: { position: "absolute", top: 2, left: 2, width: 14, height: 14, background: colors.textWhite, borderRadius: "50%", transition: "left 0.2s" },
  thumbOn: { left: 16 },
};

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: 6 },
  issueBlock: { display: "flex", flexDirection: "column", gap: 4 },
  issueRow: { fontSize: font.sm, color: colors.textWarning, lineHeight: 1.4 },
  statBlock: { display: "flex", flexDirection: "column", gap: 3 },
  statRow: { display: "flex", alignItems: "center", gap: 6 },
  statLabel: { flex: 1, fontSize: font.sm, color: colors.textMuted },
  statCount: { fontSize: font.sm, color: colors.textDim, minWidth: 32, textAlign: "right" },
  statPct: { fontSize: font.sm, color: colors.textVeryDim, minWidth: 44, textAlign: "right" },
  scoreRow: { display: "flex", alignItems: "center", gap: 6 },
  divider: { borderTop: `1px solid ${colors.borderMid}`, margin: "4px 0" },
  toggleBlock: { display: "flex", flexDirection: "column", gap: 6 },
  toggleRow: { display: "flex", alignItems: "center", gap: 8 },
  toggleLabel: { flex: 1, fontSize: font.sm, color: colors.textMuted },
};
