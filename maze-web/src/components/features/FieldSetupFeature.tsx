import React, { useState } from "react";
import { TESSELLATION_UI } from "../../pixi/geometry/tessellationUi";
import { Circle, FlipHorizontal, Hexagon, Minus, Plus, Square, Triangle } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { TessellationKind, FieldPrimitive, FieldOperation } from "../../store/mazeStore";
import type { FieldConfig, FieldShape, PresetFieldShapeName } from "../../fieldConfig";
import { sharedStyles } from "../../styles/shared";
import { Button } from "../Button";
import { ToolIconButton } from "../ToolIconButton";
import { typography, muted, spacing, indent } from "../../styles/theme";
import { ConfirmModal } from "../ConfirmModal";
import { CopyFloorDialog } from "../dialogs/CopyFloorDialog";
import { FieldPrintSizingDialog } from "../dialogs/FieldPrintSizingDialog";
import { PaperLayoutDialog } from "../dialogs/PaperLayoutDialog";
import { Switch } from "../Switch";
import { Stack, Inline } from "../Layout";
import { InfoIconButton } from "../InfoIconButton";
import { ToggleRow } from "../ToggleRow";
import { BackgroundImageToggle } from "../BackgroundImageToggle";
import { SettingsIconButton } from "../SettingsIconButton";
import { Modal } from "../Modal";
import { isPredefinedFieldConfig } from "../../pixi/fieldPrintSizing";
import { DEFAULT_MAZE_RENDER_STYLE } from "../../pixi/defaultMazeRenderStyle";
import { canvas } from "../../pixi/colorTokens";
import { TILE_SIZE } from "../../pixi/constants";
import { configAllCells } from "../../pixi/tessellationCells";
import { availablePresetKeys, fieldOperationAvailable, presetParams } from "../../pixi/fieldOps";
import { colorToHex } from "../colorFormat";
import { SizeParam } from "./SizeParam";
import { canActivateFieldPrimitive, fieldPrimitiveShortcut } from "../../pixi/fieldPrimitiveShortcuts";
import * as m from "~/paraglide/messages";

type ConfirmPending = "switchToDefault" | "clearField" | "copyAll" | null;

const OPERATION_SHORTCUTS: Record<FieldOperation, readonly string[]> = {
  add: ["+"],
  remove: ["−"],
  select: ["0"],
};

