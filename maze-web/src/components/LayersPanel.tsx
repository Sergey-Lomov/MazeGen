import { useMazeStore } from "../store/mazeStore";

export function LayersPanel() {
  const showMaze = useMazeStore((s) => s.showMaze);
  const showComponents = useMazeStore((s) => s.showComponents);
  const showGraphOverlay = useMazeStore((s) => s.showGraphOverlay);
  const showNavOverlay = useMazeStore((s) => s.showNavOverlay);
  const setDebugFlag = useMazeStore((s) => s.setDebugFlag);

  return (
    <div style={styles.panel}>
      <h3 style={styles.title}>Layers</h3>
      <label style={styles.checkLabel}>
        <input
          type="checkbox"
          checked={showMaze}
          onChange={(e) => setDebugFlag("showMaze", e.target.checked)}
        />
        Maze
      </label>
      <label style={styles.checkLabel}>
        <input
          type="checkbox"
          checked={showComponents}
          onChange={(e) => setDebugFlag("showComponents", e.target.checked)}
        />
        Components
      </label>
      <label style={styles.checkLabel}>
        <input
          type="checkbox"
          checked={showGraphOverlay}
          onChange={(e) => setDebugFlag("showGraphOverlay", e.target.checked)}
        />
        Graph
      </label>
      <label style={styles.checkLabel}>
        <input
          type="checkbox"
          checked={showNavOverlay}
          onChange={(e) => setDebugFlag("showNavOverlay", e.target.checked)}
        />
        Nav graph
      </label>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: 12,
    borderBottom: "1px solid #333",
  },
  title: { fontSize: 13, fontWeight: "bold", color: "#aaa", marginBottom: 4 },
  checkLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "#ccc",
    cursor: "pointer",
  },
};
