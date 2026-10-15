import React, { useEffect, useMemo, useState } from "react";
import type { FieldConfig } from "../../fieldConfig";
import { useMazeStore } from "../../store/mazeStore";
import type { FloorFieldConfig } from "../../store/storeTypes";
import type { PaperOrientation, PaperSize } from "../../store/storeTypes";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { Inline, Stack } from "../Layout";
import { Switch } from "../Switch";
import { sharedStyles } from "../../styles/shared";
import { dialogSpacing, indent, inset, radius, spacing, typography, ui } from "../../styles/theme";
import { calculatePrintFieldConfig, isPredefinedFieldConfig, DEFAULT_PRINT_CELL_SIZE_MM, type PredefinedFieldConfig, type PrintFieldSizingInput } from "../../pixi/fieldPrintSizing";
import { DPI_BY_DENSITY, printCellMeasureMm } from "../../pixi/imageExport/printFit";
import { configAllCells } from "../../pixi/tessellationCells";
import * as m from "~/paraglide/messages";
import { PaperLayoutFields } from "../features/PaperLayoutFields";

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

const CALCULATION_DEBOUNCE_MS = 120;
export function FieldPrintSizingDialog({ config, hasMultipleFloors, onApply, onClose }: Props) {
  const print = useMazeStore((s) => s.pngExportSettings.print);
  const floors = useMazeStore((s) => s.floors);
  const floorFields = useMazeStore((s) => s.floorFields);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  const initialCellSizeMm = print.scaleAutoFit
    ? DEFAULT_PRINT_CELL_SIZE_MM
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
      if (!field || field.fieldEditMode === "custom" || !isPredefinedFieldConfig(field.fieldConfig)) continue;
      const floorResult = calculatePrintFieldConfig(field.fieldConfig, {
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
        <PaperLayoutFields
          paperSize={paperSize}
          customWidthMm={customWidthText}
          customHeightMm={customHeightText}
          orientation={orientation}
          marginHMm={marginHText}
          marginVMm={marginVText}
          onPaperSizeChange={setPaperSize}
          onCustomWidthChange={setCustomWidthText}
          onCustomHeightChange={setCustomHeightText}
          onOrientationChange={setOrientation}
          onMarginHChange={setMarginHText}
          onMarginVChange={setMarginVText}
          paperLabel={m["field.print_sizing.paper"]()}
          marginLabel={m["field.print_sizing.margin"]()}
          inputNamePrefix="field-print"
        />

        <NumberInputRow
          label={config.tessellation.kind === "square" ? m["field.print_sizing.cell_size_side"]() : m["field.print_sizing.cell_size_diameter"]()}
          value={cellSizeText}
          suffix="mm"
          onChange={setCellSizeText}
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

export function configSizeDescription(config: FieldConfig): string {
  const { shape } = config;
  switch (shape.shape) {
    case "rect":
    case "parallelogram": return m["field.print_sizing.result_size"]({ size: `${shape.cols} × ${shape.rows}` });
    case "circle":
    case "hexagon": return m["field.print_sizing.result_radius"]({ size: String(shape.radius) });
    case "triangle": return m["field.print_sizing.result_side"]({ size: String(shape.side) });
    case "custom": return "";
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

  const config = field.fieldConfig;
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
  switch (config.shape.shape) {
    case "rect": return m["field.shape.rectangle"]();
    case "circle": return m["field.shape.circle"]();
    case "triangle": return m["field.shape.triangle"]();
    case "parallelogram": return m["field.shape.parallelogram"]();
    case "hexagon": return m["field.shape.hexagon"]();
    case "custom": return m["field.print_sizing.floor_non_standard"]();
  }
}

function printFieldSizeLabel(config: PredefinedFieldConfig): string {
  const { shape } = config;
  switch (shape.shape) {
    case "rect":
    case "parallelogram": return `${shape.cols} × ${shape.rows}`;
    case "circle":
    case "hexagon": return `${m["field.radius"]()} ${shape.radius}`;
    case "triangle": return `${m["field.side"]()} ${shape.side}`;
  }
}

function printFieldCellCount(config: FieldConfig): number {
  return configAllCells(config).length;
}

const styles: Record<string, React.CSSProperties> = {
  label: { flex: 1, ...typography.body },
  input: { ...sharedStyles.input, width: 56, boxSizing: "border-box" },
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