export function FieldSetupFeature() {
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const selectedShape = useMazeStore((s) => s.floorFields[s.activeFloorId].selectedShape);
  const fieldConfig = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldConfig);
  const reflectAvailable = fieldOperationAvailable(fieldConfig.tessellation, "reflect");
  const fieldEditMode = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldEditMode);
  const fieldPrimitive = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPrimitive);
  const fieldOperation = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldOperation);
  const setSelectedShape = useMazeStore((s) => s.setSelectedShape);
  const setFieldConfig = useMazeStore((s) => s.setFieldConfig);
  const setFieldConfigsForFloors = useMazeStore((s) => s.setFieldConfigsForFloors);
  const setFieldEditMode = useMazeStore((s) => s.setFieldEditMode);
  const setPrintFieldSizing = useMazeStore((s) => s.setPrintFieldSizing);
  const setFieldPrimitive = useMazeStore((s) => s.setFieldPrimitive);
  const setFieldOperation = useMazeStore((s) => s.setFieldOperation);
  const fieldPoints = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPoints);
  const clearFieldPoints = useMazeStore((s) => s.clearFieldPoints);
  const copyCurrentFloorFieldToAll = useMazeStore((s) => s.copyCurrentFloorFieldToAll);
  const fieldEditConfirmation = useMazeStore((s) => s.fieldEditConfirmation);
  const confirmFieldEdit = useMazeStore((s) => s.confirmFieldEdit);
  const cancelFieldEdit = useMazeStore((s) => s.cancelFieldEdit);
  const showFieldOrigin = useMazeStore((s) => s.showFieldOrigin);
  const setShowFieldOrigin = useMazeStore((s) => s.setShowFieldOrigin);
  const showPrimitiveFrame = useMazeStore((s) => s.showPrimitiveFrame);
  const setShowPrimitiveFrame = useMazeStore((s) => s.setShowPrimitiveFrame);
  const showPaperLayout = useMazeStore((s) => s.showPaperLayout);
  const setShowPaperLayout = useMazeStore((s) => s.setShowPaperLayout);
  const smoothPrimitives = useMazeStore((s) => s.smoothPrimitives);
  const setSmoothPrimitives = useMazeStore((s) => s.setSmoothPrimitives);
  const floorCount = useMazeStore((s) => s.floors.length);
  const fieldEditLocked = useMazeStore((s) => s.backgroundAutoFillPreview !== null);

  const [confirmPending, setConfirmPending] = useState<ConfirmPending>(null);
  const [copyFloorDialogOpen, setCopyFloorDialogOpen] = useState(false);
  const [printSizingDialogOpen, setPrintSizingDialogOpen] = useState(false);
  const [smoothingInfoOpen, setSmoothingInfoOpen] = useState(false);
  const [paperLayoutDialogOpen, setPaperLayoutDialogOpen] = useState(false);

  const isCustom = fieldEditMode === "custom";
  const printableConfig = !isCustom && isPredefinedFieldConfig(fieldConfig)
    ? fieldConfig
    : null;

  function setField(field: string, value: number) {
    setFieldConfig({ ...fieldConfig, shape: { ...fieldConfig.shape, [field]: value } as FieldShape });
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
    if (confirmPending === "copyAll") copyCurrentFloorFieldToAll();
    setConfirmPending(null);
  }

  function renderShapeSelect() {
    return (
      <label style={styles.label}>
        {m["field.shape"]()}
        <select style={styles.select} value={selectedShape}
          name="field-shape"
          disabled={fieldEditLocked}
          onChange={(e) => setSelectedShape(e.target.value as PresetFieldShapeName)}>
          {availablePresetKeys(fieldConfig.tessellation).map((key) => (
            <option key={key} value={key}>{shapeLabel(tessellationKind, key as PresetFieldShapeName)}</option>
          ))}
        </select>
      </label>
    );
  }

  function renderParams() {
    const { shape } = fieldConfig;
    if (shape.shape === "custom") return null;
    const values = shape as unknown as Record<string, number>;
    return presetParams(fieldConfig.tessellation, shape.shape).map(({ name, min, max }) => (
      <SizeParam
        key={name}
        label={paramLabel(tessellationKind, shape.shape, name)}
        value={values[name]}
        min={min}
        max={max ?? paramMax(tessellationKind, shape.shape, name)}
        disabled={fieldEditLocked}
        onCommit={(v) => setField(name, v)}
      />
    ));
  }

  const confirmMessages: Record<NonNullable<ConfirmPending>, string> = {
    switchToDefault: m["field.confirm_switch_to_default"](),
    clearField: m["field.confirm_clear"](),
    copyAll: m["floors.confirm_from_current"](),
  };

  return (
    <Stack gap="groupGap">
      <Inline gap="itemGap">
        <Button
          variant={isCustom ? "toggle" : "toggle-selected"}
          disabled={fieldEditLocked}
          onClick={handleSwitchToDefault}
        >
          {m["field.default"]()}
        </Button>
        <Button
          variant={isCustom ? "toggle-selected" : "toggle"}
          disabled={fieldEditLocked}
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
            disabled={fieldEditLocked}
            layoutStyle={{ width: "100%", marginTop: spacing.itemGap }}
            onClick={() => setPrintSizingDialogOpen(true)}
          >
            {m["field.print_sizing.open"]()}
          </Button>
        </>
      )}
      {isCustom && (
        <>
          <div style={styles.sectionLabel}>{m["field.modes"]()}</div>
          <Inline gap="itemGap" style={styles.nestedContent}>
            {(["add", "remove", "select"] as FieldOperation[]).map((operation) => (
              <ToolIconButton
                key={operation}
                selected={fieldOperation === operation}
                disabled={fieldEditLocked}
                title={m[`field.mode.${operation}` as "field.mode.add" | "field.mode.remove" | "field.mode.select"]()}
                shortcut={OPERATION_SHORTCUTS[operation]}
                onClick={() => setFieldOperation(operation)}
              >
                {operationIcon(operation)}
              </ToolIconButton>
            ))}
          </Inline>
          <div style={styles.sectionLabel}>{m["field.tools"]()}</div>
          <Inline gap="itemGap" style={{ ...styles.nestedContent, flexWrap: "wrap" }}>
          {primitivesForField().map((tool) => {
            const shortcut = fieldPrimitiveShortcut(tool.primitive);
            return <ToolIconButton
              key={tool.key}
              selected={fieldPrimitive === tool.primitive}
              disabled={!canActivateFieldPrimitive(tool.primitive, fieldOperation, fieldEditLocked, reflectAvailable)}
              title={tool.label}
              shortcut={shortcut ? [shortcut] : undefined}
              description={tool.primitive === "symmetry" && !reflectAvailable
                ? m["field.symmetry.tessellation_disabled"]()
                : tool.primitive === "symmetry" && fieldOperation === "select"
                ? m["field.symmetry.select_disabled"]()
                : tool.primitive === "polygon"
                ? m["field.polygon.shift_tooltip"]()
                : tool.primitive === "magic_wand" ? m["field.connected_area.tooltip"]() : undefined}
              descriptionShortcut={tool.primitive === "polygon" ? ["shift"] : undefined}
              onClick={() => {
                setFieldPrimitive(tool.primitive);
              }}
            >
              {primitiveIcon(tool.primitive)}
            </ToolIconButton>;
          })}
          </Inline>
          <div style={styles.originRow}>
            <span style={styles.originLabel}>{m["field.show_primitive_frame"]()}</span>
            <Switch checked={showPrimitiveFrame} onChange={setShowPrimitiveFrame} disabled={fieldEditLocked} />
          </div>
          <div style={styles.originRow}>
            <span style={styles.smoothingLabelGroup}>
              <span style={styles.originLabel}>{m["field.smooth_primitives"]()}</span>
              <InfoIconButton onClick={() => setSmoothingInfoOpen(true)} />
            </span>
            <Switch checked={smoothPrimitives} onChange={setSmoothPrimitives} disabled={fieldEditLocked} />
          </div>
          <div style={styles.originRow}>
            <ToggleRow
              label={m["field.paper_layout.title"]()}
              checked={showPaperLayout}
              onChange={setShowPaperLayout}
              layoutStyle={{ flex: 1 }}
              action={<SettingsIconButton
                title={m["field.paper_layout.configure"]()}
                onClick={() => setPaperLayoutDialogOpen(true)}
              />}
            />
          </div>
          <BackgroundImageToggle />
          <div style={styles.originRow}>
            <span style={styles.originLabel}>{m["field.show_origin"]()}</span>
            <Switch checked={showFieldOrigin} onChange={setShowFieldOrigin} />
          </div>
          <Button
            variant="destructive"
            disabled={fieldEditLocked}
            layoutStyle={{ width: "100%", marginTop: spacing.itemGap }}
            onClick={handleClearField}
          >
            {m["field.clear"]()}
          </Button>
        </>
      )}
      {floorCount > 1 && (
        <>
          <Button
            variant="secondary"
            disabled={fieldEditLocked}
            layoutStyle={{ width: "100%", marginTop: spacing.itemGap }}
            onClick={() => setCopyFloorDialogOpen(true)}
          >
            {m["field.copy_floor"]()}
          </Button>
          <Button
            variant="secondary"
            disabled={fieldEditLocked}
            layoutStyle={{ width: "100%", marginTop: spacing.itemGap }}
            onClick={() => setConfirmPending("copyAll")}
          >
            {m["floors.from_current"]()}
          </Button>
        </>
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
          onApply={(config, printSizing, applyToAllStandardFloors, configsByFloor) => {
            setFieldConfigsForFloors(configsByFloor, applyToAllStandardFloors);
            setPrintFieldSizing(printSizing, config);
          }}
          onClose={() => setPrintSizingDialogOpen(false)}
        />
      )}
      {paperLayoutDialogOpen && (
        <PaperLayoutDialog
          config={fieldConfig}
          onApply={(input) => {
            setPrintFieldSizing(input, { tessellation: fieldConfig.tessellation });
            setShowPaperLayout(true);
          }}
          onClose={() => setPaperLayoutDialogOpen(false)}
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

interface PrimitiveToolOption {
  key: string;
  primitive: FieldPrimitive;
  label: string;
}

function primitivesForField(): PrimitiveToolOption[] {
  const primitives: PrimitiveToolOption[] = [
    { key: "point", primitive: "point", label: m["field.shape.point"]() },
    { key: "rectangle", primitive: "rectangle", label: m["field.shape.rectangle"]() },
    { key: "circle", primitive: "circle", label: m["field.shape.circle"]() },
    { key: "triangle", primitive: "triangle", label: m["field.shape.right_triangle"]() },
    { key: "equilateral_triangle", primitive: "equilateral_triangle", label: m["field.shape.equilateral_triangle"]() },
    { key: "hexagon", primitive: "hexagon", label: m["field.shape.hexagon"]() },
    { key: "parallelogram", primitive: "parallelogram", label: m["field.shape.parallelogram"]() },
    { key: "polygon", primitive: "polygon", label: m["field.polygon.tool"]() },
    { key: "magic_wand", primitive: "magic_wand", label: m["field.connected_area.tool"]() },
    { key: "symmetry", primitive: "symmetry", label: m["field.symmetry.tool"]() },
  ];
  return primitives;
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
    case "symmetry": return <FlipHorizontal {...iconProps} />;
    case "magic_wand": {
      const cellSize = 5;
      const cellGap = 1;
      const shapeWidth = 3 * cellSize + 2 * cellGap;
      const shapeHeight = 2 * cellSize + cellGap;
      const gridOriginX = (24 - shapeWidth) / 2;
      const gridOriginY = (24 - shapeHeight) / 2;
      const cellRadius = cellSize * 0.2;
      const filledCells = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 2]];
      return (
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <g fill={wallColor}>
            {filledCells.map(([row, col]) => (
              <rect
                key={row + "-" + col}
                x={gridOriginX + col * (cellSize + cellGap)}
                y={gridOriginY + row * (cellSize + cellGap)}
                width={cellSize}
                height={cellSize}
                rx={cellRadius}
                ry={cellRadius}
              />
            ))}
          </g>
        </svg>
      );
    }
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
    case "polygon":
      return (
        <svg width={iconSize} height={iconSize} viewBox={`0 0 ${iconSize} ${iconSize}`} fill="none" aria-hidden="true">
          <path
            d={`M${iconSize * 0.18} ${iconSize * 0.72}L${iconSize * 0.3} ${iconSize * 0.2}L${iconSize * 0.78} ${iconSize * 0.14}L${iconSize * 0.86} ${iconSize * 0.68}L${iconSize * 0.52} ${iconSize * 0.86}Z`}
            stroke={wallColor}
            strokeWidth={wallStyle.width}
            strokeLinecap={wallStyle.cap}
            strokeLinejoin={wallStyle.join}
          />
        </svg>
      );
  }
}

