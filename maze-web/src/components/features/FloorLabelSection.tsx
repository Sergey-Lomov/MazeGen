import { useMemo, useState, type CSSProperties } from "react";
import { FLOOR_LABEL_ANCHORS, type FloorLabelAnchor, type FloorLabelPosition, type FloorLabelSettings, type RenderModeId } from "../../store/storeTypes";
import { useMazeStore } from "../../store/mazeStore";
import type { ColorField, ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { indent, spacing, typography } from "../../styles/theme";
import { LinkedColorRow, LinkedSelectRow, LinkedSliderRow, LinkedTextFieldRow, LinkedToggleRow } from "./LinkedRows";
import { FLOOR_LABEL_TEXT_SIZE_RANGE, FLOOR_LABEL_WIDTH_RANGE, TEXT_MARGIN_RANGE } from "../../pixi/renderConstants";
import { SubsectionHeader } from "../SectionHeader";
import { AutoFitButton } from "./TextFitContext";
import { TextInput } from "../TextInput";
import { Button } from "../Button";
import { sharedStyles } from "../../styles/shared";
import { exactCellBounds } from "../../pixi/tessellationGeometry";
import { selectFloorScopedMaze } from "../../pixi/selectors/mazeSelectors";
import { convertFloorLabelPosition } from "../../pixi/renderers/FloorLabelRenderer";
import * as m from "~/paraglide/messages";

export function FloorLabelSection<P extends string>({ renderMode, settings, onChange, fields, defaults, priorities, activeFloorId, activeFloorTitle, floorIds }: {
  renderMode: RenderModeId;
  settings: FloorLabelSettings;
  onChange: (patch: Partial<FloorLabelSettings>) => void;
  fields: { fill: ColorField; border: ColorField; text: ColorField };
  defaults: { fill: number; border: number; text: number };
  priorities: { fill?: ProjectColorEntry[]; border?: ProjectColorEntry[]; text?: ProjectColorEntry[] };
  activeFloorId: string;
  activeFloorTitle: string;
  floorIds: readonly string[];
}) {
  const floorLabelDrag = useMazeStore((state) => state.floorLabelDrag);
  const startFloorLabelDrag = useMazeStore((state) => state.startFloorLabelDrag);
  const finishFloorLabelDrag = useMazeStore((state) => state.finishFloorLabelDrag);
  const nodes = useMazeStore((state) => state.nodes);
  const floors = useMazeStore((state) => state.floors);
  const cfg = useMazeStore((state) => state.activeTessellationConfig);
  const bounds = useMemo(
    () => exactCellBounds(selectFloorScopedMaze(nodes, [], floors, activeFloorId).nodes, cfg),
    [nodes, floors, activeFloorId, cfg],
  );
  const [expanded, setExpanded] = useState({ position: true, label: true, backplate: true });
  const toggle = (key: keyof typeof expanded) => setExpanded((value) => ({ ...value, [key]: !value[key] }));
  const position = settings.positionsByFloorId[activeFloorId] ?? { mode: "anchored", anchor: "center" };
  const patchPosition = (next: FloorLabelPosition) => onChange({
    positionsByFloorId: { ...settings.positionsByFloorId, [activeFloorId]: next },
  });
  const copyPositionToAllFloors = () => onChange({
    positionsByFloorId: Object.fromEntries(floorIds.map((floorId) => [floorId, clonePosition(position)])),
  });
  const dragging = floorLabelDrag?.renderMode === renderMode && floorLabelDrag.floorId === activeFloorId;

  return (
    <div style={styles.block}>
      <LinkedToggleRow label={m["image_export.floors.show"]()} checked={settings.enabled} onChange={(enabled) => onChange({ enabled })} linkTarget={"floorLabel.enabled" as P} />
      {settings.enabled && (
        <>
          <SubsectionHeader label={m["image_export.floors.position_subsection"]({ floor: activeFloorTitle })} expanded={expanded.position} onToggle={() => toggle("position")} />
          {expanded.position && <div style={styles.group}>
            <LinkedSelectRow
              label={m["image_export.floors.position_mode"]()}
              value={position.mode}
              options={[
                { value: "anchored", label: m["image_export.floors.position_anchored"]() },
                { value: "cell", label: m["image_export.floors.position_cell"]() },
                { value: "free", label: m["image_export.floors.position_free"]() },
              ]}
              onChange={(mode) => patchPosition(convertFloorLabelPosition(settings, activeFloorId, mode, bounds, cfg))}
              linkTarget={null}
            />
            {position.mode === "anchored" && <LinkedSelectRow
              label={m["image_export.floors.anchor"]()}
              value={position.anchor}
              options={anchorOptions()}
              onChange={(anchor) => patchPosition({ mode: "anchored", anchor })}
              linkTarget={null}
            />}
            {position.mode === "cell" && <CoordinatesRow x={position.cell[0]} y={position.cell[1]} onChange={(x, y) => patchPosition({ ...position, cell: [x, y] })} />}
            {position.mode === "free" && <CoordinatesRow x={position.x} y={position.y} onChange={(x, y) => patchPosition({ ...position, x, y })} />}
            {position.mode !== "anchored" && <Button
              variant={dragging ? "toggle-selected" : "secondary"}
              layoutStyle={{ width: "100%" }}
              data-floor-label-drag-control
              onClick={() => dragging ? finishFloorLabelDrag() : startFloorLabelDrag(renderMode)}
            >{dragging ? m["image_export.floors.finish_drag"]() : m["image_export.floors.drag_position"]()}</Button>}
            <Button variant="secondary" layoutStyle={{ width: "100%" }} onClick={copyPositionToAllFloors}>{m["image_export.floors.copy_position_to_all"]()}</Button>
          </div>}
          <SubsectionHeader label={m["image_export.floors.label_subsection"]()} expanded={expanded.label} onToggle={() => toggle("label")} />
          {expanded.label && <div style={styles.group}>
            <LinkedTextFieldRow label={m["image_export.floors.prefix"]()} value={settings.prefix} onChange={(prefix) => onChange({ prefix })} linkTarget={null} inputWidth={120} />
            <LinkedSelectRow
              label={m["image_export.floors.label"]()}
              value={settings.labelType}
              options={[
                { value: "arabic", label: m["image_export.vector_by_walls.elevator_badges_label_type_arabic"]() },
                { value: "roman", label: m["image_export.vector_by_walls.elevator_badges_label_type_roman"]() },
                { value: "letters", label: m["image_export.vector_by_walls.elevator_badges_label_type_letters"]() },
              ]}
              onChange={(labelType) => onChange({ labelType })}
              linkTarget={"floorLabel.labelType" as P}
            />
            <LinkedSelectRow
              label={m["image_export.floors.weight"]()}
              value={settings.textFontWeight}
              options={[
                { value: "regular", label: m["image_export.vector_by_walls.elevator_badges_font_weight_regular"]() },
                { value: "bold", label: m["image_export.vector_by_walls.elevator_badges_font_weight_bold"]() },
              ]}
              onChange={(textFontWeight) => onChange({ textFontWeight })}
              linkTarget={"floorLabel.textFontWeight" as P}
            />
            <LinkedSelectRow
              label={m["image_export.floors.alignment"]()}
              value={settings.textAlignment}
              options={[
                { value: "left", label: m["image_export.floors.alignment_left"]() },
                { value: "center", label: m["image_export.floors.alignment_center"]() },
                { value: "right", label: m["image_export.floors.alignment_right"]() },
              ]}
              onChange={(textAlignment) => onChange({ textAlignment })}
              linkTarget={null}
            />
            <LinkedSliderRow label={m["image_export.floors.size"]()} value={settings.textSize} onChange={(textSize) => onChange({ textSize })} min={FLOOR_LABEL_TEXT_SIZE_RANGE.min} max={FLOOR_LABEL_TEXT_SIZE_RANGE.max} step={FLOOR_LABEL_TEXT_SIZE_RANGE.step} format={String} linkTarget={"floorLabel.textSize" as P} trailingAction={<AutoFitButton resolve={(ctx) => ctx.fitFor("floorLabel")} onApply={(textSize) => onChange({ textSize })} />} />
            <LinkedSliderRow label={m["image_export.floors.padding"]()} value={settings.textMargin} onChange={(textMargin) => onChange({ textMargin })} min={TEXT_MARGIN_RANGE.min} max={TEXT_MARGIN_RANGE.max} step={TEXT_MARGIN_RANGE.step} format={String} linkTarget={"floorLabel.textMargin" as P} />
            <LinkedColorRow label={m["image_export.floors.text_color"]()} color={settings.textColor} onChange={(textColor) => onChange({ textColor })} field={fields.text} defaultColor={defaults.text} priorityColors={priorities.text} linkTarget={"floorLabel.textColor" as P} />
          </div>}
          <SubsectionHeader label={m["image_export.floors.background_subsection"]()} expanded={expanded.backplate} onToggle={() => toggle("backplate")} />
          {expanded.backplate && <div style={styles.group}>
            <LinkedSelectRow
              label={m["image_export.floors.shape"]()}
              value={settings.backgroundShape}
              options={[
                { value: "none", label: m["image_export.floors.shape_none"]() },
                { value: "rectangle", label: m["image_export.floors.shape_rectangle"]() },
                { value: "parallelogram", label: m["image_export.floors.shape_parallelogram"]() },
              ]}
              onChange={(backgroundShape) => onChange({ backgroundShape })}
              linkTarget={null}
            />
            {settings.backgroundShape !== "none" && (
              <>
                <LinkedSliderRow label={m["image_export.floors.width"]()} value={settings.width} onChange={(width) => onChange({ width: Math.round(width) })} min={FLOOR_LABEL_WIDTH_RANGE.min} max={FLOOR_LABEL_WIDTH_RANGE.max} step={FLOOR_LABEL_WIDTH_RANGE.step} format={String} linkTarget={"floorLabel.width" as P} trailingAction={<AutoFitButton resolve={(ctx) => clamp(ctx.fitFloorLabelWidth(), FLOOR_LABEL_WIDTH_RANGE.min, FLOOR_LABEL_WIDTH_RANGE.max)} onApply={(width) => onChange({ width })} />} />
                <LinkedSliderRow label={m["image_export.floors.height"]()} value={settings.height} onChange={(height) => onChange({ height: Math.round(height) })} min={16} max={100} step={1} format={String} linkTarget={"floorLabel.height" as P} trailingAction={<AutoFitButton resolve={(ctx) => clamp(ctx.fitFloorLabelHeight(), 16, 100)} onApply={(height) => onChange({ height })} />} />
                <LinkedSliderRow label={m["image_export.floors.corner_radius"]()} value={settings.cornerRadius} onChange={(cornerRadius) => onChange({ cornerRadius })} min={0} max={20} step={1} format={String} linkTarget={"floorLabel.cornerRadius" as P} />
                <LinkedSliderRow label={m["image_export.floors.gap"]()} value={settings.gap} onChange={(gap) => onChange({ gap })} min={0} max={30} step={1} format={String} linkTarget={"floorLabel.gap" as P} />
                <LinkedSliderRow label={m["image_export.floors.border_width"]()} value={settings.borderWidth} onChange={(borderWidth) => onChange({ borderWidth })} min={0} max={10} step={1} format={String} linkTarget={"floorLabel.borderWidth" as P} />
                <LinkedColorRow label={m["image_export.floors.color"]()} color={settings.fillColor} onChange={(fillColor) => onChange({ fillColor })} field={fields.fill} defaultColor={defaults.fill} priorityColors={priorities.fill} linkTarget={"floorLabel.fillColor" as P} />
                <LinkedColorRow label={m["image_export.floors.border_color"]()} color={settings.borderColor} onChange={(borderColor) => onChange({ borderColor })} field={fields.border} defaultColor={defaults.border} priorityColors={priorities.border} linkTarget={"floorLabel.borderColor" as P} />
              </>
            )}
          </div>}
        </>
      )}
    </div>
  );
}

function CoordinatesRow({ x, y, onChange }: { x: number; y: number; onChange: (x: number, y: number) => void }) {
  const isValid = (raw: string) => /^-?\d+$/.test(raw);
  return <div style={styles.coordinates}>
    <span style={styles.coordinatesLabel}>{m["image_export.floors.coordinates"]()}</span>
    <span style={styles.axis}>X</span>
    <TextInput aria-label="X" value={String(Math.trunc(x))} normalize={integerPart} isValid={isValid} onChange={(raw) => onChange(Number(raw), y)} style={styles.coordinateInput} />
    <span style={styles.axis}>Y</span>
    <TextInput aria-label="Y" value={String(Math.trunc(y))} normalize={integerPart} isValid={isValid} onChange={(raw) => onChange(x, Number(raw))} style={styles.coordinateInput} />
  </div>;
}

function integerPart(raw: string): string {
  const separator = raw.search(/[.,]/);
  return separator < 0 ? raw : raw.slice(0, separator);
}

function clonePosition(position: FloorLabelPosition): FloorLabelPosition {
  return position.mode === "cell" ? { ...position, cell: [position.cell[0], position.cell[1]] } : { ...position };
}

function anchorOptions(): { value: FloorLabelAnchor; label: string }[] {
  return FLOOR_LABEL_ANCHORS.map((value) => ({ value, label: anchorLabel(value) }));
}

function anchorLabel(anchor: FloorLabelAnchor): string {
  switch (anchor) {
    case "top_left": return m["image_export.floors.anchor_top_left"]();
    case "top_center": return m["image_export.floors.anchor_top_center"]();
    case "top_right": return m["image_export.floors.anchor_top_right"]();
    case "center_left": return m["image_export.floors.anchor_center_left"]();
    case "center": return m["image_export.floors.anchor_center"]();
    case "center_right": return m["image_export.floors.anchor_center_right"]();
    case "bottom_left": return m["image_export.floors.anchor_bottom_left"]();
    case "bottom_center": return m["image_export.floors.anchor_bottom_center"]();
    case "bottom_right": return m["image_export.floors.anchor_bottom_right"]();
  }
}

const styles: Record<string, CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  group: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  coordinates: { display: "flex", alignItems: "center", gap: spacing.elementsGap },
  coordinatesLabel: { ...typography.body, flex: 1 },
  axis: { ...typography.body },
  coordinateInput: { ...sharedStyles.textFieldSm, width: 52, minWidth: 0, flex: "0 0 52px" },
};

function clamp(value: number | null, min: number, max: number): number | null {
  return value === null ? null : Math.min(max, Math.max(min, value));
}
