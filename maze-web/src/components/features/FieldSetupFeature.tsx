import React, { Fragment, useState } from "react";
import { TESSELLATION_UI } from "../../domain/geometry/tessellationUi";
import { useMazeStore } from "../../store/mazeStore";
import type { TessellationKind } from "../../store/mazeStore";
import { BOX_NET_COMPACT, POLYHEDRON_SHAPES, isSwitchedShape, type FieldConfig, type FieldShape, type PolyhedronShapeName, type PresetFieldShapeName } from "../../fieldConfig";
import { sharedStyles } from "../../styles/shared";
import { Button } from "../Button";
import { typography, muted, spacing, indent } from "../../styles/theme";
import { ConfirmModal } from "../ConfirmModal";
import { hasGeneration } from "../../store/storeHelpers";
import { FieldPrintSizingDialog } from "../dialogs/FieldPrintSizingDialog";
import { PaperLayoutDialog } from "../dialogs/PaperLayoutDialog";
import { Switch } from "../Switch";
import { Stack, Inline } from "../Layout";
import { ToggleRow } from "../ToggleRow";
import { BackgroundImageToggle } from "../BackgroundImageToggle";
import { SettingsIconButton } from "../SettingsIconButton";
import { isPredefinedFieldConfig } from "../../pixi/fieldPrintSizing";
import { configAllCells } from "../../domain/tessellationCells";
import type { InputNormalizationReason } from "../inputNormalization";
import { snapRectToClose } from "../../pixi/rectGluing";
import { availablePresetKeys, compactNetOf, fieldOperationAvailable, polyhedronFaceCount, polyhedronNetCount, presetParams } from "../../domain/fieldOps";
import { SizeParam } from "./SizeParam";
import { TopologyPanel } from "./TopologyPanel";
import { FloorsPanel } from "./FloorsPanel";
import { useSidePanelOpen } from "../sidePanelStack";
import { FieldToolsSection, SmoothingToggleRow } from "./FieldToolsSection";
import * as m from "~/paraglide/messages";

type ConfirmPending = "switchToDefault" | "clearField" | null;

