import { useState, type CSSProperties } from "react";
import type { FloorLabelSettings } from "../../store/storeTypes";
import type { ColorField, ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { indent, spacing } from "../../styles/theme";
import { LinkedColorRow, LinkedSelectRow, LinkedSliderRow, LinkedTextFieldRow, LinkedToggleRow } from "./LinkedRows";
import { FLOOR_LABEL_TEXT_SIZE_RANGE, FLOOR_LABEL_WIDTH_RANGE, TEXT_MARGIN_RANGE } from "../../pixi/renderConstants";
import { SubsectionHeader } from "../SectionHeader";
import { AutoFitButton } from "./TextFitContext";
import * as m from "~/paraglide/messages";

export function FloorLabelSection<P extends string>({ settings, onChange, fields, defaults, priorities }: {
  settings: FloorLabelSettings;
  onChange: (patch: Partial<FloorLabelSettings>) => void;
  fields: { fill: ColorField; border: ColorField; text: ColorField };
  defaults: { fill: number; border: number; text: number };
  priorities: { fill?: ProjectColorEntry[]; border?: ProjectColorEntry[]; text?: ProjectColorEntry[] };
}) {
  const [expanded, setExpanded] = useState({ label: true, backplate: true });
  const toggle = (key: keyof typeof expanded) => setExpanded((value) => ({ ...value, [key]: !value[key] }));

  return (
    <div style={styles.block}>
      <LinkedToggleRow label={m["image_export.floors.show"]()} checked={settings.enabled} onChange={(enabled) => onChange({ enabled })} linkTarget={"floorLabel.enabled" as P} />
      {settings.enabled && (
        <>
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

const styles: Record<string, CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  group: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
};

function clamp(value: number | null, min: number, max: number): number | null {
  return value === null ? null : Math.min(max, Math.max(min, value));
}
