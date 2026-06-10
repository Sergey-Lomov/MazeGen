import { useMemo } from "react";
import { useMazeStore } from "../store/mazeStore";
import { sharedStyles } from "../styles/shared";
import { colors, radius } from "../styles/theme";

export function DebugPanel() {
  const showNodeIds = useMazeStore((s) => s.showNodeIds);
  const showCoords = useMazeStore((s) => s.showCoords);
  const setDebugFlag = useMazeStore((s) => s.setDebugFlag);
  const nodes = useMazeStore((s) => s.nodes);
  const selectedNode = useMazeStore((s) => s.selectedNode);
  const selected = useMemo(
    () => (selectedNode !== null ? (nodes.find((n) => n.id === selectedNode) ?? null) : null),
    [nodes, selectedNode],
  );

  return (
    <div style={styles.panel}>
      <h3 style={styles.title}>Debug</h3>
      <label style={styles.checkLabel}>
        <input
          type="checkbox"
          checked={showNodeIds}
          onChange={(e) => setDebugFlag("showNodeIds", e.target.checked)}
        />
        Node IDs
      </label>
      <label style={styles.checkLabel}>
        <input
          type="checkbox"
          checked={showCoords}
          onChange={(e) => setDebugFlag("showCoords", e.target.checked)}
        />
        Coordinates
      </label>
      {selected && (
        <div style={styles.info}>
          <div>ID: {selected.id}</div>
          <div>x: {selected.x}, y: {selected.y}</div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: 12,
  },
  title: sharedStyles.panelTitle,
  checkLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: colors.textMuted,
    cursor: "pointer",
  },
  info: {
    marginTop: 8,
    padding: 8,
    background: colors.bgInput,
    borderRadius: radius.md,
    fontSize: 11,
    color: colors.textAccent,
    lineHeight: 1.6,
  },
};
