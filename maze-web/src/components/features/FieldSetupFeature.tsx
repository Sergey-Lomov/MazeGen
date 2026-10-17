import React, { useState, useEffect } from "react";
import { Circle, FlipHorizontal, Hexagon, Minus, Plus, Square, Triangle } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { SquareShape, HexShape, TriangleShape, CairoShape, TessellationKind, FieldPrimitive, FieldOperation } from "../../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
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
import { colorToHex } from "../colorFormat";
import { useFieldHint } from "../FieldHint";
import { inputHintReason, type NormalizerResult } from "../inputNormalization";
import { canActivateFieldPrimitive, fieldPrimitiveShortcut } from "../../pixi/fieldPrimitiveShortcuts";
import * as m from "~/paraglide/messages";

interface SizeParamProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  disabled?: boolean;
}

function SizeParam({ label, value, min, max, onCommit, disabled = false }: SizeParamProps) {
  const hint = useFieldHint();
  const [local, setLocal] = useState(String(value));

  useEffect(() => { setLocal(String(value)); }, [value]);

  function commit() {
    const n = Number(local);
    const valid = local.trim() !== "" && Number.isFinite(n);
    const result: NormalizerResult<number> = valid && n >= min && n <= max
      ? { raw: local, value: n, reason: null }
      : {
          raw: local,
          value,
          reason: valid
            ? { kind: "range_reverted", min: String(min), max: String(max), value: String(value) }
            : { kind: "restored", value: String(value) },
        };
    if (result.reason) {
      setLocal(String(result.value));
      hint.show(inputHintReason(result.reason));
    } else {
      onCommit(result.value);
    }
  }

  return (
    <label ref={hint.labelRef as React.Ref<HTMLLabelElement>} style={styles.label}>
      {label}
      <input
        ref={hint.anchorRef as React.Ref<HTMLInputElement>}
        style={{ ...styles.input, ...hint.fieldStyle }}
        type="number"
        name={label}
        min={min}
        max={max}
        value={local}
        disabled={disabled}
        aria-describedby={hint.describedBy}
        onChange={(e) => {
          const raw = e.target.value;
          setLocal(raw);
          const n = Number(raw);
          if (raw.trim() !== "" && Number.isFinite(n) && n >= min && n <= max) hint.dismiss();
        }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); } }}
      />
      {hint.hint}
    </label>
  );
}

type ConfirmPending = "switchToDefault" | "clearField" | null;

const OPERATION_SHORTCUTS: Record<FieldOperation, readonly string[]> = {
  add: ["+"],
  remove: ["−"],
  select: ["0"],
};

