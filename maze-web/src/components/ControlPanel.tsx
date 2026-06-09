import { useMazeStore } from "../store/mazeStore";
import type { TessellationConfig } from "../wasm/types";

interface Props {
  disabled?: boolean;
  onSettingsToggle?: () => void;
  settingsOpen?: boolean;
  onDebugToggle?: () => void;
  debugOpen?: boolean;
}

type TessType = TessellationConfig["type"];

function orientationOf(cfg: TessellationConfig): "flat_top" | "pointy_top" | "r0" | "r90" | "r180" | "r270" {
  if (cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon") {
    return cfg.orientation ?? "flat_top";
  }
  if (cfg.type === "triangle_rect" || cfg.type === "triangle_triangle" || cfg.type === "triangle_hexagon") {
    return cfg.orientation ?? "r0";
  }
  return "r0";
}

export function ControlPanel({ disabled = false, onSettingsToggle, settingsOpen = false, onDebugToggle, debugOpen = false }: Props) {
  const seed = useMazeStore((s) => s.seed);
  const tessellationConfig = useMazeStore((s) => s.tessellationConfig);
  const setSeed = useMazeStore((s) => s.setSeed);
  const setTessellationConfig = useMazeStore((s) => s.setTessellationConfig);
  const generate = useMazeStore((s) => s.generate);
  const reset = useMazeStore((s) => s.reset);
  const error = useMazeStore((s) => s.error);
  const warnings = useMazeStore((s) => s.warnings);

  function handleTypeChange(type: TessType) {
    if (type === "square") {
      if (tessellationConfig.type === "square") return;
      setTessellationConfig({ type: "square", width: 10, height: 10 });
    } else if (type === "hex_parallelogram") {
      const orientation = orientationOf(tessellationConfig);
      if (tessellationConfig.type === "hex_parallelogram") return;
      setTessellationConfig({ type: "hex_parallelogram", cols: 10, rows: 10, orientation: (orientation === "flat_top" || orientation === "pointy_top") ? orientation : "flat_top" });
    } else if (type === "hex_hexagon") {
      const orientation = orientationOf(tessellationConfig);
      if (tessellationConfig.type === "hex_hexagon") return;
      setTessellationConfig({ type: "hex_hexagon", radius: 5, orientation: (orientation === "flat_top" || orientation === "pointy_top") ? orientation : "flat_top" });
    } else if (type === "triangle_rect") {
      if (tessellationConfig.type === "triangle_rect") return;
      const triOrient = orientationOf(tessellationConfig);
      const triO = (triOrient === "r0" || triOrient === "r90" || triOrient === "r180" || triOrient === "r270") ? triOrient : "r0";
      setTessellationConfig({ type: "triangle_rect", cols: 10, rows: 10, orientation: triO });
    } else if (type === "triangle_triangle") {
      if (tessellationConfig.type === "triangle_triangle") return;
      const triOrient = orientationOf(tessellationConfig);
      const triO = (triOrient === "r0" || triOrient === "r90" || triOrient === "r180" || triOrient === "r270") ? triOrient : "r0";
      setTessellationConfig({ type: "triangle_triangle", side: 8, orientation: triO });
    } else {
      if (tessellationConfig.type === "triangle_hexagon") return;
      const triOrient = orientationOf(tessellationConfig);
      const triO = (triOrient === "r0" || triOrient === "r90" || triOrient === "r180" || triOrient === "r270") ? triOrient : "r0";
      setTessellationConfig({ type: "triangle_hexagon", radius: 4, orientation: triO });
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
          onChange={(e) => handleTypeChange(e.target.value as TessType)}
        >
          <option value="square">Square</option>
          <option value="hex_parallelogram">Hex parallelogram</option>
          <option value="hex_hexagon">Hex hexagon</option>
          <option value="triangle_rect">Triangle rect</option>
          <option value="triangle_triangle">Triangle triangle</option>
          <option value="triangle_hexagon">Triangle hexagon</option>
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
      {tessellationConfig.type === "hex_parallelogram" && (
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
      {tessellationConfig.type === "hex_hexagon" && (
        <>
          <label style={styles.label}>
            Radius
            <input
              style={styles.input}
              type="number"
              min={1}
              max={50}
              value={tessellationConfig.radius}
              onChange={(e) => setField("radius", Number(e.target.value))}
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
      {tessellationConfig.type === "triangle_rect" && (
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
              value={tessellationConfig.orientation ?? "r0"}
              onChange={(e) => setField("orientation", e.target.value)}
            >
              <option value="r0">0° — base bottom</option>
              <option value="r90">90° — base left</option>
              <option value="r180">180° — base top</option>
              <option value="r270">270° — base right</option>
            </select>
          </label>
        </>
      )}
      {tessellationConfig.type === "triangle_triangle" && (
        <>
          <label style={styles.label}>
            Side
            <input
              style={styles.input}
              type="number"
              min={1}
              max={30}
              value={tessellationConfig.side}
              onChange={(e) => setField("side", Number(e.target.value))}
            />
          </label>
          <label style={styles.label}>
            Orientation
            <select
              style={styles.input}
              value={tessellationConfig.orientation ?? "r0"}
              onChange={(e) => setField("orientation", e.target.value)}
            >
              <option value="r0">0° — base bottom</option>
              <option value="r90">90° — base left</option>
              <option value="r180">180° — base top</option>
              <option value="r270">270° — base right</option>
            </select>
          </label>
        </>
      )}
      {tessellationConfig.type === "triangle_hexagon" && (
        <>
          <label style={styles.label}>
            Radius
            <input
              style={styles.input}
              type="number"
              min={1}
              max={15}
              value={tessellationConfig.radius}
              onChange={(e) => setField("radius", Number(e.target.value))}
            />
          </label>
          <label style={styles.label}>
            Orientation
            <select
              style={styles.input}
              value={tessellationConfig.orientation ?? "r0"}
              onChange={(e) => setField("orientation", e.target.value)}
            >
              <option value="r0">0° — base bottom</option>
              <option value="r90">90° — base left</option>
              <option value="r180">180° — base top</option>
              <option value="r270">270° — base right</option>
            </select>
          </label>
        </>
      )}
      <button style={{ ...styles.btn, ...(disabled ? styles.btnDisabled : {}) }} onClick={generate} disabled={disabled}>Generate</button>
      <button style={{ ...styles.btn, ...styles.btnSecondary, ...(disabled ? styles.btnDisabled : {}) }} onClick={reset} disabled={disabled}>Reset</button>
      <button style={{ ...styles.btn, ...styles.btnSettings, ...(settingsOpen ? styles.btnSettingsActive : {}) }} onClick={onSettingsToggle}>Settings</button>
      <button style={{ ...styles.btn, ...styles.btnSettings, ...(debugOpen ? styles.btnSettingsActive : {}), ...(disabled ? styles.btnDisabled : {}) }} onClick={onDebugToggle} disabled={disabled}>Debug</button>
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
