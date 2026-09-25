import React, { useState, useEffect } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { SquareShape, HexShape, TriangleShape, TessellationKind, FieldPrimitive } from "../../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { sharedStyles } from "../../styles/shared";
import { Button } from "../Button";
import { typography, muted, spacing, indent } from "../../styles/theme";
import { ConfirmModal } from "../ConfirmModal";
import { CopyFloorDialog } from "../dialogs/CopyFloorDialog";
import { Switch } from "../Switch";
import { Stack, Inline, Grid } from "../Layout";
import * as m from "~/paraglide/messages";

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

type ConfirmPending = "switchToDefault" | "clearField" | null;

export function FieldSetupFeature() {
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const squareShape = useMazeStore((s) => s.floorFields[s.activeFloorId].squareShape);
  const hexShape = useMazeStore((s) => s.floorFields[s.activeFloorId].hexShape);
  const triangleShape = useMazeStore((s) => s.floorFields[s.activeFloorId].triangleShape);
  const tessellationConfig = useMazeStore((s) => s.floorFields[s.activeFloorId].tessellationConfig);
  const fieldEditMode = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldEditMode);
  const fieldPrimitive = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPrimitive);
  const setSquareShape = useMazeStore((s) => s.setSquareShape);
  const setHexShape = useMazeStore((s) => s.setHexShape);
  const setTriangleShape = useMazeStore((s) => s.setTriangleShape);
  const setTessellationConfig = useMazeStore((s) => s.setTessellationConfig);
  const setFieldEditMode = useMazeStore((s) => s.setFieldEditMode);
  const setFieldPrimitive = useMazeStore((s) => s.setFieldPrimitive);
  const fieldPoints = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPoints);
  const clearFieldPoints = useMazeStore((s) => s.clearFieldPoints);
  const showFieldOrigin = useMazeStore((s) => s.showFieldOrigin);
  const setShowFieldOrigin = useMazeStore((s) => s.setShowFieldOrigin);
  const floorCount = useMazeStore((s) => s.floors.length);

  const [confirmPending, setConfirmPending] = useState<ConfirmPending>(null);
  const [copyFloorDialogOpen, setCopyFloorDialogOpen] = useState(false);

  const isHex = tessellationKind === "hex";
  const isCustom = fieldEditMode === "custom";

  function setField(field: string, value: number) {
    setTessellationConfig({ ...tessellationConfig, [field]: value } as TessellationConfig);
  }

  function handleSwitchToDefault() {
    if (isCustom && fieldPoints.size > 0) {
      setConfirmPending("switchToDefault");
    } else {
      setFieldEditMode("default");
    }
  }

  function handleClearField() {
    setConfirmPending("clearField");
  }

  function handleConfirm() {
    if (confirmPending === "switchToDefault") setFieldEditMode("default");
    if (confirmPending === "clearField") clearFieldPoints();
    setConfirmPending(null);
  }

  function renderShapeSelect() {
    if (tessellationKind === "square") {
      return (
        <label style={styles.label}>
          {m["field.shape"]()}
          <select style={styles.select} value={squareShape}
            onChange={(e) => setSquareShape(e.target.value as SquareShape)}>
            <option value="rect">{m["field.shape.rect"]()}</option>
          </select>
        </label>
      );
    }
    if (isHex) {
      return (
        <label style={styles.label}>
          {m["field.shape"]()}
          <select style={styles.select} value={hexShape}
            onChange={(e) => setHexShape(e.target.value as HexShape)}>
            <option value="parallelogram">{m["field.shape.parallelogram"]()}</option>
            <option value="hexagon">{m["field.shape.hexagon"]()}</option>
          </select>
        </label>
      );
    }
    return (
      <label style={styles.label}>
        {m["field.shape"]()}
        <select style={styles.select} value={triangleShape}
          onChange={(e) => setTriangleShape(e.target.value as TriangleShape)}>
          <option value="rect">{m["field.shape.rect"]()}</option>
          <option value="triangle">{m["field.shape.triangle"]()}</option>
          <option value="hexagon">{m["field.shape.hexagon"]()}</option>
        </select>
      </label>
    );
  }

  function renderParams() {
    if (tessellationConfig.type === "square") {
      return (
        <>
          <SizeParam label={m["field.width"]()} value={tessellationConfig.width} min={1} max={200} onCommit={(v) => setField("width", v)} />
          <SizeParam label={m["field.height"]()} value={tessellationConfig.height} min={1} max={200} onCommit={(v) => setField("height", v)} />
        </>
      );
    }
    if (tessellationConfig.type === "hex_parallelogram") {
      return (
        <>
          <SizeParam label={m["field.cols"]()} value={tessellationConfig.cols} min={1} max={200} onCommit={(v) => setField("cols", v)} />
          <SizeParam label={m["field.rows"]()} value={tessellationConfig.rows} min={1} max={200} onCommit={(v) => setField("rows", v)} />
        </>
      );
    }
    if (tessellationConfig.type === "hex_hexagon") {
      return <SizeParam label={m["field.radius"]()} value={tessellationConfig.radius} min={1} max={50} onCommit={(v) => setField("radius", v)} />;
    }
    if (tessellationConfig.type === "triangle_rect") {
      return (
        <>
          <SizeParam label={m["field.cols"]()} value={tessellationConfig.cols} min={1} max={200} onCommit={(v) => setField("cols", v)} />
          <SizeParam label={m["field.rows"]()} value={tessellationConfig.rows} min={1} max={200} onCommit={(v) => setField("rows", v)} />
        </>
      );
    }
    if (tessellationConfig.type === "triangle_triangle") {
      return <SizeParam label={m["field.side"]()} value={tessellationConfig.side} min={1} max={30} onCommit={(v) => setField("side", v)} />;
    }
    if (tessellationConfig.type === "triangle_hexagon") {
      return <SizeParam label={m["field.radius"]()} value={tessellationConfig.radius} min={1} max={15} onCommit={(v) => setField("radius", v)} />;
    }
    return null;
  }

  const confirmMessages: Record<NonNullable<ConfirmPending>, string> = {
    switchToDefault: m["field.confirm_switch_to_default"](),
    clearField: m["field.confirm_clear"](),
  };

  return (
    <Stack gap="groupGap">
      <Inline gap="itemGap">
        <Button
          variant={isCustom ? "toggle" : "toggle-selected"}
          onClick={handleSwitchToDefault}
        >
          {m["field.default"]()}
        </Button>
        <Button
          variant={isCustom ? "toggle-selected" : "toggle"}
          onClick={() => setFieldEditMode("custom")}
        >
          {m["field.custom"]()}
        </Button>
      </Inline>
      {!isCustom && (
        <>
          {renderShapeSelect()}
          {renderParams()}
        </>
      )}
      {isCustom && (
        <>
          <div style={styles.sectionLabel}>{m["field.tools"]()}</div>
          <Grid templateColumns="1fr 1fr" gap="itemGap" style={styles.nestedContent}>
          {primitivesForKind(tessellationKind).map(([p, label]) => (
            <Button
              key={p}
              variant={fieldPrimitive === p ? "toggle-selected" : "toggle"}
              onClick={() => setFieldPrimitive(p as FieldPrimitive)}
            >
              {label}
            </Button>
          ))}
          </Grid>
          <div style={styles.originRow}>
            <span style={styles.originLabel}>{m["field.show_origin"]()}</span>
            <Switch checked={showFieldOrigin} onChange={setShowFieldOrigin} />
          </div>
          <Button
            variant="destructive"
            layoutStyle={{ width: "100%", marginTop: spacing.itemGap }}
            onClick={handleClearField}
          >
            {m["field.clear"]()}
          </Button>
        </>
      )}
      {floorCount > 1 && (
        <Button
          variant="toggle"
          layoutStyle={{ width: "100%", marginTop: spacing.itemGap }}
          onClick={() => setCopyFloorDialogOpen(true)}
        >
          {m["field.copy_floor"]()}
        </Button>
      )}
      {confirmPending !== null && (
        <ConfirmModal
          message={confirmMessages[confirmPending]}
          onConfirm={handleConfirm}
          onCancel={() => setConfirmPending(null)}
        />
      )}
      {copyFloorDialogOpen && (
        <CopyFloorDialog onClose={() => setCopyFloorDialogOpen(false)} />
      )}
    </Stack>
  );
}

