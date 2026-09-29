import React, { useEffect, useMemo, useState } from "react";
import { RectangleHorizontal, RectangleVertical } from "lucide-react";
import type { FieldConfig } from "../../fieldConfig";
import { useMazeStore } from "../../store/mazeStore";
import type { FloorFieldConfig } from "../../store/storeTypes";
import type { PaperOrientation, PaperSize } from "../../store/storeTypes";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { SelectRow } from "../SelectRow";
import { Inline, Stack } from "../Layout";
import { Switch } from "../Switch";
import { buttonClass, buttonStyle, sharedStyles } from "../../styles/shared";
import { dialogSpacing, indent, inset, radius, spacing, typography, ui } from "../../styles/theme";
import { calculatePrintFieldConfig, isPredefinedFieldConfig, resolvePrintPaperSizeMm, type PredefinedFieldConfig, type PrintFieldSizingInput } from "../../pixi/fieldPrintSizing";
import { DPI_BY_DENSITY, printCellMeasureMm } from "../../pixi/imageExport/printFit";
import { configAllCells } from "../../pixi/tessellationCells";
import * as m from "~/paraglide/messages";

interface Props {
  config: PredefinedFieldConfig;
  hasMultipleFloors: boolean;
  onApply: (
    config: FieldConfig,
    input: PrintFieldSizingInput,
    applyToAllStandardFloors: boolean,
    configsByFloor: Record<string, FieldConfig>,
  ) => void;
  onClose: () => void;
}

const PAPER_SIZE_OPTIONS: { value: PaperSize; label: string; disabled?: boolean }[] = [
  { value: "a0", label: m["image_export.format.png.print.paper_a0"]() },
  { value: "a1", label: m["image_export.format.png.print.paper_a1"]() },
  { value: "a2", label: m["image_export.format.png.print.paper_a2"]() },
  { value: "a3", label: m["image_export.format.png.print.paper_a3"]() },
  { value: "a4", label: m["image_export.format.png.print.paper_a4"]() },
  { value: "a5", label: m["image_export.format.png.print.paper_a5"]() },
  { value: "letter", label: m["image_export.format.png.print.paper_letter"]() },
  { value: "legal", label: m["image_export.format.png.print.paper_legal"]() },
  { value: "tabloid", label: m["image_export.format.png.print.paper_tabloid"]() },
  { value: "custom", label: m["image_export.format.png.print.paper_custom"]() },
];

const CALCULATION_DEBOUNCE_MS = 120;
const DEFAULT_DIALOG_CELL_SIZE_MM = 10;

