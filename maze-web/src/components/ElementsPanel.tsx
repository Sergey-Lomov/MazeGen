import { useEffect } from "react";
import { useMazeStore } from "../store/mazeStore";

export function ElementsPanel() {
  const availableElements = useMazeStore((s) => s.availableElements);
  const vertexWeights = useMazeStore((s) => s.vertexWeights);
  const edgeWeights = useMazeStore((s) => s.edgeWeights);
  const tessellationConfig = useMazeStore((s) => s.tessellationConfig);
  const cycleProb = useMazeStore((s) => s.cycleProb);
  const setVertexWeight = useMazeStore((s) => s.setVertexWeight);
  const setEdgeWeight = useMazeStore((s) => s.setEdgeWeight);
  const setCycleProb = useMazeStore((s) => s.setCycleProb);
  const loadElements = useMazeStore((s) => s.loadElements);

  useEffect(() => {
    loadElements(tessellationConfig.type);
  }, [tessellationConfig.type, loadElements]);

  if (!availableElements) return null;

  const vertexTotal = vertexWeights.reduce((s, w) => s + (w || 0), 0);
  const edgeTotal = edgeWeights.standard + edgeWeights.one_way;

  const chance = (w: number, total: number) =>
    total > 0 ? ((w / total) * 100).toFixed(1) + "%" : "—";

  return (
    <div style={styles.panel}>
      <div style={styles.section}>
        <div style={styles.sectionHeader}>Vertex elements</div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Type</th>
              <th style={styles.th}>Weight</th>
              <th style={styles.th}>Chance</th>
            </tr>
          </thead>
          <tbody>
            {availableElements.vertex_elements.map((el) => {
              const w = vertexWeights[el.degree] ?? 1.0;
              return (
                <tr key={el.degree}>
                  <td style={styles.td}>{el.label}</td>
                  <td style={styles.td}>
                    <input
                      type="number"
                      style={styles.input}
                      value={w}
                      min={0}
                      step={0.1}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (!isNaN(v) && v >= 0) setVertexWeight(el.degree, v);
                      }}
                    />
                  </td>
                  <td style={{ ...styles.td, ...styles.chanceCell }}>
                    {chance(w, vertexTotal)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={styles.divider} />

      <div style={styles.section}>
        <div style={styles.sectionHeader}>Cycle probability</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
          <input
            type="number"
            style={styles.input}
            value={cycleProb}
            min={0}
            max={1}
            step={0.05}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v)) setCycleProb(v);
            }}
          />
          <span style={{ fontSize: 11, color: "#888" }}>{(cycleProb * 100).toFixed(0)}% chance of cycle edge</span>
        </div>
      </div>

      <div style={styles.divider} />

      <div style={styles.section}>
        <div style={styles.sectionHeader}>Edge elements</div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Type</th>
              <th style={styles.th}>Weight</th>
              <th style={styles.th}>Chance</th>
            </tr>
          </thead>
          <tbody>
            {availableElements.edge_elements.map((el) => {
              const w = edgeWeights[el.id as "standard" | "one_way"] ?? 0;
              return (
                <tr key={el.id}>
                  <td style={styles.td}>{el.label}</td>
                  <td style={styles.td}>
                    <input
                      type="number"
                      style={styles.input}
                      value={w}
                      min={0}
                      step={0.01}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (!isNaN(v) && v >= 0) setEdgeWeight(el.id as "standard" | "one_way", v);
                      }}
                    />
                  </td>
                  <td style={{ ...styles.td, ...styles.chanceCell }}>
                    {chance(w, edgeTotal)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    background: "#222",
    borderRight: "1px solid #333",
    width: 480,
    minWidth: 480,
    overflowY: "auto",
    padding: "8px 0",
  },
  section: {
    padding: "0 10px",
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: "bold",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 6,
    borderBottom: "1px solid #333",
    paddingBottom: 4,
  },
  divider: {
    height: 1,
    background: "#333",
    margin: "10px 0",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
  },
  th: {
    fontSize: 10,
    color: "#666",
    textAlign: "left" as const,
    fontWeight: "normal",
    padding: "2px 4px",
    borderBottom: "1px solid #2a2a2a",
  },
  td: {
    fontSize: 11,
    color: "#ccc",
    padding: "3px 4px",
    verticalAlign: "middle" as const,
  },
  chanceCell: {
    color: "#888",
    textAlign: "right" as const,
    fontVariantNumeric: "tabular-nums",
    width: 52,
  },
  input: {
    background: "#2a2a2a",
    border: "1px solid #444",
    color: "#e0e0e0",
    fontSize: 11,
    borderRadius: 3,
    padding: "1px 4px",
    width: 60,
  },
};