function primitivesForKind(kind: TessellationKind): [string, string][] {
  if (kind === "square") return [["point", m["field.shape.point"]()], ["square_rect", m["field.shape.rect"]()]];
  if (kind === "hex") return [["point", m["field.shape.point"]()], ["hex_parallelogram", m["field.shape.parallelogram"]()], ["hex_hexagon", m["field.shape.hexagon"]()]];
  return [["point", m["field.shape.point"]()], ["tri_rect", m["field.shape.rect"]()], ["tri_triangle", m["field.shape.triangle"]()], ["tri_hexagon", m["field.shape.hexagon"]()]];
}

function shapeLabel(kind: TessellationKind, squareShape: SquareShape, hexShape: HexShape, triangleShape: TriangleShape): string {
  if (kind === "square") return squareShape === "rect" ? m["field.shape.rect"]() : "Free";
  if (kind === "hex") {
    if (hexShape === "parallelogram") return m["field.shape.parallelogram"]();
    if (hexShape === "hexagon") return m["field.shape.hexagon"]();
    return "Free";
  }
  if (triangleShape === "rect") return m["field.shape.rect"]();
  if (triangleShape === "triangle") return m["field.shape.triangle"]();
  if (triangleShape === "hexagon") return m["field.shape.hexagon"]();
  return "Free";
}

