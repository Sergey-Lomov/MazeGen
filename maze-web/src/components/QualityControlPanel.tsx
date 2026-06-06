import { useMazeStore } from "../store/mazeStore";

export function QualityControlPanel() {
  const availableChecks = useMazeStore((s) => s.availableChecks);
  const availableStrategies = useMazeStore((s) => s.availableStrategies);
  const selectedChecks = useMazeStore((s) => s.selectedChecks);
  const selectedStrategies = useMazeStore((s) => s.selectedStrategies);
  const toggleCheck = useMazeStore((s) => s.toggleCheck);
  const setStrategy = useMazeStore((s) => s.setStrategy);

  const activeIssueKinds = Array.from(
    new Set(
      availableChecks
        .filter((c) => selectedChecks.includes(c.id))
        .flatMap((c) => c.issue_kinds)
    )
  );

  return (
    <div style={styles.panel}>
      <div style={styles.column}>
        <div style={styles.colHeader}>Checks</div>
        {availableChecks.map((check) => (
          <label key={check.id} style={styles.row}>
            <input
              type="checkbox"
              checked={selectedChecks.includes(check.id)}
              onChange={() => toggleCheck(check.id)}
            />
            <span style={styles.label}>{check.id}</span>
          </label>
        ))}
      </div>

      <div style={styles.divider} />

      <div style={styles.column}>
        <div style={styles.colHeader}>Issues</div>
        {activeIssueKinds.length === 0
          ? <div style={styles.empty}>—</div>
          : activeIssueKinds.map((kind) => (
            <div key={kind} style={styles.issueRow}>
              <span style={styles.label}>{kind}</span>
            </div>
          ))
        }
      </div>

      <div style={styles.divider} />

      <div style={styles.column}>
        <div style={styles.colHeader}>Strategies</div>
        {activeIssueKinds.length === 0
          ? <div style={styles.empty}>—</div>
          : activeIssueKinds.map((kind) => {
            const options = availableStrategies.filter((s) => s.handles === kind);
            const current = selectedStrategies[kind] ?? "";
            return (
              <div key={kind} style={styles.strategyRow}>
                <select
                  style={styles.select}
                  value={current}
                  onChange={(e) => setStrategy(kind, e.target.value)}
                >
                  <option value="">none</option>
                  {options.map((s) => (
                    <option key={s.id} value={s.id}>{s.id}</option>
                  ))}
                </select>
              </div>
            );
          })
        }
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "row",
    background: "#222",
    borderRight: "1px solid #333",
    width: 480,
    minWidth: 480,
    overflowY: "auto",
  },
  column: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    padding: "8px 10px",
    gap: 6,
  },
  colHeader: {
    fontSize: 11,
    fontWeight: "bold",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 4,
    borderBottom: "1px solid #333",
    paddingBottom: 4,
  },
  divider: {
    width: 1,
    background: "#333",
    margin: "8px 0",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    cursor: "pointer",
  },
  issueRow: {
    display: "flex",
    alignItems: "center",
    height: 22,
  },
  strategyRow: {
    display: "flex",
    alignItems: "center",
    height: 22,
  },
  label: {
    fontSize: 11,
    color: "#ccc",
  },
  empty: {
    fontSize: 11,
    color: "#555",
  },
  select: {
    background: "#2a2a2a",
    border: "1px solid #444",
    color: "#e0e0e0",
    fontSize: 11,
    borderRadius: 3,
    padding: "1px 4px",
    width: "100%",
  },
};
