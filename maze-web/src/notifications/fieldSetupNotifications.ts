import { registerNotificationCode } from "./notificationRegistry";
import { notify } from "./notificationStore";
import * as m from "~/paraglide/messages";

export const AUTO_FILL_PREVIEW_ACTIVE = "field_edit.auto_fill_preview_active";

registerNotificationCode(AUTO_FILL_PREVIEW_ACTIVE, { category: "notice", message: () => m[AUTO_FILL_PREVIEW_ACTIVE]() });

/** Canvas edit click ignored because the background auto-fill preview is active. */
export function notifyAutoFillPreviewActive(): void {
  notify({ source: "field_setup", code: AUTO_FILL_PREVIEW_ACTIVE });
}

export const NOTHING_SELECTED = "field_edit.nothing_selected";
export const NOTHING_COPIED = "field_edit.nothing_copied";
export const CLIPBOARD_UNAVAILABLE = "field_edit.clipboard_unavailable";

registerNotificationCode(NOTHING_SELECTED, { category: "notice", severity: "info", message: () => m[NOTHING_SELECTED]() });
registerNotificationCode(NOTHING_COPIED, { category: "notice", severity: "info", message: () => m[NOTHING_COPIED]() });
registerNotificationCode(CLIPBOARD_UNAVAILABLE, { category: "notice", severity: "info", message: () => m[CLIPBOARD_UNAVAILABLE]() });

/** Copy shortcut pressed with no selection. */
export function notifyNothingSelected(): void {
  notify({ source: "field_setup", code: NOTHING_SELECTED });
}

/** Copy / Paste shortcut pressed in a tessellation without translation symmetry. */
export function notifyClipboardUnavailable(): void {
  notify({ source: "field_setup", code: CLIPBOARD_UNAVAILABLE });
}

/** Paste shortcut pressed with an empty clipboard. */
export function notifyNothingCopied(): void {
  notify({ source: "field_setup", code: NOTHING_COPIED });
}
