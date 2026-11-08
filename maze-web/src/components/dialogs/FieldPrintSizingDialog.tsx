import React, { useMemo, useRef, useState } from "react";
import { TESSELLATION_UI } from "../../pixi/geometry/tessellationUi";
import type { FieldConfig } from "../../fieldConfig";
import { useMazeStore } from "../../store/mazeStore";
import type { FloorFieldConfig } from "../../store/storeTypes";
import type { PaperOrientation, PaperSize } from "../../store/storeTypes";
import { Modal } from "../Modal";
import { WarningBubble } from "../WarningBubble";
import { Button } from "../Button";
import { Inline, Stack } from "../Layout";
import { Switch } from "../Switch";
import { sharedStyles } from "../../styles/shared";
import { dialogSpacing, indent, inset, radius, spacing, typography, ui } from "../../styles/theme";
import { calculatePrintFieldConfig, isPredefinedFieldConfig, DEFAULT_PRINT_CELL_SIZE_MM, MIN_PRINT_CELL_SIZE_MM, type PredefinedFieldConfig, type PrintFieldSizingInput } from "../../pixi/fieldPrintSizing";
import { DPI_BY_DENSITY, printCellMeasureMm } from "../../pixi/imageExport/printFit";
import { decodePoint } from "../../pixi/tessellationProjection";
import { cellSourceOf, hasTooSmallSide, MIN_COMFORTABLE_CELL_SIDE_MM, measurePrintCells, type CellSource, type PrintCellTypeSize } from "../../pixi/printCellSizes";
import { cellTypeLabel } from "../../i18n/cellTypeLabel";
import { CellSizesSection, typeBreakdown } from "./CellSizesSection";
import * as m from "~/paraglide/messages";
import { PaperLayoutFields } from "../features/PaperLayoutFields";
import { NumberInput } from "../NumberInput";
import { normalizeNumberCommit } from "../inputNormalization";

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
  const [cellSizeText, setCellSizeText] = useState(() => String(round2(Math.max(MIN_PRINT_CELL_SIZE_MM, initialCellSizeMm))));
  const [marginHText, setMarginHText] = useState(() => String(print.marginHMm));
  const [marginVText, setMarginVText] = useState(() => String(print.marginVMm));
  const [applyToAllStandardFloors, setApplyToAllStandardFloors] = useState(() => hasMultipleFloors);
  const customWidthMm = parseNumber(customWidthText);
  const customHeightMm = parseNumber(customHeightText);
  // What is typed in the cell size field until it is committed (on blur or on confirming the dialog).
  const cellSizeDraft = useRef<string | null>(null);
  const cellSizeMm = parseNumber(cellSizeText);
  const marginHMm = parseNumber(marginHText);
  const marginVMm = parseNumber(marginVText);

  const result = useMemo(
    () => calculatePrintFieldConfig(config, {
      paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm: cellSizeMm, marginHMm, marginVMm,
    }),
    [config, paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm, marginHMm, marginVMm],
  );
  const floorSummaries = useMemo(
    () => floors.map((floor, index) => ({ floor, index })).reverse().map(({ floor, index }) => ({
      id: floor.id,
      title: `${index + 1}: ${floor.title}`,
      info: floorPrintInfo(floorFields[floor.id], {
        paperSize, customWidthMm, customHeightMm, orientation,
        cellSizeMm: cellSizeMm, marginHMm, marginVMm,
      }),
    })),
    [floors, floorFields, paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm, marginHMm, marginVMm],
  );
  // Core counts and measures the cells of all floors together: the count of a type is summed over
  // them, and only numbers come back.
  const measure = useMemo(
    () => measurePrintCells(config, floorSummaries.flatMap(({ info }) => info.sources), cellSizeMm),
    [config, floorSummaries, cellSizeMm],
  );
  const cellTypeSizes = measure.types;
  const floorCellCounts = useMemo(() => floorCountsOf(floorSummaries, measure.sourceCounts), [floorSummaries, measure]);
  const smallSideTypes = useMemo(() => cellTypeSizes.filter(hasTooSmallSide), [cellTypeSizes]);
  const hasInvalidTargetFloor = hasMultipleFloors
    && applyToAllStandardFloors
    && floorSummaries.some(({ info }) => !info.isValid);
  const canConfirm = result !== null
    && !hasInvalidTargetFloor;

  /** Commits the typed cell size as leaving the field does: an unreadable value goes back to the
   * last committed one, a value under the minimum is raised to it. */
  function commitCellSize(text: string): string {
    cellSizeDraft.current = null;
    const committed = normalizeNumberCommit(text, cellSizeText, { min: MIN_PRINT_CELL_SIZE_MM }).value;
    setCellSizeText(committed);
    return committed;
  }

  function handleApply() {
    // Confirming (Enter included) takes a value still being typed as if the field was left.
    const latestCellSizeMm = cellSizeDraft.current === null
      ? cellSizeMm
      : parseNumber(commitCellSize(cellSizeDraft.current));
    const latestResult = calculatePrintFieldConfig(config, {
      paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm: latestCellSizeMm, marginHMm, marginVMm,
    });
    if (!latestResult) return;
    const configsByFloor: Record<string, FieldConfig> = {};
    for (const floor of floors) {
      if (!applyToAllStandardFloors && floor.id !== activeFloorId) continue;
      const field = floorFields[floor.id];
      if (!field || field.fieldEditMode === "custom" || !isPredefinedFieldConfig(field.fieldConfig)) continue;
      const floorResult = calculatePrintFieldConfig(field.fieldConfig, {
        paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm: latestCellSizeMm, marginHMm, marginVMm,
      });
      if (!floorResult || !isPredefinedFieldConfig(floorResult.config)) return;
      configsByFloor[floor.id] = floorResult.config;
    }
    if (!configsByFloor[activeFloorId]) return;
    onApply(
      latestResult.config,
      { paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm: latestCellSizeMm, marginHMm, marginVMm },
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

        <Inline gap="itemGap" justify="space-between">
          <span style={styles.label}>
            {TESSELLATION_UI[config.tessellation.kind].editor.printCellSize === "side" ? m["field.print_sizing.cell_size_side"]() : m["field.print_sizing.cell_size_diameter"]()}
          </span>
          <Inline gap="elementsGap">
            {/* Typing only buffers the value; the preview follows when the field is left. */}
            <NumberInput
              name="cell-size"
              value={cellSizeText}
              min={MIN_PRINT_CELL_SIZE_MM}
              style={styles.input}
              onChange={(text) => { cellSizeDraft.current = text; }}
              onBlurCommit={commitCellSize}
            />
            <span style={typography.caption}>mm</span>
          </Inline>
        </Inline>
        {hasMultipleFloors && (
          <Stack gap="elementsGap">
            <Inline justify="space-between" gap="itemGap">
              <span style={styles.label}>{m["field.print_sizing.apply_all_floors"]()}</span>
              <Switch checked={applyToAllStandardFloors} onChange={setApplyToAllStandardFloors} />
            </Inline>
          </Stack>
        )}

        <CellSizesSection sizes={cellTypeSizes} tessellationKind={config.tessellation.kind} />

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
                    <span>{formatCellCount(floorCellCounts.get(id) ?? 0)}</span>
                  </div>
                ))}
              </div>
              <div style={styles.floorTotal}>{totalText(
                "field.print_sizing.floor_total", "field.print_sizing.floor_total_types", formatCellCount(sumOf(floorCellCounts)), cellTypeSizes,
              )}</div>
              {(!result || hasInvalidTargetFloor) && (
                <span style={styles.error}>{m["field.print_sizing.invalid"]()}</span>
              )}
            </Stack>
          ) : result ? (
            <Stack gap="elementsGap">
              <span style={typography.body}>{m["field.print_sizing.result"]({ description: configSizeDescription(result.config) })}</span>
              <span style={typography.body}>{totalText(
                "field.print_sizing.result_cell_count", "field.print_sizing.result_cell_count_types", String(sumOf(floorCellCounts)), cellTypeSizes,
              )}</span>
            </Stack>
          ) : (
            <span style={styles.error}>{m["field.print_sizing.invalid"]()}</span>
          )}
        </div>
        {smallSideTypes.length > 0 && (
          <div style={styles.warnings}>
            <WarningBubble
              message={m["field.print_sizing.warning_small_side"]({
                types: smallSideTypes
                  .map((type) => `${cellTypeLabel(type.key)} ${m["field.print_sizing.length_mm"]({ value: Math.min(...type.sidesMm).toFixed(1) })}`)
                  .join(", "),
                min: String(MIN_COMFORTABLE_CELL_SIDE_MM),
              })}
            />
          </div>
        )}
      </Stack>

      <div style={styles.footer}>
        <Button variant="secondary" dialogAction layoutStyle={styles.footerButton} onClick={onClose}>{m["common.cancel"]()}</Button>
        <Button variant="primary" dialogAction layoutStyle={styles.footerButton} disabled={!canConfirm} onClick={handleApply}>
          {m["common.confirm"]()}
        </Button>
      </div>
    </Modal>
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseNumber(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

export function configSizeDescription(config: FieldConfig): string {
  const { shape } = config;
  switch (shape.shape) {
    case "rect":
    case "cylinder":
    case "torus":
    case "parallelogram": return m["field.print_sizing.result_size"]({ size: `${shape.cols} × ${shape.rows}` });
    case "circle":
    case "hexagon": return m["field.print_sizing.result_radius"]({ size: String(shape.radius) });
    case "triangle":
    case "tetrahedron":
    case "octahedron":
    case "icosahedron": return m["field.print_sizing.result_side"]({ size: String(shape.side) });
    case "box": return m["field.print_sizing.result_size"]({ size: `${shape.width} × ${shape.height} × ${shape.depth}` });
    case "custom": return "";
  }
}

interface FloorPrintInfo {
  shape: string;
  size: string;
  /** What core measures for the cell sizes: the floor preset, or the cells of a custom field. */
  sources: CellSource[];
  isValid: boolean;
}

function floorPrintInfo(field: FloorFieldConfig | undefined, input: PrintFieldSizingInput): FloorPrintInfo {
  if (!field || field.fieldEditMode === "custom") {
    return {
      shape: m["field.print_sizing.floor_non_standard"](),
      size: "—",
      sources: field ? [{ cells: Array.from(field.fieldPoints, decodePoint) }] : [],
      isValid: true,
    };
  }

  const config = field.fieldConfig;
  if (!isPredefinedFieldConfig(config)) {
    return { shape: m["field.print_sizing.floor_non_standard"](), size: "—", sources: [{ cells: Array.from(field.fieldPoints, decodePoint) }], isValid: true };
  }
  const result = calculatePrintFieldConfig(config, input);
  if (!result || !isPredefinedFieldConfig(result.config)) {
    return { shape: printFieldShapeLabel(config), size: "—", sources: [], isValid: false };
  }
  return {
    shape: printFieldShapeLabel(result.config),
    size: printFieldSizeLabel(result.config),
    sources: [cellSourceOf(result.config)],
    isValid: true,
  };
}

/** A cell total with the per-type breakdown appended when the tessellation has several types in the field. */
function totalText(
  plainKey: "field.print_sizing.floor_total" | "field.print_sizing.result_cell_count",
  typesKey: "field.print_sizing.floor_total_types" | "field.print_sizing.result_cell_count_types",
  count: string,
  sizes: PrintCellTypeSize[],
): string {
  const types = typeBreakdown(sizes);
  return types ? m[typesKey]({ count, types }) : m[plainKey]({ count });
}

/** The cell count of each floor, by floor id; `sourceCounts` follows the order of the floors' sources. */
function floorCountsOf(summaries: { id: string; info: FloorPrintInfo }[], sourceCounts: number[]): Map<string, number> {
  const counts = new Map<string, number>();
  let offset = 0;
  for (const { id, info } of summaries) {
    const end = offset + info.sources.length;
    counts.set(id, sourceCounts.slice(offset, end).reduce((sum, count) => sum + count, 0));
    offset = end;
  }
  return counts;
}

function sumOf(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
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
    case "cylinder": return m["field.shape.cylinder"]();
    case "torus": return m["field.shape.torus"]();
    case "hexagon": return m["field.shape.hexagon"]();
    case "box": return m["field.shape.box"]();
    case "tetrahedron": return m["field.shape.tetrahedron"]();
    case "octahedron": return m["field.shape.octahedron"]();
    case "icosahedron": return m["field.shape.icosahedron"]();
    case "custom": return m["field.print_sizing.floor_non_standard"]();
  }
}

function printFieldSizeLabel(config: PredefinedFieldConfig): string {
  const { shape } = config;
  switch (shape.shape) {
    case "rect":
    case "cylinder":
    case "torus":
    case "parallelogram": return `${shape.cols} × ${shape.rows}`;
    case "circle":
    case "hexagon": return `${m["field.radius"]()} ${shape.radius}`;
    case "triangle":
    case "tetrahedron":
    case "octahedron":
    case "icosahedron": return `${m["field.side"]()} ${shape.side}`;
    case "box": return `${shape.width} × ${shape.height} × ${shape.depth}`;
  }
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
  warnings: { marginTop: dialogSpacing.paddingY * 2 },
  floorTotal: { ...typography.body, marginTop: dialogSpacing.paddingY },
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: 0 },
  footerButton: { ...typography.control, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm },
};