export function FieldSetupFeature() {
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const selectedShape = useMazeStore((s) => s.floorFields[s.activeFloorId].selectedShape);
  // A custom field's config is rebuilt on every cell edit, so a custom editor must not subscribe to it
  // (it would re-render this whole section per edit). Only the default editor renders from the config.
  const fieldConfig = useMazeStore((s) => {
    const field = s.floorFields[s.activeFloorId];
    return field.fieldEditMode === "custom" ? null : field.fieldConfig;
  });
  const translateAvailable = useMazeStore((s) => fieldOperationAvailable(s.floorFields[s.activeFloorId].fieldConfig.tessellation, "translate"));
  const fieldEditMode = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldEditMode);
  const setSelectedShape = useMazeStore((s) => s.setSelectedShape);
  const setFieldConfig = useMazeStore((s) => s.setFieldConfig);
  const setFieldConfigsForFloors = useMazeStore((s) => s.setFieldConfigsForFloors);
  const setFieldEditMode = useMazeStore((s) => s.setFieldEditMode);
  const setPrintFieldSizing = useMazeStore((s) => s.setPrintFieldSizing);
  const hasFieldPoints = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPoints.size > 0);
  const clearFieldPoints = useMazeStore((s) => s.clearFieldPoints);
  const centerFieldPoints = useMazeStore((s) => s.centerFieldPoints);
  const fieldEditConfirmation = useMazeStore((s) => s.fieldEditConfirmation);
  const confirmFieldEdit = useMazeStore((s) => s.confirmFieldEdit);
  const cancelFieldEdit = useMazeStore((s) => s.cancelFieldEdit);
  const showFieldOrigin = useMazeStore((s) => s.showFieldOrigin);
  const setShowFieldOrigin = useMazeStore((s) => s.setShowFieldOrigin);
  const showPrimitiveFrame = useMazeStore((s) => s.showPrimitiveFrame);
  const setShowPrimitiveFrame = useMazeStore((s) => s.setShowPrimitiveFrame);
  const showPaperLayout = useMazeStore((s) => s.showPaperLayout);
  const setShowPaperLayout = useMazeStore((s) => s.setShowPaperLayout);
  const topologyPanelOpen = useMazeStore((s) => s.topologyPanelOpen);
  const setTopologyPanelOpen = useMazeStore((s) => s.setTopologyPanelOpen);
  const floorCount = useMazeStore((s) => s.floors.length);
  const fieldEditLocked = useMazeStore((s) => s.backgroundAutoFillPreview !== null);

  const [confirmPending, setConfirmPending] = useState<ConfirmPending>(null);
  const [floorsPanelOpen, setFloorsPanelOpen] = useSidePanelOpen("floors");
  const [printSizingDialogOpen, setPrintSizingDialogOpen] = useState(false);
  const [paperLayoutDialogOpen, setPaperLayoutDialogOpen] = useState(false);

  const isCustom = fieldEditMode === "custom";
  const printableConfig = !isCustom && fieldConfig && isPredefinedFieldConfig(fieldConfig)
    ? fieldConfig
    : null;

  function setField(field: string, value: number): InputNormalizationReason | void {
    if (!fieldConfig) return;
    // The compact layout of a box or polyhedron is always by faces.
    const { shape } = fieldConfig;
    const forced = isSwitchedShape(shape) && field === "net" && value === compactNetOf(fieldConfig.tessellation, shape) ? { mode: 1 } : {};
    const next = { ...fieldConfig, shape: { ...fieldConfig.shape, [field]: value, ...forced } as FieldShape };
    // A cylinder or torus only exists at sizes that close up (GitHub issue #894): move to the nearest one.
    const closing = snapRectToClose(next, field === "rows" ? "rows" : "cols");
    if (!closing) return;
    setFieldConfig(closing);
    if (closing === next || (closing.shape.shape !== "cylinder" && closing.shape.shape !== "torus")) return;
    return { kind: "rounded_to_gluing", shape: closing.shape.shape, value: String((closing.shape as unknown as Record<string, number>)[field]) };
  }

  function handleSwitchToDefault() {
    // The generation-loss dialog (store) already covers the loss of custom shape changes.
    const generationLossDialogShown = hasGeneration(useMazeStore.getState());
    if (isCustom && hasFieldPoints && !generationLossDialogShown) {
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
    if (!fieldConfig) return null;
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
    if (!fieldConfig) return null;
    const { shape } = fieldConfig;
    if (shape.shape === "custom") return null;
    const values = shape as unknown as Record<string, number>;
    const compactBox = isSwitchedShape(shape) && shape.net === compactNetOf(fieldConfig.tessellation, shape);
    const params = presetParams(fieldConfig.tessellation, shape.shape);
    return params.map(({ name, min, max }) => {
      // The compact layout's sheet aspect is set by print sizing, not typed in.
      if (name === "aspect") return null;
      if (shape.shape === "box" && BOX_SIZES.includes(name)) {
        if (name !== BOX_SIZES[0]) return null;
        // One "Dimensions" caption above the three side inputs in a row.
        return (
          <Fragment key={name}>
            <div style={styles.sectionLabel}>{m["field.sizes"]()}</div>
            <Inline gap="itemGap">
              {params.filter((p) => BOX_SIZES.includes(p.name)).map((p) => (
                <SizeParam
                  key={p.name}
                  hideLabel
                  label={paramLabel(tessellationKind, shape.shape, p.name)}
                  value={values[p.name]}
                  min={p.min}
                  max={p.max ?? paramMax(tessellationKind, shape.shape, p.name)}
                  disabled={fieldEditLocked}
                  onCommit={(v) => setField(p.name, v)}
                />
              ))}
            </Inline>
          </Fragment>
        );
      }
      const choices = paramChoices(fieldConfig.tessellation, shape.shape, name);
      if (choices) {
        return (
          <label key={name} style={styles.label}>
            {paramLabel(tessellationKind, shape.shape, name)}
            <select style={styles.select} value={compactBox && name === "mode" ? 1 : values[name] ?? 0} name={`field-${name}`}
              disabled={fieldEditLocked || (compactBox && name === "mode")}
              onChange={(e) => setField(name, Number(e.target.value))}>
              {choices.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        );
      }
      return (
      <SizeParam
        key={name}
        label={paramLabel(tessellationKind, shape.shape, name)}
        value={values[name]}
        min={min}
        max={max ?? paramMax(tessellationKind, shape.shape, name)}
        disabled={fieldEditLocked}
        onCommit={(v) => setField(name, v)}
      />
      );
    });
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
          <SmoothingToggleRow customEditor={isCustom} />
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
          <FieldToolsSection />
          <div style={styles.originRow}>
            <span style={styles.originLabel}>{m["field.show_primitive_frame"]()}</span>
            <Switch checked={showPrimitiveFrame} onChange={setShowPrimitiveFrame} disabled={fieldEditLocked} />
          </div>
          <SmoothingToggleRow customEditor={isCustom} />
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
            variant="secondary"
            disabled={fieldEditLocked}
            layoutStyle={{ width: "100%", marginTop: spacing.itemGap }}
            onClick={() => {
              setTopologyPanelOpen(true);
            }}
          >
            {m["topology.open"]()}
          </Button>
          <Button
            variant="secondary"
            disabled={fieldEditLocked || !hasFieldPoints || !translateAvailable}
            layoutStyle={{ width: "100%", marginTop: spacing.itemGap }}
            onClick={centerFieldPoints}
          >
            {m["field.center"]()}
          </Button>
        </>
      )}
      {isCustom && topologyPanelOpen && <TopologyPanel onClose={() => setTopologyPanelOpen(false)} />}
      <Button
        variant="secondary"
        layoutStyle={{ width: "100%", marginTop: spacing.itemGap }}
        onClick={() => {
          setFloorsPanelOpen(true);
        }}
      >
        {m["floors.title"]()}
      </Button>
      {floorsPanelOpen && <FloorsPanel onClose={() => setFloorsPanelOpen(false)} />}
      {isCustom && (
        <Button
          variant="destructive"
          disabled={fieldEditLocked}
          layoutStyle={{ width: "100%", marginTop: spacing.itemGap }}
          onClick={handleClearField}
        >
          {m["field.clear"]()}
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
          config={activeFieldConfigNow()}
          onApply={(input) => {
            setPrintFieldSizing(input, { tessellation: activeFieldConfigNow().tessellation });
            setShowPaperLayout(true);
          }}
          onClose={() => setPaperLayoutDialogOpen(false)}
        />
      )}
    </Stack>
  );
}

