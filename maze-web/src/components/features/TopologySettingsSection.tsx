import type React from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { CutLineStyleFields } from "../../store/imageExportTypes";
import type { ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { PC } from "../../pixi/selectors/projectColorsSelector";
import { indent, spacing, ui } from "../../styles/theme";
import { SectionHeader } from "../SectionHeader";
import { LinkedColorRow, LinkedToggleRow } from "./LinkedRows";
import * as m from "~/paraglide/messages";

/** The "Topology" section of a render mode's settings (GitHub issue #859): how the cut lines are drawn on the image.
 * Shown only for a floor that has glues. Both render modes use it as is, each with its own store actions. */
export function TopologySettingsSection({ expanded, onToggle, style, defaultColor, priorityColors, onShow, onGlueColor, onColor }: {
  expanded: boolean;
  onToggle: () => void;
  style: CutLineStyleFields;
  defaultColor: number;
  /** Sibling colours pinned at the top of the colour picker: background, corridor/floor, walls, outer grid. */
  priorityColors: ProjectColorEntry[];
  onShow: (show: boolean) => void;
  onGlueColor: (glueColor: boolean) => void;
  onColor: (color: number) => void;
}) {
  const hasGlues = useMazeStore((s) => (s.floorTopology[s.activeFloorId]?.groups.length ?? 0) > 0);
  if (!hasGlues) return null;
  return (
    <>
      <div style={styles.divider} />
      <SectionHeader label={m["topology.title"]()} expanded={expanded} onToggle={onToggle} />
      {expanded && (
        <div style={styles.block}>
          <LinkedToggleRow label={m["image_export.topology.show_cut_lines"]()} checked={style.showCutLines} onChange={onShow} linkTarget="showCutLines" />
          {style.showCutLines && (
            <LinkedToggleRow label={m["image_export.topology.cut_lines_glue_color"]()} checked={style.cutLinesGlueColor} onChange={onGlueColor} linkTarget="cutLinesGlueColor" />
          )}
          {style.showCutLines && !style.cutLinesGlueColor && (
            <LinkedColorRow
              label={m["image_export.topology.cut_lines_color"]()}
              color={style.cutLinesColor}
              onChange={onColor}
              defaultColor={defaultColor}
              field={PC.cutLines}
              priorityColors={priorityColors}
              linkTarget="cutLinesColor"
            />
          )}
        </div>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
};
