import React, { useState, useEffect } from "react";
import { Circle, Hexagon, Square, Triangle } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { SquareShape, HexShape, TriangleShape, TessellationKind, FieldPrimitive } from "../../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { sharedStyles } from "../../styles/shared";
import { Button } from "../Button";
import { ToolIconButton } from "../ToolIconButton";
import { typography, muted, spacing, indent } from "../../styles/theme";
import { ConfirmModal } from "../ConfirmModal";
import { CopyFloorDialog } from "../dialogs/CopyFloorDialog";
import { FieldPrintSizingDialog } from "../dialogs/FieldPrintSizingDialog";
import { Switch } from "../Switch";
import { Stack, Inline } from "../Layout";
import { InfoIconButton } from "../InfoIconButton";
import { Modal } from "../Modal";
import { isPredefinedFieldConfig } from "../../pixi/fieldPrintSizing";
import { DEFAULT_MAZE_RENDER_STYLE } from "../../pixi/defaultMazeRenderStyle";
import { canvas } from "../../pixi/colorTokens";
import { TILE_SIZE } from "../../pixi/constants";
import { configAllCells } from "../../pixi/tessellationCells";
import { colorToHex } from "../colorFormat";
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
        name={label}
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
  const setTessellationConfigForFloors = useMazeStore((s) => s.setTessellationConfigForFloors);
  const setFieldEditMode = useMazeStore((s) => s.setFieldEditMode);
  const setPrintFieldSizing = useMazeStore((s) => s.setPrintFieldSizing);
  const setFieldPrimitive = useMazeStore((s) => s.setFieldPrimitive);
  const fieldPoints = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPoints);
  const clearFieldPoints = useMazeStore((s) => s.clearFieldPoints);
  const fieldEditConfirmation = useMazeStore((s) => s.fieldEditConfirmation);
  const confirmFieldEdit = useMazeStore((s) => s.confirmFieldEdit);
  const cancelFieldEdit = useMazeStore((s) => s.cancelFieldEdit);
  const showFieldOrigin = useMazeStore((s) => s.showFieldOrigin);
  const setShowFieldOrigin = useMazeStore((s) => s.setShowFieldOrigin);
  const showPrimitiveFrame = useMazeStore((s) => s.showPrimitiveFrame);
  const setShowPrimitiveFrame = useMazeStore((s) => s.setShowPrimitiveFrame);
  const smoothPrimitives = useMazeStore((s) => s.smoothPrimitives);
  const setSmoothPrimitives = useMazeStore((s) => s.setSmoothPrimitives);
  const floorCount = useMazeStore((s) => s.floors.length);

  const [confirmPending, setConfirmPending] = useState<ConfirmPending>(null);
  const [copyFloorDialogOpen, setCopyFloorDialogOpen] = useState(false);
  const [printSizingDialogOpen, setPrintSizingDialogOpen] = useState(false);
  const [smoothingInfoOpen, setSmoothingInfoOpen] = useState(false);

  const isHex = tessellationKind === "hex";
  const isCustom = fieldEditMode === "custom";
  const printableConfig = !isCustom && isPredefinedFieldConfig(tessellationConfig)
    ? tessellationConfig
    : null;

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
            name="field-square-shape"
            onChange={(e) => setSquareShape(e.target.value as SquareShape)}>
            <option value="rect">{m["field.shape.rect"]()}</option>
            <option value="circle">{m["field.shape.circle"]()}</option>
            <option value="triangle">{m["field.shape.triangle"]()}</option>
          </select>
        </label>
      );
    }
    if (isHex) {
      return (
        <label style={styles.label}>
          {m["field.shape"]()}
          <select style={styles.select} value={hexShape}
            name="field-hex-shape"
            onChange={(e) => setHexShape(e.target.value as HexShape)}>
            <option value="rectangle">{m["field.shape.rectangle"]()}</option>
            <option value="circle">{m["field.shape.circle"]()}</option>
            <option value="triangle">{m["field.shape.triangle"]()}</option>
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
          name="field-triangle-shape"
          onChange={(e) => setTriangleShape(e.target.value as TriangleShape)}>
          <option value="rect">{m["field.shape.rect"]()}</option>
          <option value="triangle">{m["field.shape.triangle"]()}</option>
          <option value="circle">{m["field.shape.circle"]()}</option>
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
    if (tessellationConfig.type === "square_circle") {
      return <SizeParam label={m["field.radius"]()} value={tessellationConfig.radius} min={1} max={100} onCommit={(v) => setField("radius", v)} />;
    }
    if (tessellationConfig.type === "square_triangle") {
      return <SizeParam label={m["field.side"]()} value={tessellationConfig.side} min={1} max={100} onCommit={(v) => setField("side", v)} />;
    }
    if (tessellationConfig.type === "hex_rectangle" || tessellationConfig.type === "hex_parallelogram") {
      return (
        <>
          <SizeParam label={m["field.cols"]()} value={tessellationConfig.cols} min={1} max={200} onCommit={(v) => setField("cols", v)} />
          <SizeParam label={m["field.rows"]()} value={tessellationConfig.rows} min={1} max={200} onCommit={(v) => setField("rows", v)} />
        </>
      );
    }
    if (tessellationConfig.type === "hex_triangle") {
      return <SizeParam label={m["field.side"]()} value={tessellationConfig.side} min={1} max={100} onCommit={(v) => setField("side", v)} />;
    }
    if (tessellationConfig.type === "hex_circle" || tessellationConfig.type === "hex_hexagon") {
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
    if (tessellationConfig.type === "triangle_circle" || tessellationConfig.type === "triangle_hexagon") {
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
          <Button
            variant="secondary"
            layoutStyle={{ width: "100%", marginTop: spacing.itemGap }}
            onClick={() => setPrintSizingDialogOpen(true)}
          >
            {m["field.print_sizing.open"]()}
          </Button>
        </>
      )}
      {isCustom && (
        <>
          <div style={styles.sectionLabel}>{m["field.tools"]()}</div>
          <Inline gap="itemGap" style={{ ...styles.nestedContent, flexWrap: "wrap" }}>
          {primitivesForKind(tessellationKind).map(([p, label]) => (
            <ToolIconButton
              key={p}
              selected={fieldPrimitive === p}
              title={label}
              onClick={() => setFieldPrimitive(p as FieldPrimitive)}
            >
              {primitiveIcon(p as FieldPrimitive)}
            </ToolIconButton>
          ))}
          </Inline>
          <div style={styles.originRow}>
            <span style={styles.originLabel}>{m["field.show_origin"]()}</span>
            <Switch checked={showFieldOrigin} onChange={setShowFieldOrigin} />
          </div>
          <div style={styles.originRow}>
            <span style={styles.originLabel}>{m["field.show_primitive_frame"]()}</span>
            <Switch checked={showPrimitiveFrame} onChange={setShowPrimitiveFrame} />
          </div>
          <div style={styles.originRow}>
            <span style={styles.smoothingLabelGroup}>
              <span style={styles.originLabel}>{m["field.smooth_primitives"]()}</span>
              <InfoIconButton onClick={() => setSmoothingInfoOpen(true)} />
            </span>
            <Switch checked={smoothPrimitives} onChange={setSmoothPrimitives} />
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
          variant="secondary"
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
      {fieldEditConfirmation !== null && (
        <ConfirmModal
          message={m["field.reset_generation_warning"]()}
          onConfirm={confirmFieldEdit}
          onCancel={cancelFieldEdit}
        />
      )}
      {copyFloorDialogOpen && (
        <CopyFloorDialog onClose={() => setCopyFloorDialogOpen(false)} />
      )}
      {printSizingDialogOpen && printableConfig && (
        <FieldPrintSizingDialog
          config={printableConfig}
          hasMultipleFloors={floorCount > 1}
          onApply={(config, printSizing, applyToAllStandardFloors) => {
            setTessellationConfigForFloors(config, applyToAllStandardFloors);
            setPrintFieldSizing(printSizing, config);
          }}
          onClose={() => setPrintSizingDialogOpen(false)}
        />
      )}
      {smoothingInfoOpen && (
        <Modal
          title={m["field.smoothing_info_title"]()}
          onClose={() => setSmoothingInfoOpen(false)}
        >
          <div style={styles.infoText}>{m["field.smoothing_info_description"]()}</div>
          <div style={styles.infoText}>{m["field.smoothing_info_always"]()}</div>
        </Modal>
      )}
    </Stack>
  );
}

function primitivesForKind(_kind: TessellationKind): [string, string][] {
  const primitives: [string, string][] = [
    ["point", m["field.shape.point"]()],
    ["rectangle", m["field.shape.rectangle"]()],
    ["circle", m["field.shape.circle"]()],
    ["triangle", m["field.shape.right_triangle"]()],
    ["equilateral_triangle", m["field.shape.equilateral_triangle"]()],
    ["hexagon", m["field.shape.hexagon"]()],
    ["parallelogram", m["field.shape.parallelogram"]()],
  ];
  return _kind === "square" ? primitives.filter(([primitive]) => primitive !== "parallelogram") : primitives;
}

function primitiveIcon(primitive: FieldPrimitive): React.ReactNode {
  const iconSize = TILE_SIZE * 0.8;
  const wallStyle = DEFAULT_MAZE_RENDER_STYLE.wall;
  const wallColor = colorToHex(canvas.wall.default);
  const iconProps = {
    size: iconSize,
    color: wallColor,
    strokeWidth: wallStyle.width * 24 / iconSize,
    strokeLinecap: wallStyle.cap,
    strokeLinejoin: wallStyle.join,
  } as const;
  switch (primitive) {
    case "point":
      return (
        <svg width={iconSize} height={iconSize} viewBox={`0 0 ${iconSize} ${iconSize}`} aria-hidden="true">
          <circle cx={iconSize / 2} cy={iconSize / 2} r={iconSize * 0.18} fill={wallColor} />
        </svg>
      );
    case "rectangle": return <Square {...iconProps} />;
    case "circle": return <Circle {...iconProps} />;
    case "triangle":
      return (
        <svg width={iconSize} height={iconSize} viewBox={`0 0 ${iconSize} ${iconSize}`} fill="none" aria-hidden="true">
          <path
            d={`M${iconSize * 0.2} ${iconSize * 0.8}V${iconSize * 0.2}L${iconSize * 0.8} ${iconSize * 0.8}Z`}
            stroke={wallColor}
            strokeWidth={wallStyle.width}
            strokeLinecap={wallStyle.cap}
            strokeLinejoin={wallStyle.join}
          />
        </svg>
      );
    case "equilateral_triangle": return <Triangle {...iconProps} />;
    case "hexagon": return <Hexagon {...iconProps} />;
    case "parallelogram":
      return (
        <svg width={iconSize} height={iconSize} viewBox={`0 0 ${iconSize} ${iconSize}`} fill="none" aria-hidden="true">
          <path
            d={`M${iconSize * 0.28} ${iconSize * 0.14}h${iconSize * 0.56}l-${iconSize * 0.12} ${iconSize * 0.72}H${iconSize * 0.16}z`}
            stroke={wallColor}
            strokeWidth={wallStyle.width}
            strokeLinecap={wallStyle.cap}
            strokeLinejoin={wallStyle.join}
          />
        </svg>
      );
  }
}

function shapeLabel(kind: TessellationKind, squareShape: SquareShape, hexShape: HexShape, triangleShape: TriangleShape): string {
  if (kind === "square") {
    if (squareShape === "rect") return m["field.shape.rect"]();
    if (squareShape === "circle") return m["field.shape.circle"]();
    if (squareShape === "triangle") return m["field.shape.triangle"]();
    return "Free";
  }
  if (kind === "hex") {
    if (hexShape === "rectangle") return m["field.shape.rectangle"]();
    if (hexShape === "circle") return m["field.shape.circle"]();
    if (hexShape === "triangle") return m["field.shape.triangle"]();
    if (hexShape === "parallelogram") return m["field.shape.parallelogram"]();
    if (hexShape === "hexagon") return m["field.shape.hexagon"]();
    return "Free";
  }
  if (triangleShape === "rect") return m["field.shape.rect"]();
  if (triangleShape === "triangle") return m["field.shape.triangle"]();
  if (triangleShape === "circle") return m["field.shape.circle"]();
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
  if (cfg.type === "square_circle" || cfg.type === "square_triangle" || cfg.type === "hex_rectangle" || cfg.type === "hex_circle" || cfg.type === "hex_triangle") return configAllCells(cfg).length;
  if (cfg.type === "hex_parallelogram") return cfg.cols * cfg.rows;
  if (cfg.type === "triangle_rect") return 2 * cfg.cols * cfg.rows;
  if (cfg.type === "hex_hexagon") { const r = cfg.radius; return 3 * r * r + 3 * r + 1; }
  if (cfg.type === "triangle_triangle") { const n = cfg.side; return n * n; }
  if (cfg.type === "triangle_circle" || cfg.type === "triangle_hexagon") {
    return configAllCells(cfg).length;
  }
  return 0;
}


function configSizeLabel(cfg: TessellationConfig): string {
  if (cfg.type === "square") return `${cfg.width}×${cfg.height}`;
  if (cfg.type === "square_circle") return `${m["field.radius"]()} ${cfg.radius}`;
  if (cfg.type === "hex_rectangle" || cfg.type === "hex_parallelogram" || cfg.type === "triangle_rect") return `${cfg.cols}×${cfg.rows}`;
  if (cfg.type === "hex_circle" || cfg.type === "hex_hexagon" || cfg.type === "triangle_circle" || cfg.type === "triangle_hexagon") return `${m["field.radius"]()} ${cfg.radius}`;
  if (cfg.type === "square_triangle" || cfg.type === "hex_triangle" || cfg.type === "triangle_triangle") return `${m["field.side"]()} ${cfg.side}`;
  return "";
}

const styles: Record<string, React.CSSProperties> = {
  label: sharedStyles.fieldLabel,
  select: sharedStyles.select,
  input: sharedStyles.input,
  sectionLabel: { ...typography.body, marginTop: spacing.groupGap },
  // One indent level for the "Tools" section's own content, relative to `sectionLabel`.
  nestedContent: { paddingLeft: indent.tree, minWidth: 0, boxSizing: "border-box", width: "100%" },
  originRow: { display: "flex", alignItems: "center", justifyContent: "space-between", ...muted(typography.body) },
  originLabel: { ...muted(typography.body) },
  smoothingLabelGroup: { display: "flex", alignItems: "center", gap: spacing.rowGap, minWidth: 0 },
  infoText: { ...typography.body, ...muted(typography.body) },
};
