import { useMazeStore } from "../store/mazeStore";
import type { HexShape, TriangleShape, TessellationKind, SquareShape, HexOrientation, TriOrientation } from "../store/mazeStore";
import type { TessellationConfig } from "../wasm/types";
import { sharedStyles, buttonStyle } from "../styles/shared";
import { colors } from "../styles/theme";

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
  const squareShape = useMazeStore((s) => s.squareShape);
  const hexShape = useMazeStore((s) => s.hexShape);
  const triangleShape = useMazeStore((s) => s.triangleShape);
  const hexOrientation = useMazeStore((s) => s.hexOrientation);
  const triOrientation = useMazeStore((s) => s.triOrientation);
  const tessellationConfig = useMazeStore((s) => s.tessellationConfig);
  const setSeed = useMazeStore((s) => s.setSeed);
  const setTessellationKind = useMazeStore((s) => s.setTessellationKind);
  const setSquareShape = useMazeStore((s) => s.setSquareShape);
  const setHexShape = useMazeStore((s) => s.setHexShape);
  const setTriangleShape = useMazeStore((s) => s.setTriangleShape);
  const setHexOrientation = useMazeStore((s) => s.setHexOrientation);
  const setTriOrientation = useMazeStore((s) => s.setTriOrientation);
  const setTessellationConfig = useMazeStore((s) => s.setTessellationConfig);
  const generate = useMazeStore((s) => s.generate);
  const reset = useMazeStore((s) => s.reset);
  const error = useMazeStore((s) => s.error);
  const warnings = useMazeStore((s) => s.warnings);
  const nodeStats = useMazeStore((s) => s.nodeStats);
  const isEditingField = useMazeStore((s) => s.isEditingField);
  const fieldPoints = useMazeStore((s) => s.fieldPoints);
  const showFieldOverlay = useMazeStore((s) => s.showFieldOverlay);
  const setShowFieldOverlay = useMazeStore((s) => s.setShowFieldOverlay);

  function setField(field: string, value: number | string) {
    setTessellationConfig({ ...tessellationConfig, [field]: value } as TessellationConfig);
  }

  const isHex = tessellationKind === "hex";
  const isTri = tessellationKind === "triangle";
  const generateDisabled = disabled || (isEditingField && fieldPoints.size < 2);
  const isFree = squareShape === "free" || hexShape === "free" || triangleShape === "free";

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
      {isHex && (
        <label style={styles.label}>
          Orientation
          <select
            style={styles.input}
            value={hexOrientation}
            onChange={(e) => setHexOrientation(e.target.value as HexOrientation)}
          >
            <option value="flat_top">Flat top</option>
            <option value="pointy_top">Pointy top</option>
          </select>
        </label>
      )}
      {isTri && (
        <label style={styles.label}>
          Orientation
          <select
            style={styles.input}
            value={triOrientation}
            onChange={(e) => setTriOrientation(e.target.value as TriOrientation)}
          >
            <option value="r0">0° — base bottom</option>
            <option value="r90">90° — base left</option>
            <option value="r180">180° — base top</option>
            <option value="r270">270° — base right</option>
          </select>
        </label>
      )}
      {tessellationKind === "square" && (
        <label style={styles.label}>
          Shape
          <select
            style={styles.input}
            value={squareShape}
            onChange={(e) => setSquareShape(e.target.value as SquareShape)}
          >
            <option value="rect">Rect</option>
            <option value="free">Free</option>
          </select>
        </label>
      )}
      {isHex && (
        <label style={styles.label}>
          Shape
          <select
            style={styles.input}
            value={hexShape}
            onChange={(e) => setHexShape(e.target.value as HexShape)}
          >
            <option value="parallelogram">Parallelogram</option>
            <option value="hexagon">Hexagon</option>
            <option value="free">Free</option>
          </select>
        </label>
      )}
      {isTri && (
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
            <option value="free">Free</option>
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
        </>
      )}
      {tessellationConfig.type === "hex_hexagon" && (
        <label style={styles.label}>
          Radius
          <input style={styles.input} type="number" min={1} max={50}
            value={tessellationConfig.radius}
            onChange={(e) => setField("radius", Number(e.target.value))}
          />
        </label>
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
        </>
      )}
      {tessellationConfig.type === "triangle_triangle" && (
        <label style={styles.label}>
          Side
          <input style={styles.input} type="number" min={1} max={30}
            value={tessellationConfig.side}
            onChange={(e) => setField("side", Number(e.target.value))}
          />
        </label>
      )}
      {tessellationConfig.type === "triangle_hexagon" && (
        <label style={styles.label}>
          Radius
          <input style={styles.input} type="number" min={1} max={15}
            value={tessellationConfig.radius}
            onChange={(e) => setField("radius", Number(e.target.value))}
          />
        </label>
      )}
      {isFree && (
        <>
          <label style={styles.label}>
            View
            <select
              style={styles.input}
              value={showFieldOverlay ? "overlay" : "maze"}
              onChange={(e) => setShowFieldOverlay(e.target.value === "overlay")}
            >
              <option value="overlay">Grid + cells</option>
              <option value="maze">Maze only</option>
            </select>
          </label>
          <div style={styles.freeInfo}>
            {fieldPoints.size} cell{fieldPoints.size !== 1 ? "s" : ""}
          </div>
        </>
      )}
      <button style={{ ...styles.btn, ...(generateDisabled ? styles.btnDisabled : {}) }} onClick={generate} disabled={generateDisabled}>Generate</button>
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
    borderBottom: `1px solid ${colors.borderMid}`,
  },
  title: sharedStyles.panelTitle,
  label: { ...sharedStyles.fieldLabel, gap: 2 },
  input: sharedStyles.input,
  btn: buttonStyle("primary"),
  btnSecondary: { background: colors.bgBtnSecondary },
  btnSettings: { background: colors.bgBtnMuted },
  btnSettingsActive: { background: colors.bgBtnPrimaryActive, outline: `1px solid ${colors.bgBtnPrimary}` },
  btnDisabled: sharedStyles.btnDisabled,
  freeInfo: { fontSize: 11, color: colors.textDim, textAlign: "center" },
  warning: sharedStyles.warningMsg,
  error: sharedStyles.errorMsg,
};
