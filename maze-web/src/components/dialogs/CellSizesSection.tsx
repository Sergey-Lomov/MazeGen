import React from "react";
import { Stack } from "../Layout";
import { WarningIcon } from "../WarningIcon";
import { indent, spacing, typography, ui } from "../../styles/theme";
import { hasIrregularType, hasTooSmallSide, MIN_COMFORTABLE_CELL_SIDE_MM, type PrintCellTypeSize } from "../../pixi/printCellSizes";
import { cellTypeLabel } from "../../i18n/cellTypeLabel";
import type { TessellationKind } from "../../fieldConfig";
import * as m from "~/paraglide/messages";
import { PLACEHOLDER, ValueSkeleton, VALUE_SLOT, withValueNode } from "./valueSlot";

/** The cells of each cell type with their printed sides and diameter (GitHub issue #948). Cells that
 * differ in size within a type get an explanation of what the entered size means instead of numbers.
 * Without `sizes` (not calculated yet, or no usable size) and with `placeholderTypes`, the section
 * keeps the layout of the answer, with `—` for the numbers (GitHub issue #961). */
export function CellSizesSection({ sizes, tessellationKind, placeholderTypes, cellsVary = false, loading = false }: {
  sizes: PrintCellTypeSize[];
  tessellationKind: TessellationKind;
  placeholderTypes?: string[];
  /** Core says the cells of a type differ in size (`tessellation_cell_types`): the explanation stands in before any answer. */
  cellsVary?: boolean;
  /** The numbers are being recalculated: they give way to indicators, the type names stay. */
  loading?: boolean;
}) {
  if (sizes.length === 0 && !placeholderTypes) return null;
  const mark = loading ? <ValueSkeleton width="3em" /> : PLACEHOLDER;
  const markedSide = withValueNode(m["field.print_sizing.cell_sizes_side_value"]({ value: VALUE_SLOT }), mark);
  const markedDiameter = withValueNode(m["field.print_sizing.cell_sizes_diameter_value"]({ value: VALUE_SLOT }), mark);
  // While recalculating, the rows of the answer on screen stay; the types of the tessellation stand in before any answer.
  const markedTypes = sizes.length > 0 ? sizes.map((type) => type.key) : placeholderTypes ?? [];
  // Cells that differ in size have no sides or diameter to list: only the explanation is shown.
  if (hasIrregularType(sizes) || (sizes.length === 0 && cellsVary)) {
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
  if (markedTypes.length === 0) return null;
  const title = m["field.print_sizing.cell_sizes_title"]();
  return (
    <>
      <div style={styles.divider} />
      <Stack gap="elementsGap">
        <span style={styles.sectionLabel}>{title}</span>
        <div style={styles.cellSizeTable}>
          {sizes.length === 0 || loading ? (
            markedTypes.map((key) => (
              <div key={key} style={styles.floorRow}>
                <span>{cellTypeLabel(key)}</span>
                <span>{markedSide}</span>
                <span>{markedDiameter}</span>
              </div>
            ))
          ) : (
            sizes.map((type) => (
              <div key={type.key} style={styles.floorRow}>
                <span>{cellTypeLabel(type.key)}</span>
                <span>{type.regular ? <SideValue type={type} /> : "-"}</span>
                <span>{type.regular ? diameterText(type) : "-"}</span>
              </div>
            ))
          )}
        </div>
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
