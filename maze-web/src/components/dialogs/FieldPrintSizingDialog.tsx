import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { isPredefinedFieldConfig, MIN_PRINT_CELL_SIZE_MM, type PredefinedFieldConfig, type PrintFieldSizingInput } from "../../pixi/fieldPrintSizing";
import { printSizingFailure, type PrintSizingAnswer, type PrintSizingFloor, type PrintSizingFloorAnswer, type PrintSizingRequest } from "../../pixi/printSizingJob";
import { startPrintSizing } from "../../wasm/workerClients";
import type { WorkerJob } from "../../wasm/workerPool";
import { DPI_BY_DENSITY, printCellMeasureMm } from "../../pixi/imageExport/printFit";
import { decodePoint } from "../../pixi/tessellationProjection";
import { hasTooSmallSide, MIN_COMFORTABLE_CELL_SIDE_MM, type PrintCellTypeSize } from "../../pixi/printCellSizes";
import { cellTypeLabel } from "../../i18n/cellTypeLabel";
import { CellSizesSection, typeBreakdown } from "./CellSizesSection";
import * as m from "~/paraglide/messages";
import { PaperLayoutFields } from "../features/PaperLayoutFields";
import { NumberInput } from "../NumberInput";
import { useDelayedIndicator } from "../useDelayedIndicator";
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
  const smooth = useMazeStore((s) => s.smoothPrimitives);
  const initialCellSizeMm = printCellMeasureMm(config, print.scale, DPI_BY_DENSITY[print.density]);
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

  const input = useMemo<PrintFieldSizingInput>(
    () => ({ paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm, marginHMm, marginVMm, smooth }),
    [paperSize, customWidthMm, customHeightMm, orientation, cellSizeMm, marginHMm, marginVMm, smooth],
  );
  const request = useMemo<PrintSizingRequest>(
    () => ({ config, input, floors: floors.map((floor) => printSizingFloorOf(floor.id, floorFields[floor.id])) }),
    [config, input, floors, floorFields],
  );
  // The calculation runs in a worker (GitHub issue #949): any change of the request cancels the
  // running one and starts a new one, and closing the dialog cancels the running one.
  const [calculation, setCalculation] = useState<Calculation>({ status: "pending" });
  const applyJob = useRef<WorkerJob<PrintSizingAnswer> | null>(null);
  useEffect(() => {
    let current = true;
    setCalculation({ status: "pending" });
    const job = startPrintSizing(request);
    job.promise.then(
      (answer) => { if (current) setCalculation({ status: "done", answer }); },
      (error) => { if (current) setCalculation({ status: "failed", message: error instanceof Error ? error.message : String(error) }); },
    );
    return () => {
      current = false;
      job.cancel(new Error("Print sizing superseded"));
    };
  }, [request]);
  useEffect(() => () => applyJob.current?.cancel(new Error("Print sizing dialog closed")), []);

  const answer = calculation.status === "done" ? calculation.answer : null;
  // The progress indicator is delayed and held (GitHub issue #960): until it shows, the results of
  // the previous calculation stay on screen. Confirming relies on `answer` only, never on them.
  const showProgress = useDelayedIndicator(calculation.status === "pending");
  const lastAnswer = useRef<PrintSizingAnswer | null>(null);
  if (answer) lastAnswer.current = answer;
  const shownAnswer = answer ?? lastAnswer.current;
  const result = answer?.result ?? null;
  const shownResult = shownAnswer?.result ?? null;
  const floorSummaries = useMemo(
    () => floors.map((floor, index) => ({ floor, index })).reverse().map(({ floor, index }) => ({
      id: floor.id,
      title: `${index + 1}: ${floor.title}`,
      info: floorPrintInfo(floorFields[floor.id], shownAnswer?.floors.find((entry) => entry.id === floor.id)),
    })),
    [floors, floorFields, shownAnswer],
  );
  // Core counts and measures the cells of all floors together: the count of a type is summed over
  // them, and only numbers come back.
  const cellTypeSizes = useMemo(() => shownAnswer?.measure.types ?? [], [shownAnswer]);
  const floorCellCounts = useMemo(() => new Map((shownAnswer?.floors ?? []).map((entry) => [entry.id, entry.cellCount])), [shownAnswer]);
  const smallSideTypes = useMemo(() => cellTypeSizes.filter(hasTooSmallSide), [cellTypeSizes]);
  const hasInvalidTargetFloor = hasMultipleFloors
    && applyToAllStandardFloors
    && floorSummaries.some(({ info }) => !info.isValid);
  const canConfirm = result !== null
    && !hasInvalidTargetFloor;
  const searchLimit = shownAnswer
    ? [shownResult, ...shownAnswer.floors.map((entry) => entry.result)].reduce<number | null>((found, entry) => found ?? entry?.limit ?? null, null)
    : null;

  /** Commits the typed cell size as leaving the field does: an unreadable value goes back to the
   * last committed one, a value under the minimum is raised to it. */
  function commitCellSize(text: string): string {
    cellSizeDraft.current = null;
    const committed = normalizeNumberCommit(text, cellSizeText, { min: MIN_PRINT_CELL_SIZE_MM }).value;
    setCellSizeText(committed);
    return committed;
  }

  async function handleApply() {
    // A second confirmation while the typed size is being calculated would apply twice.
    if (applyJob.current) return;
    // Confirming (Enter included) takes a value still being typed as if the field was left.
    const latestCellSizeMm = cellSizeDraft.current === null
      ? cellSizeMm
      : parseNumber(commitCellSize(cellSizeDraft.current));
    const latestInput: PrintFieldSizingInput = { ...input, cellSizeMm: latestCellSizeMm };
    let latest = answer;
    if (!latest || !Object.is(latestCellSizeMm, cellSizeMm)) {
      // The typed size is not calculated yet: calculate it for this one confirmation.
      const job = startPrintSizing({ ...request, input: latestInput });
      applyJob.current = job;
      try {
        latest = await job.promise;
      } catch {
        return;
      } finally {
        applyJob.current = null;
      }
    }
    if (!latest.result) return;
    const configsByFloor: Record<string, FieldConfig> = {};
    for (const floor of latest.floors) {
      if (!applyToAllStandardFloors && floor.id !== activeFloorId) continue;
      if (!floor.standard) continue;
      if (!floor.result || !isPredefinedFieldConfig(floor.result.config)) return;
      configsByFloor[floor.id] = floor.result.config;
    }
    if (!configsByFloor[activeFloorId]) return;
    onApply(latest.result.config, latestInput, applyToAllStandardFloors, configsByFloor);
    onClose();
  }

  return (
    <Modal title={m["field.print_sizing.title"]()} size={hasMultipleFloors ? "printSizing" : "info"} onClose={onClose} onConfirm={canConfirm ? () => void handleApply() : undefined}>
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

        {showProgress ? (<>
          <div style={styles.divider} />
          <CalculationProgress />
        </>) : calculation.status === "failed" ? (<>
          <div style={styles.divider} />
          <span style={styles.error}>{m["field.print_sizing.failed"]({ reason: calculation.message })}</span>
        </>) : shownAnswer === null ? null : (<>
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
              {answer && (!shownResult || hasInvalidTargetFloor) && (
                <span style={styles.error}>{failureText(input)}</span>
              )}
            </Stack>
          ) : shownResult ? (
            <Stack gap="elementsGap">
              <span style={typography.body}>{m["field.print_sizing.result"]({ description: configSizeDescription(shownResult.config) })}</span>
              <span style={typography.body}>{totalText(
                "field.print_sizing.result_cell_count", "field.print_sizing.result_cell_count_types", String(sumOf(floorCellCounts)), cellTypeSizes,
              )}</span>
            </Stack>
          ) : answer && (
            <span style={styles.error}>{failureText(input)}</span>
          )}
        </div>
        {searchLimit !== null && (
          <div style={styles.warnings}>
            <WarningBubble message={m["field.print_sizing.limit_reached"]({ limit: String(searchLimit) })} />
          </div>
        )}
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
        </>)}
      </Stack>

      <div style={styles.footer}>
        <Button variant="secondary" dialogAction layoutStyle={styles.footerButton} onClick={onClose}>{m["common.cancel"]()}</Button>
        <Button variant="primary" dialogAction layoutStyle={styles.footerButton} disabled={!canConfirm} onClick={() => void handleApply()}>
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
  isValid: boolean;
}