/** The active floor's current field config, read on demand: the section does not subscribe to it in a custom editor. */
function activeFieldConfigNow(): FieldConfig {
  const state = useMazeStore.getState();
  return state.floorFields[state.activeFloorId].fieldConfig;
}

function shapeLabel(kind: TessellationKind, shape: PresetFieldShapeName): string {
  switch (shape) {
    case "rect": return TESSELLATION_UI[kind].editor.rectLabelRectangle ? m["field.shape.rectangle"]() : m["field.shape.rect"]();
    case "circle": return m["field.shape.circle"]();
    case "triangle": return m["field.shape.triangle"]();
    case "parallelogram": return m["field.shape.parallelogram"]();
    case "hexagon": return m["field.shape.hexagon"]();
    case "cylinder": return m["field.shape.cylinder"]();
    case "torus": return m["field.shape.torus"]();
    case "box": return m["field.shape.box"]();
    case "tetrahedron": return m["field.shape.tetrahedron"]();
    case "octahedron": return m["field.shape.octahedron"]();
    case "icosahedron": return m["field.shape.icosahedron"]();
  }
}

/** A rectangle, possibly glued into a cylinder or a torus: labelled and sized like a rectangle. */
function isRectLike(shape: PresetFieldShapeName): boolean {
  return shape === "rect" || shape === "cylinder" || shape === "torus";
}

/** The box side params, shown as one row of inputs under a single caption. */
const BOX_SIZES = ["width", "height", "depth"];

function paramLabel(kind: TessellationKind, shape: PresetFieldShapeName, name: string): string {
  switch (name) {
    case "cols": return isRectLike(shape) && TESSELLATION_UI[kind].editor.axisAlignedGrid ? m["field.width"]() : m["field.cols"]();
    case "rows": return isRectLike(shape) && TESSELLATION_UI[kind].editor.axisAlignedGrid ? m["field.height"]() : m["field.rows"]();
    case "radius": return m["field.radius"]();
    case "side": return m["field.side"]();
    case "width": return m["field.width"]();
    case "height": return m["field.height"]();
    case "depth": return m["field.depth"]();
    case "mode": return m["field.box.mode"]();
    case "net": return m["field.box.net"]();
    case "axis": return m["field.topology.axis"]();
    default: return name;
  }
}

/** Switch-like params (core publishes them as `0..max` integers) rendered as a select, not a number input. */
function paramChoices(tessellation: FieldConfig["tessellation"], shape: PresetFieldShapeName, name: string): { value: number; label: string }[] | null {
  if (shape === "cylinder") {
    return name === "axis" ? [
      { value: 0, label: m["field.topology.axis.left_right"]() },
      { value: 1, label: m["field.topology.axis.top_bottom"]() },
    ] : null;
  }
  const polyhedron = (POLYHEDRON_SHAPES as readonly string[]).includes(shape);
  if (shape !== "box" && !polyhedron) return null;
  if (name === "net" && polyhedron) return polyhedronNetChoices(tessellation, shape as PolyhedronShapeName);
  if (name === "mode") return [
    { value: 0, label: m["field.box.mode.net"]() },
    { value: 1, label: m["field.box.mode.faces"]() },
  ];
  if (name === "net") return [
    { value: 0, label: m["field.box.net.cross"]() },
    { value: 1, label: m["field.box.net.t"]() },
    { value: BOX_NET_COMPACT, label: m["field.box.net.compact"]() },
  ];
  return null;
}