export function FieldPrintSizingDialog({ config, hasMultipleFloors, onApply, onClose }: Props) {
  const print = useMazeStore((s) => s.pngExportSettings.print);
  const floors = useMazeStore((s) => s.floors);
  const floorFields = useMazeStore((s) => s.floorFields);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  const initialCellSizeMm = print.scaleAutoFit
    ? DEFAULT_DIALOG_CELL_SIZE_MM
    : printCellMeasureMm(config, print.scale, DPI_BY_DENSITY[print.density]);
  const [paperSize, setPaperSize] = useState<PaperSize>(() => print.paperSize);
  const [customWidthText, setCustomWidthText] = useState(() => String(print.customWidthMm));
  const [customHeightText, setCustomHeightText] = useState(() => String(print.customHeightMm));
  const [orientation, setOrientation] = useState<PaperOrientation>(() => print.orientation);
  const [cellSizeText, setCellSizeText] = useState(() => String(round2(initialCellSizeMm)));
  const [marginHText, setMarginHText] = useState(() => String(print.marginHMm));
  const [marginVText, setMarginVText] = useState(() => String(print.marginVMm));
  const [applyToAllStandardFloors, setApplyToAllStandardFloors] = useState(() => hasMultipleFloors);
  const customWidthMm = parseNumber(customWidthText);
  const customHeightMm = parseNumber(customHeightText);
  const cellSizeMm = parseNumber(cellSizeText);
  const marginHMm = parseNumber(marginHText);
  const marginVMm = parseNumber(marginVText);
  const debouncedCellSizeMm = useDebouncedValue(cellSizeMm, CALCULATION_DEBOUNCE_MS);

  const paper = useMemo(
    () => resolvePrintPaperSizeMm({ paperSize, customWidthMm, customHeightMm, orientation }),
    [paperSize, customWidthMm, customHeightMm, orientation],
  );
  const result = useMemo(
    () => calculatePrintFieldConfig(config, {
      paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm: debouncedCellSizeMm, marginHMm, marginVMm,
    }),
    [config, paperSize, customWidthMm, customHeightMm, orientation, debouncedCellSizeMm, marginHMm, marginVMm],
  );
  const floorSummaries = useMemo(
    () => floors.map((floor, index) => ({ floor, index })).reverse().map(({ floor, index }) => ({
      id: floor.id,
      title: `${index + 1}: ${floor.title}`,
      info: floorPrintInfo(floorFields[floor.id], {
        paperSize, customWidthMm, customHeightMm, orientation,
        cellSizeMm: debouncedCellSizeMm, marginHMm, marginVMm,
      }),
    })),
    [floors, floorFields, paperSize, customWidthMm, customHeightMm, orientation, debouncedCellSizeMm, marginHMm, marginVMm],
  );
  const hasInvalidTargetFloor = hasMultipleFloors
    && applyToAllStandardFloors
    && floorSummaries.some(({ info }) => !info.isValid);
  const canConfirm = result !== null
    && Number.isFinite(cellSizeMm)
    && cellSizeMm > 0
    && !hasInvalidTargetFloor;

  function handleApply() {
    // The preview is debounced for responsive typing, but confirmation always uses the latest
    // value instead of waiting for the debounce timer.
    const latestResult = calculatePrintFieldConfig(config, {
      paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm, marginHMm, marginVMm,
    });
    if (!latestResult) return;
    const configsByFloor: Record<string, FieldConfig> = {};
    for (const floor of floors) {
      if (!applyToAllStandardFloors && floor.id !== activeFloorId) continue;
      const field = floorFields[floor.id];
      if (!field || field.fieldEditMode === "custom" || !isPredefinedFieldConfig(field.tessellationConfig)) continue;
      const floorResult = calculatePrintFieldConfig(field.tessellationConfig, {
        paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm, marginHMm, marginVMm,
      });
      if (!floorResult || !isPredefinedFieldConfig(floorResult.config)) return;
      configsByFloor[floor.id] = floorResult.config;
    }
    if (!configsByFloor[activeFloorId]) return;
    onApply(
      latestResult.config,
      { paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm, marginHMm, marginVMm },
      applyToAllStandardFloors,
      configsByFloor,
    );
    onClose();
  }

  return (
    <Modal title={m["field.print_sizing.title"]()} size={hasMultipleFloors ? "printSizing" : "info"} onClose={onClose} onConfirm={canConfirm ? handleApply : undefined}>
      <Stack gap="itemGap">
        <SelectRow<PaperSize>
          label={m["field.print_sizing.paper"]()}
          value={paperSize}
          options={PAPER_SIZE_OPTIONS}
          onChange={setPaperSize}
        />

        <Inline gap="itemGap" justify="space-between">
          <span style={styles.label}>{m["image_export.format.png.print.size_mm"]()}</span>
          <Inline gap="groupGap">
            <NumberInput label={m["image_export.format.png.print.width_short"]()} value={paperSize === "custom" ? customWidthText : String(paper.widthMm)} disabled={paperSize !== "custom"} onChange={setCustomWidthText} />
            <NumberInput label={m["image_export.format.png.print.height_short"]()} value={paperSize === "custom" ? customHeightText : String(paper.heightMm)} disabled={paperSize !== "custom"} onChange={setCustomHeightText} />
          </Inline>
        </Inline>

        <Inline gap="itemGap" justify="space-between">
          <span style={styles.label}>{m["image_export.format.png.print.orientation"]()}</span>
          <Inline gap="itemGap">
            <button
              className={buttonClass(orientation === "portrait" ? "toggle-selected" : "toggle")}
              style={{ ...buttonStyle(orientation === "portrait" ? "toggle-selected" : "toggle"), ...styles.iconButton }}
              title={m["image_export.format.png.print.orientation_portrait"]()}
              onClick={() => setOrientation("portrait")}
            >
              <RectangleVertical size={16} />
            </button>
            <button
              className={buttonClass(orientation === "landscape" ? "toggle-selected" : "toggle")}
              style={{ ...buttonStyle(orientation === "landscape" ? "toggle-selected" : "toggle"), ...styles.iconButton }}
              title={m["image_export.format.png.print.orientation_landscape"]()}
              onClick={() => setOrientation("landscape")}
            >
              <RectangleHorizontal size={16} />
            </button>
          </Inline>
        </Inline>

        <NumberInputRow
          label={config.type === "square" ? m["field.print_sizing.cell_size_side"]() : m["field.print_sizing.cell_size_diameter"]()}
          value={cellSizeText}
          suffix="mm"
          onChange={setCellSizeText}
        />
        <NumberInputPairRow
          label={m["field.print_sizing.margin"]()}
          firstLabel={m["image_export.format.png.print.margin_h_short"]()}
          secondLabel={m["image_export.format.png.print.margin_v_short"]()}
          firstValue={marginHText}
          secondValue={marginVText}
          onFirstChange={setMarginHText}
          onSecondChange={setMarginVText}
        />

        {hasMultipleFloors && (
          <Stack gap="elementsGap">
            <Inline justify="space-between" gap="itemGap">
              <span style={styles.label}>{m["field.print_sizing.apply_all_floors"]()}</span>
              <Switch checked={applyToAllStandardFloors} onChange={setApplyToAllStandardFloors} />
            </Inline>
          </Stack>
        )}

        <div style={styles.divider} />
        <div style={styles.result}>
          {hasMultipleFloors ? (
            <Stack gap="elementsGap">
              <span style={styles.sectionLabel}>{m["floors.title"]()}</span>
              <div style={styles.floorTable}>
                {floorSummaries.map(({ id, title, info }) => (
                  <div key={id} style={styles.floorRow}>
                    <span>{title}</span>
                    <span>{info.shape}</span>
                    <span>{info.size}</span>
                    <span>{formatCellCount(info.cellCount)}</span>
                  </div>
                ))}
              </div>
              <div style={styles.floorTotal}>{m["field.print_sizing.floor_total"]({ count: formatCellCount(totalCellCount(floorSummaries)) })}</div>
              {(!Number.isFinite(cellSizeMm) || cellSizeMm <= 0) && (
                <span style={styles.error}>{m["field.print_sizing.invalid_cell_size"]()}</span>
              )}
              {Number.isFinite(cellSizeMm) && cellSizeMm > 0 && (!result || hasInvalidTargetFloor) && (
                <span style={styles.error}>{m["field.print_sizing.invalid"]()}</span>
              )}
            </Stack>
          ) : !Number.isFinite(cellSizeMm) || cellSizeMm <= 0 ? (
            <span style={styles.error}>{m["field.print_sizing.invalid_cell_size"]()}</span>
          ) : result ? (
            <Stack gap="elementsGap">
              <span style={typography.body}>{m["field.print_sizing.result"]({ description: configSizeDescription(result.config) })}</span>
              <span style={typography.body}>{m["field.print_sizing.result_cell_count"]({ count: printFieldCellCount(result.config) })}</span>
            </Stack>
          ) : (
            <span style={styles.error}>{m["field.print_sizing.invalid"]()}</span>
          )}
        </div>
      </Stack>

      <div style={styles.footer}>
        <Button variant="secondary" layoutStyle={styles.footerButton} onClick={onClose}>{m["common.cancel"]()}</Button>
        <Button variant="primary" layoutStyle={styles.footerButton} disabled={!canConfirm} onClick={handleApply}>
          {m["common.confirm"]()}
        </Button>
      </div>
    </Modal>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseNumber(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

function NumberInputRow({ label, value, suffix, onChange }: { label: string; value: string; suffix?: string; onChange: (value: string) => void }) {
  return (
    <Inline gap="itemGap" justify="space-between">
      <span style={styles.label}>{label}</span>
      <Inline gap="elementsGap">
        <input type="number" name={label} min={0} step="0.1" style={styles.input} value={value} onChange={(e) => onChange(e.target.value)} />
        {suffix && <span style={typography.caption}>{suffix}</span>}
      </Inline>
    </Inline>
  );
}

function NumberInputPairRow({ label, firstLabel, secondLabel, firstValue, secondValue, onFirstChange, onSecondChange }: {
  label: string;
  firstLabel: string;
  secondLabel: string;
  firstValue: string;
  secondValue: string;
  onFirstChange: (value: string) => void;
  onSecondChange: (value: string) => void;
}) {
  return (
    <Inline gap="itemGap" justify="space-between">
      <span style={styles.label}>{label}</span>
      <Inline gap="groupGap">
        <NumberInput label={firstLabel} value={firstValue} onChange={onFirstChange} />
        <NumberInput label={secondLabel} value={secondValue} onChange={onSecondChange} />
      </Inline>
    </Inline>
  );
}

function NumberInput({ label, value, disabled, onChange }: { label: string; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <Inline gap="elementsGap">
      <span style={{ ...styles.shortLabel, ...(disabled ? styles.disabled : {}) }}>{label}</span>
      <input type="number" name={label} min={0} step="0.1" disabled={disabled} style={{ ...styles.input, ...(disabled ? styles.inputDisabled : {}) }} value={value} onChange={(e) => onChange(e.target.value)} />
    </Inline>
  );
}

export function configSizeDescription(config: FieldConfig): string {
  switch (config.type) {
    case "square": return m["field.print_sizing.result_size"]({ size: `${config.width} × ${config.height}` });
    case "square_circle":
    case "hex_circle":
    case "triangle_circle":
    case "hex_hexagon":
    case "triangle_hexagon": return m["field.print_sizing.result_radius"]({ size: String(config.radius) });
    case "hex_triangle": return m["field.print_sizing.result_side"]({ size: String(config.side) });
    case "hex_rectangle":
    case "triangle_rect":
    case "hex_parallelogram":
      return m["field.print_sizing.result_size"]({ size: `${config.cols} × ${config.rows}` });
    case "triangle_triangle": return m["field.print_sizing.result_side"]({ size: String(config.side) });
    case "square_triangle": return m["field.print_sizing.result_side"]({ size: String(config.side) });
    case "square_custom":
    case "hex_custom":
    case "tri_custom": return "";
  }
}

interface FloorPrintInfo {
  shape: string;
  size: string;
  cellCount: number;
  isValid: boolean;
}

function floorPrintInfo(field: FloorFieldConfig | undefined, input: PrintFieldSizingInput): FloorPrintInfo {
  if (!field || field.fieldEditMode === "custom") {
    return {
      shape: m["field.print_sizing.floor_non_standard"](),
      size: "—",
      cellCount: field?.fieldPoints.size ?? 0,
      isValid: true,
    };
  }

  const config = field.tessellationConfig;
  if (!isPredefinedFieldConfig(config)) {
    return { shape: m["field.print_sizing.floor_non_standard"](), size: "—", cellCount: field.fieldPoints.size, isValid: true };
  }
  const result = calculatePrintFieldConfig(config, input);
  if (!result || !isPredefinedFieldConfig(result.config)) {
    return { shape: printFieldShapeLabel(config), size: "—", cellCount: 0, isValid: false };
  }
  return {
    shape: printFieldShapeLabel(result.config),
    size: printFieldSizeLabel(result.config),
    cellCount: printFieldCellCount(result.config),
    isValid: true,
  };
}

function totalCellCount(summaries: { info: FloorPrintInfo }[]): number {
  return summaries.reduce((total, summary) => total + summary.info.cellCount, 0);
}

function formatCellCount(count: number): string {
  return count === 1 ? m["field.cell"]({ count }) : m["field.cells"]({ count });
}

function printFieldShapeLabel(config: FieldConfig): string {
  switch (config.type) {
    case "square":
    case "hex_rectangle":
    case "triangle_rect": return m["field.shape.rectangle"]();
    case "square_circle":
    case "hex_circle":
    case "triangle_circle": return m["field.shape.circle"]();
    case "square_triangle":
    case "hex_triangle":
    case "triangle_triangle": return m["field.shape.triangle"]();
    case "hex_parallelogram": return m["field.shape.parallelogram"]();
    case "hex_hexagon":
    case "triangle_hexagon": return m["field.shape.hexagon"]();
    case "square_custom":
    case "hex_custom":
    case "tri_custom": return m["field.print_sizing.floor_non_standard"]();
  }
}

function printFieldSizeLabel(config: PredefinedFieldConfig): string {
  switch (config.type) {
    case "square": return `${config.width} × ${config.height}`;
    case "hex_rectangle":
    case "hex_parallelogram":
    case "triangle_rect": return `${config.cols} × ${config.rows}`;
    case "square_circle":
    case "hex_circle":
    case "triangle_circle":
    case "hex_hexagon":
    case "triangle_hexagon": return `${m["field.radius"]()} ${config.radius}`;
    case "square_triangle":
    case "hex_triangle":
    case "triangle_triangle": return `${m["field.side"]()} ${config.side}`;
  }
}

function printFieldCellCount(config: FieldConfig): number {
  if (config.type === "square_custom" || config.type === "hex_custom" || config.type === "tri_custom") return config.points.length;
  return configAllCells(config as PredefinedFieldConfig).length;
}

const styles: Record<string, React.CSSProperties> = {
  label: { flex: 1, ...typography.body },
  shortLabel: typography.caption,
  input: { ...sharedStyles.input, width: 72 },
  inputDisabled: { opacity: 0.45 },
  disabled: { opacity: 0.45 },
  iconButton: { width: 32, height: 28, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" },
  result: { padding: 0 },
  error: { ...typography.body, color: ui.text.error },
  sectionLabel: typography.body,
  divider: { borderTop: `1px solid ${ui.border.default}` },
  floorTable: {
    display: "grid",
    gridTemplateColumns: "max-content max-content max-content max-content",
    rowGap: spacing.itemGap,
    columnGap: spacing.tableColumnsGap,
    paddingLeft: indent.tree,
    whiteSpace: "nowrap",
    ...typography.body,
  },
  floorRow: { display: "contents" },
  floorTotal: { ...typography.body, marginTop: dialogSpacing.paddingY },
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: 0 },
  footerButton: { ...typography.control, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm },
};
