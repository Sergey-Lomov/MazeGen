import type React from "react";
import { useMazeStore } from "../store/mazeStore";
import type { ElementsConfig } from "../wasm/types";
import { sharedStyles } from "../styles/shared";

const PARAMS: { key: keyof ElementsConfig; label: string }[] = [
  { key: "one_way_chance", label: "One-Way Chance" },
];

export function ElementsPanel() {
  const elementsConfig = useMazeStore((s) => s.elementsConfig);
  const setElementsParam = useMazeStore((s) => s.setElementsParam);

  return (
    <div style={styles.panel}>
      {PARAMS.map(({ key, label }) => {
        const value = elementsConfig[key] ?? 0;
        return (
          <div key={key} style={styles.row}>
            <span style={styles.label}>{label}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={value}
              style={styles.slider}
              onChange={(e) => setElementsParam(key, parseFloat(e.target.value))}
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
