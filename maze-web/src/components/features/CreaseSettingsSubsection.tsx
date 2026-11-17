import type React from "react";
import type { CreaseExportStyle } from "../../store/imageExportTypes";
import { indent, spacing } from "../../styles/theme";
import { CREASE_LINE_WIDTH_RANGE, CREASE_MARK_SIZE_RANGE, CREASE_MARK_TIP_LENGTH_RANGE } from "../../pixi/renderConstants";
import { SectionHeader } from "../SectionHeader";
import { useGate } from "./LinkContext";
import { LinkedSelectRow, LinkedSliderRow, LinkedToggleRow, LinkedUnregisteredColorRow } from "./LinkedRows";
import type { ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import * as m from "~/paraglide/messages";

/** The "Creases" subsection of the "Topology" section (GitHub issue #900): whether the topological crease lines show on
 * the image and how (lines or marks). The parent shows it only for a floor that has creases. Both render modes use it as is. */
export function CreaseSettingsSubsection({ expanded, onToggle, style, defaultColor, priorityColors, onChange }: {
  expanded: boolean;
  onToggle: () => void;
  style: CreaseExportStyle;
  defaultColor: number;
  priorityColors: ProjectColorEntry[];
  onChange: (patch: Partial<CreaseExportStyle>) => void;
}) {
  const shown = useGate("creaseShown");
  const lines = useGate("creaseLines");
  const marks = useGate("creaseMarks");
  return (
    <>
      <SectionHeader label={m["image_export.creases.title"]()} expanded={expanded} onToggle={onToggle} />
      {expanded && (
        <div style={styles.block}>
          <LinkedToggleRow label={m["image_export.creases.show"]()} checked={style.showCreases} onChange={(showCreases) => onChange({ showCreases })} linkTarget="creases.showCreases" />
          {shown && (
            <LinkedSelectRow
              label={m["image_export.creases.mode"]()}
              value={style.mode}
              options={[
                { value: "lines", label: m["image_export.creases.mode_lines"]() },
                { value: "marks", label: m["image_export.creases.mode_marks"]() },
              ]}
              onChange={(mode) => onChange({ mode })}
              linkTarget={null}
            />
          )}
          {lines && (
            <>
              <LinkedSelectRow
                label={m["image_export.creases.line_style"]()}
                value={style.lineStyle}
                options={[
                  { value: "dashed", label: m["image_export.creases.line_style_dashed"]() },
                  { value: "solid", label: m["image_export.creases.line_style_solid"]() },
                ]}
                onChange={(lineStyle) => onChange({ lineStyle })}
                linkTarget="creases.lineStyle"
              />
              <LinkedSliderRow label={m["image_export.creases.line_width"]()} value={style.lineWidth} onChange={(lineWidth) => onChange({ lineWidth })} min={CREASE_LINE_WIDTH_RANGE.min} max={CREASE_LINE_WIDTH_RANGE.max} step={1} format={(v) => String(v)} linkTarget="creases.lineWidth" />
            </>
          )}
          {marks && (
            <>
              <LinkedSliderRow label={m["image_export.creases.mark_size"]()} value={style.markSize} onChange={(markSize) => onChange({ markSize })} min={CREASE_MARK_SIZE_RANGE.min} max={CREASE_MARK_SIZE_RANGE.max} step={1} format={(v) => String(v)} linkTarget="creases.markSize" />
              <LinkedSliderRow label={m["image_export.creases.mark_tip_length"]()} value={style.markTipLength} onChange={(markTipLength) => onChange({ markTipLength })} min={CREASE_MARK_TIP_LENGTH_RANGE.min} max={CREASE_MARK_TIP_LENGTH_RANGE.max} step={1} format={(v) => String(v)} linkTarget="creases.markTipLength" />
            </>
          )}
          {lines && (
            <LinkedUnregisteredColorRow label={m["image_export.creases.color"]()} color={style.color} onChange={(color) => onChange({ color })} defaultColor={defaultColor} priorityColors={priorityColors} linkTarget="creases.color" />
          )}
          {marks && (
            <LinkedUnregisteredColorRow label={m["image_export.creases.mark_color"]()} color={style.markColor} onChange={(markColor) => onChange({ markColor })} defaultColor={defaultColor} priorityColors={priorityColors} linkTarget="creases.markColor" />
          )}
        </div>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
};
