import React, { useState } from "react";
import { FontUsedIcon } from "../FontStatusIcons";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { ConfirmModal } from "../ConfirmModal";
import { ToggleRow } from "../ToggleRow";
import { Tooltip } from "../Tooltip";
import { ui, radius, dialogSpacing, typography, inset, muted } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  /** Every uploaded family. */
  families: string[];
  /** Families a font of the project names; deleting one of them asks to confirm. */
  usedFamilies: ReadonlySet<string>;
  onDelete: (families: string[]) => void;
  onClose: () => void;
}

/** Lists the uploaded fonts with a switch each and deletes the chosen ones (GitHub issue #985). Deleting asks for
 *  nothing, except when a chosen font is used in the project: that needs a second confirmation. */
export function RemoveUploadedFontsDialog({ families, usedFamilies, onDelete, onClose }: Props) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const picked = families.filter((family) => chosen.has(family));
  const toggle = (family: string, on: boolean) => setChosen((current) => {
    const next = new Set(current);
    if (on) next.add(family); else next.delete(family);
    return next;
  });
  const remove = () => {
    if (picked.length === 0) return;
    if (picked.some((family) => usedFamilies.has(family))) { setConfirming(true); return; }
    onDelete(picked);
    onClose();
  };
  return (
    <>
      <Modal title={m["font_remove.title"]()} size="approve" onClose={onClose} onConfirm={remove}>
        <div style={styles.hint}>{m["font_remove.body"]()}</div>
        <div style={styles.list} data-testid="font-remove-list">
          {families.map((family) => (
            <ToggleRow
              key={family}
              label={family}
              checked={chosen.has(family)}
              onChange={(on) => toggle(family, on)}
              action={usedFamilies.has(family) ? (
                <Tooltip content={m["font_picker.badge_used"]()} focusable={false}>
                  <span style={styles.usedIcon} role="img" aria-label={m["font_picker.badge_used"]()} data-testid="font-remove-used">
                    <FontUsedIcon />
                  </span>
                </Tooltip>
              ) : undefined}
            />
          ))}
        </div>
        <div style={styles.footer}>
          <Button variant="secondary" layoutStyle={styles.footerButton} onClick={onClose}>{m["common.cancel"]()}</Button>
          <Button variant="destructive" layoutStyle={styles.footerButton} onClick={remove} disabled={picked.length === 0} data-testid="font-remove-confirm">
            {m["font_remove.delete"]()}
          </Button>
        </div>
      </Modal>
      {confirming && (
        <ConfirmModal
          title={m["font_remove.used_title"]()}
          message={m["font_remove.used_message"]()}
          onCancel={() => setConfirming(false)}
          onConfirm={() => { onDelete(picked); onClose(); }}
        />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  hint: { ...typography.control, color: ui.text.secondary, paddingBottom: dialogSpacing.gap },
  list: { display: "flex", flexDirection: "column", gap: dialogSpacing.gap, maxHeight: 300, overflowY: "auto", paddingBottom: dialogSpacing.paddingY },
  usedIcon: { ...muted(typography.icon), display: "inline-flex", alignItems: "center", lineHeight: 1 },
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: dialogSpacing.paddingY, borderTop: `1px solid ${ui.border.default}` },
  footerButton: { ...typography.control, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm },
};