/** The nets core offers (its `net` max counts them) with their captions, then the compact layout. */
function polyhedronNetChoices(tessellation: FieldConfig["tessellation"], shape: PolyhedronShapeName): { value: number; label: string }[] {
  const captions: Record<PolyhedronShapeName, string[]> = {
    tetrahedron: [m["field.polyhedron.net.star"](), m["field.polyhedron.net.strip"]()],
    octahedron: [m["field.polyhedron.net.wide"](), m["field.polyhedron.net.close"]()],
    icosahedron: [m["field.polyhedron.net.band"]()],
  };
  const count = polyhedronNetCount(tessellation, shape);
  return [
    ...Array.from({ length: count }, (_, value) => ({ value, label: captions[shape][value] ?? `#${value + 1}` })),
    { value: count, label: m["field.box.net.compact"]() },
  ];
}

/** Fallback upper bound of a size param in the editor — UI metadata, used when core publishes no `max`. */
function paramMax(kind: TessellationKind, shape: PresetFieldShapeName, name: string): number {
  if (name === "cols" || name === "rows") return 200;
  if (shape === "circle" || shape === "hexagon" || shape === "triangle") return SHAPE_PARAM_LIMITS[kind][shape];
  return 200;
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
  const countStr = totalCount > 0 ? ` · ${m["field.cell_count"]({ count: totalCount })}` : "";

  // One floor: its shape. Several floors: their count instead (the shapes may differ per floor).
  const lead = floorFields.length === 1
    ? floorShapeLabel(kind, floorFields[0])
    : m["field.floor_count"]({ count: floorFields.length });
  return `${lead}${countStr}`;
}

export function configCellCount(cfg: FieldConfig): number {
  const { shape } = cfg;
  const ui = TESSELLATION_UI[cfg.tessellation.kind].editor;
  switch (shape.shape) {
    case "custom": return 0;
    case "rect":
    case "cylinder":
    case "torus":
      return ui.rectCellsPerUnit === null ? configAllCells(cfg).length : ui.rectCellsPerUnit * shape.cols * shape.rows;
    case "parallelogram": return shape.cols * shape.rows;
    case "hexagon":
      return ui.hexagonCellCount === null ? configAllCells(cfg).length : ui.hexagonCellCount(shape.radius);
    case "triangle":
      return ui.triangleCellCount === null ? configAllCells(cfg).length : ui.triangleCellCount(shape.side);
    case "circle": return configAllCells(cfg).length;
    case "box": return 2 * (shape.width * shape.height + shape.height * shape.depth + shape.width * shape.depth);
    case "tetrahedron":
    case "octahedron":
    case "icosahedron": return polyhedronFaceCount(cfg.tessellation, shape.shape) * shape.side * shape.side;
  }
}

function configSizeLabel(cfg: FieldConfig): string {
  const { shape } = cfg;
  switch (shape.shape) {
    case "rect":
    case "cylinder":
    case "torus":
    case "parallelogram": return `${shape.cols}\u00D7${shape.rows}`;
    case "circle":
    case "hexagon": return `${m["field.radius"]()} ${shape.radius}`;
    case "triangle":
    case "tetrahedron":
    case "octahedron":
    case "icosahedron": return `${m["field.side"]()} ${shape.side}`;
    case "box": return `${shape.width} × ${shape.height} × ${shape.depth}`;
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
  truncated_hexagonal: { circle: 50, hexagon: 50, triangle: 50 },
  truncated_trihexagonal: { circle: 50, hexagon: 50, triangle: 50 },
  elongated_triangular: { circle: 50, hexagon: 50, triangle: 50 },
  snub_square: { circle: 50, hexagon: 50, triangle: 50 },
  curved_quadrilateral: { circle: 50, hexagon: 50, triangle: 50 },
  // Radial publishes its circle radius limit through core (it depends on the tessellation params).
  radial: { circle: 50, hexagon: 50, triangle: 50 },
  // Voronoi too: the circle radius limit comes from core.
  voronoi: { circle: 50, hexagon: 50, triangle: 50 },
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
  infoText: { ...typography.body, ...muted(typography.body) },
};
