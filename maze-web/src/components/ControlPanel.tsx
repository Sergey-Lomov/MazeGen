import { useMazeStore } from "../store/mazeStore";
import type { TessellationConfig } from "../wasm/types";

interface Props {
  disabled?: boolean;
  onSettingsToggle?: () => void;
  settingsOpen?: boolean;
}

export function ControlPanel({ disabled = false, onSettingsToggle, settingsOpen = false }: Props) {
  const seed = useMazeStore((s) => s.seed);
  const tessellationConfig = useMazeStore((s) => s.tessellationConfig);
  const setSeed = useMazeStore((s) => s.setSeed);
  const setTessellationConfig = useMazeStore((s) => s.setTessellationConfig);
  const generate = useMazeStore((s) => s.generate);
  const reset = useMazeStore((s) => s.reset);
  const error = useMazeStore((s) => s.error);
  const warnings = useMazeStore((s) => s.warnings);

  function handleTypeChange(type: "square" | "hex") {
    if (type === "square") {
      const cfg = tessellationConfig.type === "square"
        ? tessellationConfig
        : { type: "square" as const, width: 10, height: 10 };
      setTessellationConfig(cfg);
    } else {
      const cfg = tessellationConfig.type === "hex"
        ? tessellationConfig
        : { type: "hex" as const, cols: 10, rows: 10, orientation: "flat_top" as const };
      setTessellationConfig(cfg);
    }
  }

  function setField(field: string, value: number | string) {
    setTessellationConfig({ ...tessellationConfig, [field]: value } as TessellationConfig);
  }

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
        Tessellation
        <select
          style={styles.input}
          value={tessellationConfig.type}
          onChange={(e) => handleTypeChange(e.target.value as "square" | "hex")}
        >
          <option value="square">Square</option>
          <option value="hex">Hex</option>
        </select>
      </label>
      {tessellationConfig.type === "square" && (
        <>
          <label style={styles.label}>
            Width
            <input
              style={styles.input}
              type="number"
              min={1}
              max={200}
              value={tessellationConfig.width}
              onChange={(e) => setField("width", Number(e.target.value))}
            />
          </label>
          <label style={styles.label}>
            Height
            <input
              style={styles.input}
              type="number"
              min={1}
              max={200}
              value={tessellationConfig.height}
              onChange={(e) => setField("height", Number(e.target.value))}
            />
          </label>
        </>
      )}
      {tessellationConfig.type === "hex" && (
        <>
          <label style={styles.label}>
            Cols
            <input
              style={styles.input}
              type="number"
              min={1}
              max={200}
              value={tessellationConfig.cols}
              onChange={(e) => setField("cols", Number(e.target.value))}
            />
          </label>
          <label style={styles.label}>
            Rows
            <input
              style={styles.input}
              type="number"
              min={1}
              max={200}
              value={tessellationConfig.rows}
              onChange={(e) => setField("rows", Number(e.target.value))}
            />
          </label>
          <label style={styles.label}>
            Orientation
            <select
              style={styles.input}
              value={tessellationConfig.orientation ?? "flat_top"}
              onChange={(e) => setField("orientation", e.target.value)}
            >
              <option value="flat_top">Flat top</option>
              <option value="pointy_top">Pointy top</option>
            </select>
          </label>
        </>
      )}
      <button style={{ ...styles.btn, ...(disabled ? styles.btnDisabled : {}) }} onClick={generate} disabled={disabled}>Generate</button>
      <button style={{ ...styles.btn, ...styles.btnSecondary, ...(disabled ? styles.btnDisabled : {}) }} onClick={reset} disabled={disabled}>Reset</button>
      <button style={{ ...styles.btn, ...styles.btnSettings, ...(settingsOpen ? styles.btnSettingsActive : {}) }} onClick={onSettingsToggle}>Settings</button>
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
  btnSettings: { background: "#444" },
  btnSettingsActive: { background: "#2a5080", outline: "1px solid #3a6ea8" },
  btnDisabled: { opacity: 0.4, cursor: "not-allowed" },
  warning: { fontSize: 11, color: "#ffaa44", background: "#2a2010", padding: "4px 6px", borderRadius: 3 },
  error: { fontSize: 11, color: "#ff6b6b", background: "#2a1a1a", padding: "4px 6px", borderRadius: 3 },
};