function operationIcon(operation: FieldOperation): React.ReactNode {
  const color = operation === "add"
    ? colorToHex(canvas.fieldEditor.previewAdd)
    : operation === "remove"
      ? colorToHex(canvas.fieldEditor.previewRemove)
      : colorToHex(canvas.fieldEditor.previewSelect);
  if (operation === "select") {
    const size = TILE_SIZE * 0.8;
    // Use the same 24x24 coordinate system as FlipHorizontal. This keeps the physical
    // stroke width identical after the SVG is scaled to the button size.
    const frameOffset = 3;
    const side = 18;
    // Keep the 1:2:1 line ratio while making both gaps exactly one quarter of a side.
    const segments = [
      [0, side / 8],
      [side * 3 / 8, side * 5 / 8],
      [side * 7 / 8, side],
    ] as const;
    const wallStyle = DEFAULT_MAZE_RENDER_STYLE.wall;
    const dashPath = [
      ...segments.map(([start, end]) => `M${frameOffset + start} ${frameOffset}h${end - start}`),
      ...segments.map(([start, end]) => `M${frameOffset + side} ${frameOffset + start}v${end - start}`),
      ...segments.map(([start, end]) => `M${frameOffset + side - end} ${frameOffset + side}h${end - start}`),
      ...segments.map(([start, end]) => `M${frameOffset} ${frameOffset + side - end}v${end - start}`),
    ].join(" ");
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d={dashPath}
          stroke={color}
          strokeWidth={wallStyle.width * 24 / size}
          strokeLinecap={wallStyle.cap}
          strokeLinejoin={wallStyle.join}
        />
      </svg>
    );
  }
  const Icon = operation === "add" ? Plus : Minus;
  return <Icon size={TILE_SIZE * 0.7} color={color} strokeWidth={2.5} />;
}

