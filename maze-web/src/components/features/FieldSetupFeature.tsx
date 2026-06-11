import React, { useState, useEffect } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { SquareShape, HexShape, TriangleShape, TessellationKind, FieldPrimitive } from "../../store/mazeStore";
import type { TessellationConfig } from "../../wasm/types";
import { sharedStyles } from "../../styles/shared";
import { colors } from "../../styles/theme";

interface SizeParamProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
}

function SizeParam({ label, value, min, max, onCommit }: SizeParamProps) {
  const [local, setLocal] = useState(String(value));

  useEffect(() => { setLocal(String(value)); }, [value]);

  function commit() {
    const n = Number(local);
    if (!isNaN(n) && n >= min && n <= max) onCommit(n);
    else setLocal(String(value));
  }

  return (
    <label style={styles.label}>
      {label}
      <input
        style={styles.input}
        type="number"
        min={min}
        max={max}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); } }}
      />
    </label>
  );
}

export function FieldSetupFeature() {
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const squareShape = useMazeStore((s) => s.squareShape);
  const hexShape = useMazeStore((s) => s.hexShape);
  const triangleShape = useMazeStore((s) => s.triangleShape);
  const tessellationConfig = useMazeStore((s) => s.tessellationConfig);
  const fieldEditMode = useMazeStore((s) => s.fieldEditMode);
  const fieldPrimitive = useMazeStore((s) => s.fieldPrimitive);
  const setSquareShape = useMazeStore((s) => s.setSquareShape);
  const setHexShape = useMazeStore((s) => s.setHexShape);
  const setTriangleShape = useMazeStore((s) => s.setTriangleShape);
  const setTessellationConfig = useMazeStore((s) => s.setTessellationConfig);
  const setFieldEditMode = useMazeStore((s) => s.setFieldEditMode);
  const setFieldPrimitive = useMazeStore((s) => s.setFieldPrimitive);
  const clearFieldPoints = useMazeStore((s) => s.clearFieldPoints);

  const isHex = tessellationKind === "hex";
  const isCustom = fieldEditMode === "custom";

  function setField(field: string, value: number) {
    setTessellationConfig({ ...tessellationConfig, [field]: value } as TessellationConfig);
  }

  function renderShapeSelect() {
    if (tessellationKind === "square") {
      return (
        <label style={styles.label}>
          Shape
          <select style={styles.select} value={squareShape}
            onChange={(e) => setSquareShape(e.target.value as SquareShape)}>
            <option value="rect">Rect</option>
          </select>
        </label>
      );
    }
    if (isHex) {
      return (
        <label style={styles.label}>
          Shape
          <select style={styles.select} value={hexShape}
            onChange={(e) => setHexShape(e.target.value as HexShape)}>
            <option value="parallelogram">Parallelogram</option>
            <option value="hexagon">Hexagon</option>
          </select>
        </label>
      );
    }
    return (
      <label style={styles.label}>
        Shape
        <select style={styles.select} value={triangleShape}
          onChange={(e) => setTriangleShape(e.target.value as TriangleShape)}>
          <option value="rect">Rect</option>
          <option value="triangle">Triangle</option>
          <option value="hexagon">Hexagon</option>
        </select>
      </label>
    );
  }

  function renderParams() {
    if (tessellationConfig.type === "square") {
      return (
        <>
          <SizeParam label="Width" value={tessellationConfig.width} min={1} max={200} onCommit={(v) => setField("width", v)} />
          <SizeParam label="Height" value={tessellationConfig.height} min={1} max={200} onCommit={(v) => setField("height", v)} />
        </>
      );
    }
    if (tessellationConfig.type === "hex_parallelogram") {
      return (
        <>
          <SizeParam label="Cols" value={tessellationConfig.cols} min={1} max={200} onCommit={(v) => setField("cols", v)} />
          <SizeParam label="Rows" value={tessellationConfig.rows} min={1} max={200} onCommit={(v) => setField("rows", v)} />
        </>
      );
    }
    if (tessellationConfig.type === "hex_hexagon") {
      return <SizeParam label="Radius" value={tessellationConfig.radius} min={1} max={50} onCommit={(v) => setField("radius", v)} />;
    }
    if (tessellationConfig.type === "triangle_rect") {
      return (
        <>
          <SizeParam label="Cols" value={tessellationConfig.cols} min={1} max={200} onCommit={(v) => setField("cols", v)} />
          <SizeParam label="Rows" value={tessellationConfig.rows} min={1} max={200} onCommit={(v) => setField("rows", v)} />
        </>
      );
    }
    if (tessellationConfig.type === "triangle_triangle") {
      return <SizeParam label="Side" value={tessellationConfig.side} min={1} max={30} onCommit={(v) => setField("side", v)} />;
    }
    if (tessellationConfig.type === "triangle_hexagon") {
      return <SizeParam label="Radius" value={tessellationConfig.radius} min={1} max={15} onCommit={(v) => setField("radius", v)} />;
    }
    return null;
  }

  return (
    <div style={styles.root}>
      <div style={styles.toggleRow}>
        <button
          style={{ ...styles.toggleBtn, ...(isCustom ? {} : styles.toggleBtnActive) }}
          onClick={() => setFieldEditMode("default")}
        >
          Default
        </button>
        <button
          style={{ ...styles.toggleBtn, ...(isCustom ? styles.toggleBtnActive : {}) }}
          onClick={() => setFieldEditMode("custom")}
        >
          Custom
        </button>
      </div>
      {!isCustom && (
        <>
          {renderShapeSelect()}
          {renderParams()}
        </>
      )}
      {isCustom && (
        <>
          <div style={styles.sectionLabel}>Tools</div>
          <div style={styles.primitiveGrid}>
          {primitivesForKind(tessellationKind).map(([p, label]) => (
            <button
              key={p}
              style={{ ...styles.primitiveBtn, ...(fieldPrimitive === p ? styles.toggleBtnActive : {}) }}
              onClick={() => setFieldPrimitive(p as FieldPrimitive)}
            >
              {label}
            </button>
          ))}
          </div>
          <button
            style={styles.clearBtn}
            onClick={() => {
              if (window.confirm("Clear all field cells?")) clearFieldPoints();
            }}
          >
            Clear
          </button>
        </>
      )}
    </div>
  );
}

