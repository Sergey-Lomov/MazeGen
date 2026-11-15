import React, { useSyncExternalStore } from "react";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { ui, radius, dialogSpacing, typography, inset } from "../../styles/theme";
import { loadLocalFontFamilies } from "../../pixi/renderers/labelFont";
import {
  closeFontPermissionRequest, getFontPermissionRequest, subscribeFontPermissionRequest,
} from "../../pixi/renderers/rasterFont/fontPermissionRequest";
import * as m from "~/paraglide/messages";

/** Asks the user for access to the installed fonts when a loaded project names fonts that are not uploaded
 *  (GitHub issue #974). The browser shows its own prompt only from a user gesture, so the button is that gesture:
 *  the query starts synchronously inside its click handler. Cancel leaves the fonts unavailable, which the font
 *  sync then reports as an error toast. */
export function LocalFontPermissionDialog() {
  const request = useSyncExternalStore(subscribeFontPermissionRequest, getFontPermissionRequest);
  if (!request.open) return null;
  // No `await` before the query: the transient user activation must still be alive when it starts.
  // The dialog stays open until the browser prompt is answered: closing it earlier would make the font sync
  // read the still undecided permission and report the fonts as unavailable.
  const requestAccess = () => {
    const query = loadLocalFontFamilies(true);
    void query.then(() => closeFontPermissionRequest(true));
  };
  const cancel = () => closeFontPermissionRequest(true);
  return (
    <Modal title={m["font_permission.title"]()} size="approve" onClose={cancel} onConfirm={requestAccess}>
      {request.families.length > 1 ? (
        <div style={styles.hint}>
          <p style={styles.paragraph}>{m["font_permission.body_many"]()}</p>
          <ul style={styles.list}>
            {request.families.map((family) => <li key={family}>{family}</li>)}
          </ul>
          <p style={styles.paragraph}>{m["font_permission.body_many_hint"]()}</p>
        </div>
      ) : (
        <p style={styles.hint}>{m["font_permission.body"]({ fonts: request.families.join(", ") })}</p>
      )}
      <div style={styles.footer}>
        <Button variant="secondary" layoutStyle={styles.footerButton} onClick={cancel}>{m["common.cancel"]()}</Button>
        <Button variant="primary" layoutStyle={styles.footerButton} onClick={requestAccess}>{m["font_permission.request"]()}</Button>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  hint: { ...typography.control, color: ui.text.secondary, margin: 0, paddingBottom: dialogSpacing.paddingY },
  paragraph: { margin: 0 },
  list: { margin: `${dialogSpacing.gap}px 0`, paddingLeft: 20, listStyleType: "disc" },
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: dialogSpacing.paddingY, borderTop: `1px solid ${ui.border.default}` },
  footerButton: { ...typography.control, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm },
};
