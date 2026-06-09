import React from "react";
import { useMazeStore } from "../store/mazeStore";
import { GenerationParamsPanel } from "./GenerationParamsPanel";
import { EdgeBasedParamsPanel } from "./EdgeBasedParamsPanel";
import { ElementsPanel } from "./ElementsPanel";
import { QualityControlPanel } from "./QualityControlPanel";

type MethodMeta = { label: string; component?: React.ComponentType };

// When adding a method: 1) add entry here, 2) add to defaults in mazeStore.setGenerationMethod, 3) add Rust enum variant
const GENERATION_METHODS: Record<string, MethodMeta> = {
  custom_vertex_based: {
    label: "Custom Vertex-Based",
    component: GenerationParamsPanel,
  },
  custom_edge_based: {
    label: "Custom Edge-Based",
    component: EdgeBasedParamsPanel,
  },
  recursive_backtracker: {
    label: "Recursive Backtracker",
  },
  wilson_algorithm: {
    label: "Wilson's Algorithm",
  },
  kruskal_algorithm: {
    label: "Kruskal's Algorithm",
  },
};

export function SettingsPanel() {
  const initialConfig = useMazeStore((s) => s.initialConfig);
  const setGenerationMethod = useMazeStore((s) => s.setGenerationMethod);
  const ParamsComponent = GENERATION_METHODS[initialConfig.method]?.component;

  return (
    <div style={styles.panel}>
      <div style={styles.section}>
        <div style={styles.sectionHeader}>Initial Generation</div>
        <div style={styles.methodRow}>
          <span style={styles.methodLabel}>Method</span>
          <select
            style={styles.select}
            value={initialConfig.method}
            onChange={(e) => setGenerationMethod(e.target.value)}
          >
            {Object.entries(GENERATION_METHODS).map(([id, { label }]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </div>
        {ParamsComponent && <ParamsComponent />}
      </div>

      <div style={styles.section}>
        <div style={styles.sectionHeader}>Elements</div>
        <ElementsPanel />
      </div>

      <div style={styles.section}>
        <div style={styles.sectionHeader}>Post-processing</div>
        <QualityControlPanel />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
  },
  section: {
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: "bold",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 1,
    borderBottom: "1px solid #333",
    padding: "8px 10px 4px",
  },
  methodRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
  },
  methodLabel: {
    fontSize: 11,
    color: "#ccc",
    width: 110,
    flexShrink: 0,
  },
  select: {
    flex: 1,
    background: "#2a2a2a",
    color: "#ddd",
    border: "1px solid #444",
    borderRadius: 3,
    padding: "3px 6px",
    fontSize: 12,
  },
};