function primitivesForKind(kind: TessellationKind): [string, string][] {
  if (kind === "square") return [["point", "Point"], ["square_rect", "Rect"]];
  if (kind === "hex") return [["point", "Point"], ["hex_parallelogram", "Parallelogram"], ["hex_hexagon", "Hexagon"]];
  return [["point", "Point"], ["tri_rect", "Rect"], ["tri_triangle", "Triangle"], ["tri_hexagon", "Hexagon"]];
}

function shapeLabel(kind: TessellationKind, squareShape: SquareShape, hexShape: HexShape, triangleShape: TriangleShape): string {
  if (kind === "square") return squareShape === "rect" ? "Rect" : "Free";
  if (kind === "hex") {
    if (hexShape === "parallelogram") return "Parallelogram";
    if (hexShape === "hexagon") return "Hexagon";
    return "Free";
  }
  if (triangleShape === "rect") return "Rect";
  if (triangleShape === "triangle") return "Triangle";
  if (triangleShape === "hexagon") return "Hexagon";
  return "Free";
}

export function fieldSetupSubtitle(
  kind: TessellationKind,
  squareShape: SquareShape,
  hexShape: HexShape,
  triangleShape: TriangleShape,
  fieldEditMode: "default" | "custom",
  fieldPoints: Set<number>,
  tessellationConfig: TessellationConfig,
): string {
  if (fieldEditMode === "custom") {
    const n = fieldPoints.size;
    return `Custom · ${n} cell${n !== 1 ? "s" : ""}`;
  }
  const shape = shapeLabel(kind, squareShape, hexShape, triangleShape);
  const size = configSizeLabel(tessellationConfig);
  const count = configCellCount(tessellationConfig);
  const countStr = count > 0 ? ` · ${count} cell${count !== 1 ? "s" : ""}` : "";
  return size ? `${shape} · ${size}${countStr}` : `${shape}${countStr}`;
}

function configCellCount(cfg: TessellationConfig): number {
  if (cfg.type === "square") return cfg.width * cfg.height;
  if (cfg.type === "hex_parallelogram" || cfg.type === "triangle_rect") return cfg.cols * cfg.rows;
  if (cfg.type === "hex_hexagon") { const r = cfg.radius; return 3 * r * r + 3 * r + 1; }
  if (cfg.type === "triangle_triangle") { const n = cfg.side; return n * n; }
  if (cfg.type === "triangle_hexagon") {
    const r = cfg.radius;
    let count = 0;
    for (let row = 0; row < 2 * r; row++) {
      const k = Math.min(row, 2 * r - 1 - row);
      count += 2 * (k + r) + 1;
    }
    return count;
  }
  return 0;
}

function configSizeLabel(cfg: TessellationConfig): string {
  if (cfg.type === "square") return `${cfg.width}×${cfg.height}`;
  if (cfg.type === "hex_parallelogram" || cfg.type === "triangle_rect") return `${cfg.cols}×${cfg.rows}`;
  if (cfg.type === "hex_hexagon" || cfg.type === "triangle_hexagon") return `r${cfg.radius}`;
  if (cfg.type === "triangle_triangle") return `s${cfg.side}`;
  return "";
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: 8 },
  toggleRow: { display: "flex", gap: 4 },
  toggleBtn: sharedStyles.toggleBtn,
  toggleBtnActive: sharedStyles.toggleBtnActive,
  label: sharedStyles.fieldLabel,
  select: sharedStyles.select,
  input: sharedStyles.input,
  sectionLabel: { fontSize: 11, color: colors.textFaint },
  primitiveGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 },
  primitiveBtn: { ...sharedStyles.toggleBtn, flex: undefined },
  clearBtn: { ...sharedStyles.toggleBtn, flex: undefined, width: "100%", marginTop: 4, color: colors.textError, borderColor: colors.textError },
};