export function FieldSetupFeature() {
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const squareShape = useMazeStore((s) => s.floorFields[s.activeFloorId].squareShape);
  const hexShape = useMazeStore((s) => s.floorFields[s.activeFloorId].hexShape);
  const triangleShape = useMazeStore((s) => s.floorFields[s.activeFloorId].triangleShape);
  const cairoShape = useMazeStore((s) => s.floorFields[s.activeFloorId].cairoShape);
  const tessellationConfig = useMazeStore((s) => s.floorFields[s.activeFloorId].tessellationConfig);
  const fieldEditMode = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldEditMode);
  const fieldPrimitive = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPrimitive);
  const fieldOperation = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldOperation);
  const setSquareShape = useMazeStore((s) => s.setSquareShape);
  const setHexShape = useMazeStore((s) => s.setHexShape);
  const setTriangleShape = useMazeStore((s) => s.setTriangleShape);
  const setCairoShape = useMazeStore((s) => s.setCairoShape);
  const setTessellationConfig = useMazeStore((s) => s.setTessellationConfig);
  const setTessellationConfigsForFloors = useMazeStore((s) => s.setTessellationConfigsForFloors);
  const setFieldEditMode = useMazeStore((s) => s.setFieldEditMode);
  const setPrintFieldSizing = useMazeStore((s) => s.setPrintFieldSizing);
  const setFieldPrimitive = useMazeStore((s) => s.setFieldPrimitive);
  const setFieldOperation = useMazeStore((s) => s.setFieldOperation);
  const fieldPoints = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPoints);
  const clearFieldPoints = useMazeStore((s) => s.clearFieldPoints);
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
            disabled={fieldEditLocked}
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
            disabled={fieldEditLocked}
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
    if (tessellationKind === "cairo") {
      return (
        <label style={styles.label}>
          {m["field.shape"]()}
          <select style={styles.select} value={cairoShape}
            name="field-cairo-shape"
            disabled={fieldEditLocked}
            onChange={(e) => setCairoShape(e.target.value as CairoShape)}>
            <option value="rect">{m["field.shape.rect"]()}</option>
            <option value="circle">{m["field.shape.circle"]()}</option>
            <option value="triangle">{m["field.shape.triangle"]()}</option>
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
          disabled={fieldEditLocked}
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
          <SizeParam label={m["field.width"]()} value={tessellationConfig.width} min={1} max={200} disabled={fieldEditLocked} onCommit={(v) => setField("width", v)} />
          <SizeParam label={m["field.height"]()} value={tessellationConfig.height} min={1} max={200} disabled={fieldEditLocked} onCommit={(v) => setField("height", v)} />
        </>
      );
    }
    if (tessellationConfig.type === "square_circle") {
      return <SizeParam label={m["field.radius"]()} value={tessellationConfig.radius} min={1} max={100} disabled={fieldEditLocked} onCommit={(v) => setField("radius", v)} />;
    }
    if (tessellationConfig.type === "square_triangle") {
      return <SizeParam label={m["field.side"]()} value={tessellationConfig.side} min={1} max={100} disabled={fieldEditLocked} onCommit={(v) => setField("side", v)} />;
    }
    if (tessellationConfig.type === "hex_rectangle" || tessellationConfig.type === "hex_parallelogram") {
      return (
        <>
          <SizeParam label={m["field.cols"]()} value={tessellationConfig.cols} min={1} max={200} disabled={fieldEditLocked} onCommit={(v) => setField("cols", v)} />
          <SizeParam label={m["field.rows"]()} value={tessellationConfig.rows} min={1} max={200} disabled={fieldEditLocked} onCommit={(v) => setField("rows", v)} />
        </>
      );
    }
    if (tessellationConfig.type === "hex_triangle") {
      return <SizeParam label={m["field.side"]()} value={tessellationConfig.side} min={1} max={100} disabled={fieldEditLocked} onCommit={(v) => setField("side", v)} />;
    }
    if (tessellationConfig.type === "hex_circle" || tessellationConfig.type === "hex_hexagon") {
      return <SizeParam label={m["field.radius"]()} value={tessellationConfig.radius} min={1} max={50} disabled={fieldEditLocked} onCommit={(v) => setField("radius", v)} />;
    }
    if (tessellationConfig.type === "triangle_rect") {
      return (
        <>
          <SizeParam label={m["field.cols"]()} value={tessellationConfig.cols} min={1} max={200} disabled={fieldEditLocked} onCommit={(v) => setField("cols", v)} />
          <SizeParam label={m["field.rows"]()} value={tessellationConfig.rows} min={1} max={200} disabled={fieldEditLocked} onCommit={(v) => setField("rows", v)} />
        </>
      );
    }
    if (tessellationConfig.type === "triangle_triangle") {
      return <SizeParam label={m["field.side"]()} value={tessellationConfig.side} min={1} max={30} disabled={fieldEditLocked} onCommit={(v) => setField("side", v)} />;
    }
    if (tessellationConfig.type === "triangle_circle" || tessellationConfig.type === "triangle_hexagon") {
      return <SizeParam label={m["field.radius"]()} value={tessellationConfig.radius} min={1} max={15} disabled={fieldEditLocked} onCommit={(v) => setField("radius", v)} />;
    }
    if (tessellationConfig.type === "cairo") {
      return (
        <>
          <SizeParam label={m["field.cols"]()} value={tessellationConfig.cols} min={1} max={200} disabled={fieldEditLocked} onCommit={(v) => setField("cols", v)} />
          <SizeParam label={m["field.rows"]()} value={tessellationConfig.rows} min={1} max={200} disabled={fieldEditLocked} onCommit={(v) => setField("rows", v)} />
        </>
      );
    }
    if (tessellationConfig.type === "cairo_circle" || tessellationConfig.type === "cairo_hexagon") {
      return <SizeParam label={m["field.radius"]()} value={tessellationConfig.radius} min={1} max={50} disabled={fieldEditLocked} onCommit={(v) => setField("radius", v)} />;
    }
    if (tessellationConfig.type === "cairo_triangle") {
      return <SizeParam label={m["field.side"]()} value={tessellationConfig.side} min={1} max={50} disabled={fieldEditLocked} onCommit={(v) => setField("side", v)} />;
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
          {primitivesForKind().map((tool) => {
            const shortcut = fieldPrimitiveShortcut(tool.primitive);
            return <ToolIconButton
              key={tool.key}
              selected={fieldPrimitive === tool.primitive}
              disabled={!canActivateFieldPrimitive(tool.primitive, fieldOperation, fieldEditLocked)}
              title={tool.label}
              shortcut={shortcut ? [shortcut] : undefined}
              description={tool.primitive === "symmetry" && fieldOperation === "select"
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
        <Button
          variant="secondary"
          disabled={fieldEditLocked}
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
          onApply={(config, printSizing, applyToAllStandardFloors, configsByFloor) => {
            setTessellationConfigsForFloors(configsByFloor, applyToAllStandardFloors);
            setPrintFieldSizing(printSizing, config);
          }}
          onClose={() => setPrintSizingDialogOpen(false)}
        />
      )}
      {paperLayoutDialogOpen && (
        <PaperLayoutDialog
          config={tessellationConfig}
          onApply={(input) => {
            setPrintFieldSizing(input, { type: tessellationConfig.type });
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

function primitivesForKind(): PrimitiveToolOption[] {
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

function shapeLabel(kind: TessellationKind, squareShape: SquareShape, hexShape: HexShape, triangleShape: TriangleShape, cairoShape: CairoShape): string {
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
  if (kind === "cairo") return cairoShape === "rect" ? m["field.shape.rect"]() : m["field.custom"]();
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
  cairoShape: CairoShape;
  tessellationConfig: TessellationConfig;
}

function floorCellCount(field: FloorFieldSummary): number {
  return field.fieldEditMode === "custom" ? field.fieldPoints.size : configCellCount(field.tessellationConfig);
}

function floorShapeLabel(kind: TessellationKind, field: FloorFieldSummary): string {
  if (field.fieldEditMode === "custom") return m["field.custom"]();
  const shape = shapeLabel(kind, field.squareShape, field.hexShape, field.triangleShape, field.cairoShape);
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
  if (cfg.type === "cairo") return configAllCells(cfg).length;
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
  if (cfg.type === "cairo") return `${cfg.cols}\u00D7${cfg.rows}`;
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
