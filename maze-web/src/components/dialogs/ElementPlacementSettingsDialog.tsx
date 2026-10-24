import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { Switch } from "../Switch";
import { WarningBubble } from "../WarningBubble";
import { ui, radius, spacing, typography, dialogSpacing, inset } from "../../styles/theme";
import { cellTypeLabel, generatedElementLabel } from "../../i18n/cellTypeLabel";
import type { ElementCellTypeRestrictions, GeneratedElementKind } from "../../wasm/types";
import * as m from "~/paraglide/messages";

interface Props {
  cellTypes: string[];
  multiFloor: boolean;
  onClose: () => void;
}

const baseElementKinds: GeneratedElementKind[] = ["start", "finish", "one_way", "teleport", "split"];

const verticalElementKinds: GeneratedElementKind[] = ["vertical_passage", "elevator"];

const elementColumnWidth = 170;
const cellTypeColumnWidth = 136;
const dialogHorizontalPadding = 28;

export function elementPlacementDialogWidth(cellTypeCount: number): number {
  return dialogHorizontalPadding + elementColumnWidth + cellTypeCount * cellTypeColumnWidth;
}

/** Matrix of generated elements by tessellation cell type. Missing entries intentionally mean
 * allowed, which keeps old projects and newly introduced cell types permissive by default. */
export function ElementPlacementSettingsDialog({ cellTypes, multiFloor, onClose }: Props) {
  const restrictions = useMazeStore((s) => s.elementsConfig.cell_type_restrictions);
  const setRestrictions = useMazeStore((s) => s.setElementCellTypeRestrictions);
  const [draftRestrictions, setDraftRestrictions] = useState<ElementCellTypeRestrictions | undefined>(restrictions);
  const elementKinds = multiFloor ? [...baseElementKinds, ...verticalElementKinds] : baseElementKinds;
  const visibleKinds = elementKinds;
  const preferredWidth = elementPlacementDialogWidth(cellTypes.length);
  const elementsWithoutAllowedCells = elementKinds.filter((element) =>
    !cellTypes.some((cellType) => draftRestrictions?.[element]?.[cellType] !== false)
  );

  function setAllowed(element: GeneratedElementKind, cellType: string, allowed: boolean) {
    setDraftRestrictions((current) => ({
      ...current,
      [element]: { ...current?.[element], [cellType]: allowed },
    }));
  }

  function setColumnAllowed(cellType: string, allowed: boolean) {
    setDraftRestrictions((current) => ({
      ...current,
      ...Object.fromEntries(visibleKinds.map((element) => [
        element, { ...current?.[element], [cellType]: allowed },
      ])),
    }));
  }

  function confirm() {
    setRestrictions(draftRestrictions);
    onClose();
  }

  return (
    <Modal
      title={m["generation.element_placement_title"]()}
      size="info"
      layoutStyle={{ minWidth: 0, width: preferredWidth, maxWidth: "calc(100vw - 32px)" }}
      onClose={onClose}
      onConfirm={confirm}
    >
      <div style={styles.body}>
        <p style={styles.hint}>{m["generation.element_placement_hint"]()}</p>
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={{ ...styles.header, ...styles.elementHeader }}>{m["generation.element"]()}</th>
                {cellTypes.map((cellType) => {
                  const label = cellTypeLabel(cellType);
                  return (
                    <th key={cellType} style={styles.header}>{label}</th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {elementKinds.map((element) => (
                <tr key={element}>
                  <th scope="row" style={styles.rowHeader}>{generatedElementLabel(element)}</th>
                  {cellTypes.map((cellType) => {
                    const allowed = draftRestrictions?.[element]?.[cellType] !== false;
                    return (
                      <td key={cellType} style={styles.cell}>
                        <Switch
                          ariaLabel={`${generatedElementLabel(element)} ${cellTypeLabel(cellType)}`}
                          checked={allowed}
                          onChange={(value) => setAllowed(element, cellType, value)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th style={styles.footerHeader} />
                {cellTypes.map((cellType) => (
                  <td key={cellType} style={styles.footerCell}>
                    <div style={styles.columnActions}>
                      <Button variant="secondary" layoutStyle={styles.actionButton} onClick={() => setColumnAllowed(cellType, true)}>
                        {m["generation.enable_all"]()}
                      </Button>
                      <Button variant="secondary" layoutStyle={styles.actionButton} onClick={() => setColumnAllowed(cellType, false)}>
                        {m["generation.disable_all"]()}
                      </Button>
                    </div>
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
        {elementsWithoutAllowedCells.length > 0 && (
          <WarningBubble
            message={m["generation.element_placement_no_allowed_cells"]({
              elements: elementsWithoutAllowedCells.map(generatedElementLabel).join(", "),
            })}
          />
        )}
        <div style={styles.footer}>
          <Button variant="secondary" dialogAction layoutStyle={styles.footerButton} onClick={onClose}>{m["common.cancel"]()}</Button>
          <Button variant="primary" dialogAction layoutStyle={styles.footerButton} onClick={confirm}>{m["common.confirm"]()}</Button>
        </div>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: { display: "flex", flexDirection: "column", gap: spacing.sectionGap },
  hint: { ...typography.body, margin: 0, color: ui.text.secondary },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: typography.body.fontSize },
  header: { padding: 8, borderBottom: `1px solid ${ui.border.default}`, textAlign: "center", verticalAlign: "middle" },
  elementHeader: { textAlign: "left", minWidth: 130, verticalAlign: "middle" },
  // `inline-flex` shrink-wraps to the longest label; stretching makes both buttons that width.
  columnActions: { display: "inline-flex", flexDirection: "column", alignItems: "stretch", gap: 4 },
  actionButton: { height: 22, padding: "0 6px", borderRadius: radius.sm, fontSize: 11, whiteSpace: "nowrap" },
  rowHeader: { padding: 8, borderBottom: `1px solid ${ui.border.default}`, textAlign: "left", fontWeight: 400 },
  cell: { padding: 8, borderBottom: `1px solid ${ui.border.default}`, textAlign: "center" },
  footerHeader: { borderTop: `1px solid ${ui.border.default}` },
  footerCell: { padding: 8, borderTop: `1px solid ${ui.border.default}`, textAlign: "center" },
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: 0 },
  footerButton: { ...typography.control, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm },
};
