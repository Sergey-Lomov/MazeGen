import type React from "react";
import type { GlueTabStyle } from "../../store/imageExportTypes";
import { indent, spacing } from "../../styles/theme";
import { GLUE_TAB_INSET_RANGE, GLUE_TAB_LINE_WIDTH_RANGE, GLUE_TAB_WIDTH_RANGE } from "../../pixi/renderConstants";
import { SectionHeader } from "../SectionHeader";
import { useGate } from "./LinkContext";
import { LinkedColorRow, LinkedSelectRow, LinkedSliderRow, LinkedToggleRow } from "./LinkedRows";
import { PC, type ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import * as m from "~/paraglide/messages";

/** The "Glue tabs" subsection of the "Topology" section (GitHub issue #901): whether the trapezoidal glue tabs show on the
 * image, how far they start from the ends of the edge, how wide they are and how they are filled and outlined (the colours follow
 * the background and the outer grid until edited). The parent shows it only for a floor that has
 * glues. Both render modes use it as is. */
export function GlueTabSettingsSubsection({ expanded, onToggle, style, defaults, priorityColors, onChange }: {
  expanded: boolean;
  onToggle: () => void;
  style: GlueTabStyle;
  defaults: GlueTabStyle;
  priorityColors: ProjectColorEntry[];
  onChange: (patch: Partial<GlueTabStyle>) => void;
}) {
  const tabsOn = useGate("glueTabs");
  const outlineOn = useGate("glueTabLine");
  return (
    <>
      <SectionHeader label={m["image_export.glue_tabs.title"]()} expanded={expanded} onToggle={onToggle} />
      {expanded && (
        <div style={styles.block}>
          <LinkedToggleRow label={m["image_export.glue_tabs.show"]()} checked={style.showTabs} onChange={(showTabs) => onChange({ showTabs })} linkTarget="glueTabs.showTabs" />
          {tabsOn && (
            <>
              <LinkedSliderRow label={m["image_export.glue_tabs.inset"]()} value={style.inset} onChange={(inset) => onChange({ inset })} min={GLUE_TAB_INSET_RANGE.min} max={GLUE_TAB_INSET_RANGE.max} step={1} format={(v) => String(v)} linkTarget="glueTabs.inset" />
              <LinkedSliderRow label={m["image_export.glue_tabs.width"]()} value={style.width} onChange={(width) => onChange({ width })} min={GLUE_TAB_WIDTH_RANGE.min} max={GLUE_TAB_WIDTH_RANGE.max} step={1} format={(v) => String(v)} linkTarget="glueTabs.width" />
              <LinkedToggleRow label={m["image_export.glue_tabs.alternate"]()} checked={style.alternate} onChange={(alternate) => onChange({ alternate })} linkTarget="glueTabs.alternate" />
              <LinkedColorRow label={m["image_export.glue_tabs.fill_color"]()} color={style.fillColor} onChange={(fillColor) => onChange({ fillColor })} defaultColor={defaults.fillColor} field={PC.glueTabFill} priorityColors={priorityColors} linkTarget="glueTabs.fillColor" />
              <LinkedSliderRow label={m["image_export.glue_tabs.line_width"]()} value={style.lineWidth} onChange={(lineWidth) => onChange({ lineWidth })} min={GLUE_TAB_LINE_WIDTH_RANGE.min} max={GLUE_TAB_LINE_WIDTH_RANGE.max} step={1} format={(v) => String(v)} linkTarget="glueTabs.lineWidth" />
              {outlineOn && (
                <>
                  <LinkedSelectRow
                    label={m["image_export.glue_tabs.line_style"]()}
                    value={style.lineStyle}
                    options={[
                      { value: "dashed", label: m["image_export.glue_tabs.line_style_dashed"]() },
                      { value: "solid", label: m["image_export.glue_tabs.line_style_solid"]() },
                    ]}
                    onChange={(lineStyle) => onChange({ lineStyle })}
                    linkTarget="glueTabs.lineStyle"
                  />
                  <LinkedColorRow label={m["image_export.glue_tabs.line_color"]()} color={style.lineColor} onChange={(lineColor) => onChange({ lineColor })} defaultColor={defaults.lineColor} field={PC.glueTabLine} priorityColors={priorityColors} linkTarget="glueTabs.lineColor" />
                </>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
};
