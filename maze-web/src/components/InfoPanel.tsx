import { useMazeStore } from "../store/mazeStore";
import { sharedStyles } from "../styles/shared";
import { colors } from "../styles/theme";

function pct(count: number, total: number): string {
  if (total === 0) return "0.0%";
  return (count / total * 100).toFixed(1) + "%";
}

function StatRow({ label, count, total }: { label: string; count: number; total: number }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>{label}</span>
      <span style={styles.rowCount}>{count}</span>
      <span style={styles.rowPct}>{pct(count, total)}</span>
    </div>
  );
}

export function InfoPanel() {
  const nodeStats = useMazeStore((s) => s.nodeStats);
  const edgeStats = useMazeStore((s) => s.edgeStats);
  const routeInfo = useMazeStore((s) => s.routeInfo);

  if (!nodeStats || !edgeStats) {
    return (
      <div style={styles.panel}>
        <div style={styles.empty}>Generate a maze to see info.</div>
      </div>
    );
  }

  const totalNodes = nodeStats.dead_ends + nodeStats.straight + nodeStats.turns
    + nodeStats.junctions.reduce((s, b) => s + b.count, 0);

  const totalEdgePairs = edgeStats.bidirectional + edgeStats.one_way + edgeStats.walls;

  return (
    <div style={styles.panel}>
      <div style={styles.section}>
        <div style={styles.sectionHeader}>Nodes</div>
        <StatRow label="Dead ends" count={nodeStats.dead_ends} total={totalNodes} />
        <StatRow label="Straight" count={nodeStats.straight} total={totalNodes} />
        <StatRow label="Turns" count={nodeStats.turns} total={totalNodes} />
        {nodeStats.junctions.map(({ degree, count }) => (
          <StatRow key={degree} label={`Junction-${degree}`} count={count} total={totalNodes} />
        ))}
      </div>

      <div style={styles.section}>
        <div style={styles.sectionHeader}>Edges</div>
        <StatRow label="Bidirectional" count={edgeStats.bidirectional} total={totalEdgePairs} />
        <StatRow label="One-way" count={edgeStats.one_way} total={totalEdgePairs} />
        <StatRow label="Walls" count={edgeStats.walls} total={totalEdgePairs} />
      </div>

      {routeInfo && (
        <div style={styles.section}>
          <div style={styles.sectionHeader}>Route</div>
          <div style={styles.row}>
            <span style={styles.rowLabel}>Length</span>
            <span style={styles.rowValue}>{routeInfo.path_length}</span>
          </div>
          <div style={styles.row}>
            <span style={styles.rowLabel}>Junctions</span>
            <span style={styles.rowValue}>{routeInfo.junction_count}</span>
          </div>
          <div style={styles.row}>
            <span style={styles.rowLabel}>One-way</span>
            <span style={styles.rowValue}>{routeInfo.one_way_count}</span>
          </div>
          {routeInfo.score != null && (
            <div style={styles.row}>
              <span style={styles.rowLabel}>Score</span>
              <span style={styles.rowValue}>{routeInfo.score.toFixed(1)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: 0,
    padding: 12,
    height: "100%",
    overflowY: "auto",
    boxSizing: "border-box",
  },
  empty: {
    fontSize: 11,
    color: colors.textVeryDim,
    padding: 8,
  },
  section: {
    marginBottom: 16,
  },
  sectionHeader: {
    ...sharedStyles.sectionHeader,
    marginBottom: 6,
    borderBottom: `1px solid ${colors.borderMid}`,
    paddingBottom: 3,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    color: colors.textMuted,
    padding: "2px 0",
  },
  rowLabel: {
    flex: 1,
    color: colors.textFaint,
  },
  rowCount: {
    width: 40,
    textAlign: "right",
    color: colors.textPrimary,
  },
  rowPct: {
    width: 46,
    textAlign: "right",
    color: colors.textVeryDim,
  },
  rowValue: {
    color: colors.textPrimary,
  },
};
