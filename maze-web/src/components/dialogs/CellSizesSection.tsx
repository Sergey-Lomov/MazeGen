import React from "react";
import { Stack } from "../Layout";
import { WarningIcon } from "../WarningIcon";
import { indent, spacing, typography, ui } from "../../styles/theme";
import { hasIrregularType, hasTooSmallSide, MIN_COMFORTABLE_CELL_SIDE_MM, type PrintCellTypeSize } from "../../pixi/printCellSizes";
import { cellTypeLabel } from "../../i18n/cellTypeLabel";
import * as m from "~/paraglide/messages";

/** The cells of each cell type with their printed sides and diameter (GitHub issue #948). Cells that
 * differ in size within a type get an explanation of what the entered size means instead of numbers. */
export function CellSizesSection({ sizes, tessellationKind }: { sizes: PrintCellTypeSize[]; tessellationKind: string }) {
  if (sizes.length === 0) return null;
  // Cells that differ in size have no sides or diameter to list: only the explanation is shown.
  if (hasIrregularType(sizes)) {
    return (
      <>
        <div style={styles.divider} />
        <span style={typography.body}>
          {/* A radial field's entered size is the thickness of a ring, not an average cell. */}
          {(tessellationKind === "radial" ? m["field.print_sizing.cell_sizes_irregular_radial"] : m["field.print_sizing.cell_sizes_irregular"])()}
        </span>
      </>
    );
  }
  const [only] = sizes;
  return (
    <>
      <div style={styles.divider} />
      <Stack gap="elementsGap">
        <span style={styles.sectionLabel}>{m["field.print_sizing.cell_sizes_title"]()}</span>
        {sizes.length === 1 ? (
          only.regular && (
            <span style={typography.body}>
              <SideValue type={only} />, {diameterText(only)}
            </span>
          )
        ) : (
          <div style={styles.cellSizeTable}>
            {sizes.map((type) => (
              <div key={type.key} style={styles.floorRow}>
                <span>{cellTypeLabel(type.key)}</span>
                <span>{type.regular ? <SideValue type={type} /> : "-"}</span>
                <span>{type.regular ? diameterText(type) : "-"}</span>
              </div>
            ))}
          </div>
        )}
      </Stack>
    </>
  );
}

/** Cell counts by type, e.g. `Triangle 600, Square 300`; empty for a single type, which the total already is. */
export function typeBreakdown(sizes: PrintCellTypeSize[]): string {
  if (sizes.length < 2) return "";
  return sizes.map((type) => `${cellTypeLabel(type.key)} ${type.count}`).join(", ");
}

/** The prefixed side text of a type; orange with a warning icon beside it when the side is too small. */
function SideValue({ type }: { type: PrintCellTypeSize }) {
  const text = (type.sidesMm.length === 1 ? m["field.print_sizing.cell_sizes_side_value"] : m["field.print_sizing.cell_sizes_sides_value"])({
    value: formatLengths(type.sidesMm),
  });
  if (!hasTooSmallSide(type)) return <>{text}</>;
  return (
    <span style={styles.smallSide}>
      {text} <WarningIcon title={m["field.print_sizing.warning_small_side_hint"]({ min: String(MIN_COMFORTABLE_CELL_SIDE_MM) })} />
    </span>
  );
}

function diameterText(type: PrintCellTypeSize): string {
  return m["field.print_sizing.cell_sizes_diameter_value"]({ value: formatLengths([type.diameterMm]) });
}

function formatLengths(lengthsMm: number[]): string {
  return lengthsMm.map((length) => length.toFixed(1)).join(" / ");
}

const styles: Record<string, React.CSSProperties> = {
  sectionLabel: typography.body,
  divider: { borderTop: `1px solid ${ui.border.default}` },
  floorRow: { display: "contents" },
  cellSizeTable: {
    display: "grid",
    gridTemplateColumns: "max-content max-content max-content",
    rowGap: spacing.itemGap,
    columnGap: spacing.tableColumnsGap,
    paddingLeft: indent.tree,
    whiteSpace: "nowrap",
    ...typography.body,
  },
  smallSide: { color: ui.text.warning },
};
