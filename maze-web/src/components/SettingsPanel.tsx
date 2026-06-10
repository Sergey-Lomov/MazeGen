import React from "react";
import { useMazeStore } from "../store/mazeStore";
import { GenerationParamsPanel } from "./GenerationParamsPanel";
import { EdgeBasedParamsPanel } from "./EdgeBasedParamsPanel";
import { ElementsPanel } from "./ElementsPanel";
import { QualityControlPanel } from "./QualityControlPanel";
import { sharedStyles } from "../styles/shared";
import { colors } from "../styles/theme";

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
  section: {},
  sectionHeader: {
    ...sharedStyles.sectionHeader,
    borderBottom: `1px solid ${colors.borderMid}`,
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
    color: colors.textMuted,
    width: 110,
    flexShrink: 0,
  },
  select: {
    ...sharedStyles.select,
    flex: 1,
    color: colors.textSecondary,
  },
};