type Calculation =
  | { status: "pending" }
  | { status: "done"; answer: PrintSizingAnswer }
  | { status: "failed"; message: string };

function printSizingFloorOf(id: string, field: FloorFieldConfig | undefined): PrintSizingFloor {
  if (field && field.fieldEditMode !== "custom" && isPredefinedFieldConfig(field.fieldConfig)) {
    return { id, config: field.fieldConfig };
  }
  return { id, cells: field ? Array.from(field.fieldPoints, decodePoint) : [] };
}

/** `answer` is missing while the calculation is pending. */
function floorPrintInfo(field: FloorFieldConfig | undefined, answer: PrintSizingFloorAnswer | undefined): FloorPrintInfo {
  if (!field || field.fieldEditMode === "custom" || !isPredefinedFieldConfig(field.fieldConfig)) {
    return { shape: m["field.print_sizing.floor_non_standard"](), size: "—", isValid: true };
  }
  const result = answer?.result;
  if (!result || !isPredefinedFieldConfig(result.config)) {
    return { shape: printFieldShapeLabel(field.fieldConfig), size: "—", isValid: false };
  }
  return { shape: printFieldShapeLabel(result.config), size: printFieldSizeLabel(result.config), isValid: true };
}

/** Why no size was found, in words. */
function failureText(input: PrintFieldSizingInput): string {
  switch (printSizingFailure(input)) {
    case "invalid_input": return m["field.print_sizing.invalid_input"]();
    case "margins": return m["field.print_sizing.margins_too_large"]();
    case "cell_too_large": return m["field.print_sizing.invalid"]();
  }
}

/** Stands in for the results while the worker calculates. */
function CalculationProgress() {
  const label = m["field.print_sizing.calculating"]();
  return (
    <div style={styles.progress} aria-live="polite" aria-busy="true">
      <span role="status" style={typography.body}>{label}</span>
      <div role="progressbar" aria-label={label} style={styles.progressTrack}>
        <div className="loading-progress-indeterminate" style={styles.progressBar} />
      </div>
    </div>
  );
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
  progress: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  progressTrack: { width: "100%", height: 4, overflow: "hidden", borderRadius: 2, background: ui.bg.input },
  progressBar: { width: "100%", height: "100%", borderRadius: "inherit", background: ui.accent.base, transformOrigin: "left", transform: "scaleX(0.3)" },
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