function shapeLabel(kind: TessellationKind, shape: PresetFieldShapeName): string {
  switch (shape) {
    case "rect": return TESSELLATION_UI[kind].editor.rectLabelRectangle ? m["field.shape.rectangle"]() : m["field.shape.rect"]();
    case "circle": return m["field.shape.circle"]();
    case "triangle": return m["field.shape.triangle"]();
    case "parallelogram": return m["field.shape.parallelogram"]();
    case "hexagon": return m["field.shape.hexagon"]();
  }
}

function paramLabel(kind: TessellationKind, shape: PresetFieldShapeName, name: string): string {
  switch (name) {
    case "cols": return shape === "rect" && TESSELLATION_UI[kind].editor.axisAlignedGrid ? m["field.width"]() : m["field.cols"]();
    case "rows": return shape === "rect" && TESSELLATION_UI[kind].editor.axisAlignedGrid ? m["field.height"]() : m["field.rows"]();
    case "radius": return m["field.radius"]();
    case "side": return m["field.side"]();
    default: return name;
  }
}

/** Fallback upper bound of a size param in the editor — UI metadata, used when core publishes no `max`. */
function paramMax(kind: TessellationKind, shape: PresetFieldShapeName, name: string): number {
  if (name === "cols" || name === "rows") return 200;
  if (shape === "circle" || shape === "hexagon" || shape === "triangle") return SHAPE_PARAM_LIMITS[kind][shape];
  return 200;
}

