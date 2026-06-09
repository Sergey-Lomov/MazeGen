import { useMazeStore } from "../store/mazeStore";
import type { GenerationParams } from "../wasm/types";

const PARAMS: { key: keyof GenerationParams; label: string }[] = [
  { key: "depth_first",     label: "Depth First" },
  { key: "corridor_chance", label: "Corridor Chance" },
  { key: "branching",       label: "Branching" },
  { key: "directionality",  label: "Directionality" },
];

export function GenerationParamsPanel() {
  const initialConfig = useMazeStore((s) => s.initialConfig);
  const setGenerationParam = useMazeStore((s) => s.setGenerationParam);

  if (initialConfig.method !== "custom_vertex_based") return null;
  const params: GenerationParams = initialConfig;

  return (
    <div style={styles.panel}>
      {PARAMS.map(({ key, label }) => {
        const value = params[key] ?? 0;
        return (
          <div key={key} style={styles.row}>
            <span style={styles.label}>{label}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={value}
              style={styles.slider}
              onChange={(e) => setGenerationParam(key, parseFloat(e.target.value))}
            />
            <span style={styles.value}>{value.toFixed(2)}</span>
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    padding: "8px 10px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  label: {
    fontSize: 11,
    color: "#ccc",
    width: 110,
    flexShrink: 0,
  },
  slider: {
    flex: 1,
    accentColor: "#5a9",
  },
  value: {
    fontSize: 11,
    color: "#888",
    width: 32,
    textAlign: "right",
    flexShrink: 0,
  },
};
