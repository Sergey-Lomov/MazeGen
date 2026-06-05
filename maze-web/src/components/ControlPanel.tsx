import { useMazeStore } from "../store/mazeStore";

interface Props {
  disabled?: boolean;
}

export function ControlPanel({ disabled = false }: Props) {
  const seed = useMazeStore((s) => s.seed);
  const width = useMazeStore((s) => s.width);
  const height = useMazeStore((s) => s.height);
  const setSeed = useMazeStore((s) => s.setSeed);
  const setWidth = useMazeStore((s) => s.setWidth);
  const setHeight = useMazeStore((s) => s.setHeight);
  const generate = useMazeStore((s) => s.generate);
  const reset = useMazeStore((s) => s.reset);
  const error = useMazeStore((s) => s.error);
  const warnings = useMazeStore((s) => s.warnings);

  return (
    <div style={styles.panel}>
      <h3 style={styles.title}>Maze</h3>
      <label style={styles.label}>
        Seed
        <input
          style={styles.input}
          type="number"
          value={seed}
          onChange={(e) => setSeed(Number(e.target.value))}
        />
      </label>
      <label style={styles.label}>
        Width
        <input
          style={styles.input}
          type="number"
          min={1}
          max={200}
          value={width}
          onChange={(e) => setWidth(Number(e.target.value))}
        />
      </label>
      <label style={styles.label}>
        Height
        <input
          style={styles.input}
          type="number"
          min={1}
          max={200}
          value={height}
          onChange={(e) => setHeight(Number(e.target.value))}
        />
      </label>
      <button style={{ ...styles.btn, ...(disabled ? styles.btnDisabled : {}) }} onClick={generate} disabled={disabled}>Generate</button>
      <button style={{ ...styles.btn, ...styles.btnSecondary, ...(disabled ? styles.btnDisabled : {}) }} onClick={reset} disabled={disabled}>Reset</button>
      {warnings.length > 0 && (
        <div style={styles.warning}>
          Issues: {warnings.join(", ")}
        </div>
      )}
      {error && <div style={styles.error}>{error}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 12,
    borderBottom: "1px solid #333",
  },
  title: { fontSize: 13, fontWeight: "bold", color: "#aaa", marginBottom: 4 },
  label: { display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "#aaa" },
  input: {
    background: "#2a2a2a",
    border: "1px solid #444",
    color: "#e0e0e0",
    padding: "3px 6px",
    fontSize: 12,
    borderRadius: 3,
  },
  btn: {
    background: "#3a6ea8",
    border: "none",
    color: "#fff",
    padding: "5px 0",
    cursor: "pointer",
    borderRadius: 3,
    fontSize: 12,
  },
  btnSecondary: { background: "#555" },
  btnDisabled: { opacity: 0.4, cursor: "not-allowed" },
  warning: { fontSize: 11, color: "#ffaa44", background: "#2a2010", padding: "4px 6px", borderRadius: 3 },
  error: { fontSize: 11, color: "#ff6b6b", background: "#2a1a1a", padding: "4px 6px", borderRadius: 3 },
};