function cellsLabel(count: number): string {
  return count === 1 ? m["field.cell"]({ count }) : m["field.cells"]({ count });
}

interface FloorFieldSummary {
  fieldEditMode: "default" | "custom";
  fieldPoints: Set<number>;
  selectedShape: PresetFieldShapeName;
  fieldConfig: FieldConfig;
}

function floorCellCount(field: FloorFieldSummary): number {
  return field.fieldEditMode === "custom" ? field.fieldPoints.size : configCellCount(field.fieldConfig);
}

function floorShapeLabel(kind: TessellationKind, field: FloorFieldSummary): string {
  if (field.fieldEditMode === "custom") return m["field.custom"]();
  const shape = shapeLabel(kind, field.selectedShape);
  const size = configSizeLabel(field.fieldConfig);
  return size ? `${shape} · ${size}` : shape;
}

export function fieldSetupSubtitle(kind: TessellationKind, floorFields: FloorFieldSummary[]): string {
  const totalCount = floorFields.reduce((sum, f) => sum + floorCellCount(f), 0);
  const countStr = totalCount > 0 ? ` · ${cellsLabel(totalCount)}` : "";

  const labels = new Set(floorFields.map((f) => floorShapeLabel(kind, f)));
  const shape = labels.size === 1 ? [...labels][0] : m["field.different_shapes"]();
  return `${shape}${countStr}`;
}

export function configCellCount(cfg: FieldConfig): number {
  const { shape } = cfg;
  const ui = TESSELLATION_UI[cfg.tessellation.kind].editor;
  switch (shape.shape) {
    case "custom": return 0;
    case "rect":
      return ui.rectCellsPerUnit === null ? configAllCells(cfg).length : ui.rectCellsPerUnit * shape.cols * shape.rows;
    case "parallelogram": return shape.cols * shape.rows;
    case "hexagon":
      return ui.hexagonCellCount === null ? configAllCells(cfg).length : ui.hexagonCellCount(shape.radius);
    case "triangle":
      return ui.triangleCellCount === null ? configAllCells(cfg).length : ui.triangleCellCount(shape.side);
    case "circle": return configAllCells(cfg).length;
  }
}

function configSizeLabel(cfg: FieldConfig): string {
  const { shape } = cfg;
  switch (shape.shape) {
    case "rect":
    case "parallelogram": return `${shape.cols}\u00D7${shape.rows}`;
    case "circle":
    case "hexagon": return `${m["field.radius"]()} ${shape.radius}`;
    case "triangle": return `${m["field.side"]()} ${shape.side}`;
    case "custom": return "";
  }
}

/** Upper bounds of the radial/side shape params per kind — UI registry metadata. */
const SHAPE_PARAM_LIMITS: Record<TessellationKind, { circle: number; hexagon: number; triangle: number }> = {
  square: { circle: 100, hexagon: 50, triangle: 100 },
  hex: { circle: 50, hexagon: 50, triangle: 100 },
  tri: { circle: 15, hexagon: 15, triangle: 30 },
  cairo: { circle: 50, hexagon: 50, triangle: 50 },
  square_octagon: { circle: 50, hexagon: 50, triangle: 50 },
  brick: { circle: 50, hexagon: 50, triangle: 50 },
  trihexagonal: { circle: 50, hexagon: 50, triangle: 50 },
  snub_hexagonal: { circle: 50, hexagon: 50, triangle: 50 },
  rhombitrihexagonal: { circle: 50, hexagon: 50, triangle: 50 },
  curved_quadrilateral: { circle: 50, hexagon: 50, triangle: 50 },
  // Radial publishes its circle radius limit through core (it depends on the tessellation params).
  radial: { circle: 50, hexagon: 50, triangle: 50 },
};

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