function cellsLabel(count: number): string {
  return count === 1 ? m["field.cell"]({ count }) : m["field.cells"]({ count });
}

interface FloorFieldSummary {
  fieldEditMode: "default" | "custom";
  fieldPoints: Set<number>;
  squareShape: SquareShape;
  hexShape: HexShape;
  triangleShape: TriangleShape;
  tessellationConfig: TessellationConfig;
}

function floorCellCount(field: FloorFieldSummary): number {
  return field.fieldEditMode === "custom" ? field.fieldPoints.size : configCellCount(field.tessellationConfig);
}

function floorShapeLabel(kind: TessellationKind, field: FloorFieldSummary): string {
  if (field.fieldEditMode === "custom") return m["field.custom"]();
  const shape = shapeLabel(kind, field.squareShape, field.hexShape, field.triangleShape);
  const size = configSizeLabel(field.tessellationConfig);
  return size ? `${shape} · ${size}` : shape;
}

export function fieldSetupSubtitle(kind: TessellationKind, floorFields: FloorFieldSummary[]): string {
  const totalCount = floorFields.reduce((sum, f) => sum + floorCellCount(f), 0);
  const countStr = totalCount > 0 ? ` · ${cellsLabel(totalCount)}` : "";

  const labels = new Set(floorFields.map((f) => floorShapeLabel(kind, f)));
  const shape = labels.size === 1 ? [...labels][0] : m["field.different_shapes"]();
  return `${shape}${countStr}`;
}

export function configCellCount(cfg: TessellationConfig): number {
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
  label: sharedStyles.fieldLabel,
  select: sharedStyles.select,
  input: sharedStyles.input,
  sectionLabel: { ...typography.body, marginTop: spacing.groupGap },
  // One indent level for the "Tools" section's own content, relative to `sectionLabel`.
  nestedContent: { paddingLeft: indent.tree },
  originRow: { display: "flex", alignItems: "center", justifyContent: "space-between", ...muted(typography.body) },
  originLabel: { ...muted(typography.body) },
};
