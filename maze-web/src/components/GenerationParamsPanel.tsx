import { useMazeStore } from "../store/mazeStore";
import type { GenerationParams } from "../wasm/types";

const PARAMS: { key: keyof GenerationParams; label: string }[] = [
  { key: "depth_first",     label: "Depth First" },
  { key: "corridor_chance", label: "Corridor Chance" },
  { key: "branching",       label: "Branching" },
  { key: "directionality",  label: "Directionality" },
  { key: "one_way_chance",  label: "One-Way Chance" },
];

export function GenerationParamsPanel() {
  const generationParams = useMazeStore((s) => s.generationParams);
  const setGenerationParam = useMazeStore((s) => s.setGenerationParam);

  return (
    <div style={styles.panel}>
      <div style={styles.colHeader}>Generation</div>
      {PARAMS.map(({ key, label }) => {
        const value = generationParams[key] ?? 0;
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
    borderBottom: "1px solid #333",
  },
  colHeader: {
    fontSize: 11,
    fontWeight: "bold",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 8,
    borderBottom: "1px solid #333",
    paddingBottom: 4,
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
