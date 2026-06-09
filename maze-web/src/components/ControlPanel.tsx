import { useMazeStore } from "../store/mazeStore";
import type { HexShape, TriangleShape, TessellationKind } from "../store/mazeStore";
import type { TessellationConfig } from "../wasm/types";

interface Props {
  disabled?: boolean;
  onSettingsToggle?: () => void;
  settingsOpen?: boolean;
  onInfoToggle?: () => void;
  infoOpen?: boolean;
  onDebugToggle?: () => void;
  debugOpen?: boolean;
}

export function ControlPanel({ disabled = false, onSettingsToggle, settingsOpen = false, onInfoToggle, infoOpen = false, onDebugToggle, debugOpen = false }: Props) {
  const seed = useMazeStore((s) => s.seed);
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const hexShape = useMazeStore((s) => s.hexShape);
  const triangleShape = useMazeStore((s) => s.triangleShape);
  const tessellationConfig = useMazeStore((s) => s.tessellationConfig);
  const setSeed = useMazeStore((s) => s.setSeed);
  const setTessellationKind = useMazeStore((s) => s.setTessellationKind);
  const setHexShape = useMazeStore((s) => s.setHexShape);
  const setTriangleShape = useMazeStore((s) => s.setTriangleShape);
  const setTessellationConfig = useMazeStore((s) => s.setTessellationConfig);
  const generate = useMazeStore((s) => s.generate);
  const reset = useMazeStore((s) => s.reset);
  const error = useMazeStore((s) => s.error);
  const warnings = useMazeStore((s) => s.warnings);
  const nodeStats = useMazeStore((s) => s.nodeStats);

  function setField(field: string, value: number | string) {
    setTessellationConfig({ ...tessellationConfig, [field]: value } as TessellationConfig);
  }

  const showHexShape = tessellationKind === "hex";
  const showTriangleShape = tessellationKind === "triangle";

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
          value={tessellationKind}
          onChange={(e) => setTessellationKind(e.target.value as TessellationKind)}
        >
          <option value="square">Square</option>
          <option value="hex">Hex</option>
          <option value="triangle">Triangle</option>
        </select>
      </label>
      {showHexShape && (
        <label style={styles.label}>
          Shape
          <select
            style={styles.input}
            value={hexShape}
            onChange={(e) => setHexShape(e.target.value as HexShape)}
          >
            <option value="parallelogram">Parallelogram</option>
            <option value="hexagon">Hexagon</option>
          </select>
        </label>
      )}
      {showTriangleShape && (
        <label style={styles.label}>
          Shape
          <select
            style={styles.input}
            value={triangleShape}
            onChange={(e) => setTriangleShape(e.target.value as TriangleShape)}
          >
            <option value="rect">Rect</option>
            <option value="triangle">Triangle</option>
            <option value="hexagon">Hexagon</option>
          </select>
        </label>
      )}
      {tessellationConfig.type === "square" && (
        <>
          <label style={styles.label}>
            Width
            <input style={styles.input} type="number" min={1} max={200}
              value={tessellationConfig.width}
              onChange={(e) => setField("width", Number(e.target.value))}
            />
          </label>
          <label style={styles.label}>
            Height
            <input style={styles.input} type="number" min={1} max={200}
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
            <input style={styles.input} type="number" min={1} max={200}
              value={tessellationConfig.cols}
              onChange={(e) => setField("cols", Number(e.target.value))}
            />
          </label>
          <label style={styles.label}>
            Rows
            <input style={styles.input} type="number" min={1} max={200}
              value={tessellationConfig.rows}
              onChange={(e) => setField("rows", Number(e.target.value))}
            />
          </label>
          <label style={styles.label}>
            Orientation
            <select style={styles.input}
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
            <input style={styles.input} type="number" min={1} max={50}
              value={tessellationConfig.radius}
              onChange={(e) => setField("radius", Number(e.target.value))}
            />
          </label>
          <label style={styles.label}>
            Orientation
            <select style={styles.input}
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
            <input style={styles.input} type="number" min={1} max={200}
              value={tessellationConfig.cols}
              onChange={(e) => setField("cols", Number(e.target.value))}
            />
          </label>
          <label style={styles.label}>
            Rows
            <input style={styles.input} type="number" min={1} max={200}
              value={tessellationConfig.rows}
              onChange={(e) => setField("rows", Number(e.target.value))}
            />
          </label>
          <label style={styles.label}>
            Orientation
            <select style={styles.input}
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
            <input style={styles.input} type="number" min={1} max={30}
              value={tessellationConfig.side}
              onChange={(e) => setField("side", Number(e.target.value))}
            />
          </label>
          <label style={styles.label}>
            Orientation
            <select style={styles.input}
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
            <input style={styles.input} type="number" min={1} max={15}
              value={tessellationConfig.radius}
              onChange={(e) => setField("radius", Number(e.target.value))}
            />
          </label>
          <label style={styles.label}>
            Orientation
            <select style={styles.input}
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
      <button style={{ ...styles.btn, ...styles.btnSettings, ...(infoOpen ? styles.btnSettingsActive : {}), ...(nodeStats === null ? styles.btnDisabled : {}) }} onClick={onInfoToggle} disabled={nodeStats === null}>Info</button>
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
