import { useMazeStore } from "../store/mazeStore";
import type { EdgeBasedParams } from "../wasm/types";
import { sharedStyles } from "../styles/shared";

const PARAMS: { key: keyof EdgeBasedParams; label: string }[] = [
  { key: "corridor_length", label: "Corridor Length" },
  { key: "branching",       label: "Branching" },
  { key: "locality",        label: "Locality" },
  { key: "directionality",  label: "Directionality" },
];

export function EdgeBasedParamsPanel() {
  const initialConfig = useMazeStore((s) => s.initialConfig);
  const setEdgeBasedParam = useMazeStore((s) => s.setEdgeBasedParam);

  if (initialConfig.method !== "custom_edge_based") return null;
  const params: EdgeBasedParams = initialConfig;

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
              onChange={(e) => setEdgeBasedParam(key, parseFloat(e.target.value))}
            />
            <span style={styles.value}>{value.toFixed(2)}</span>
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: { padding: "8px 10px" },
  row: sharedStyles.sliderRow,
  label: sharedStyles.sliderRowLabel,
  slider: sharedStyles.sliderInput,
  value: sharedStyles.sliderRowValue,
};
