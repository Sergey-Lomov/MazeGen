import { registerNotificationCode } from "./notificationRegistry";
import { notify } from "./notificationStore";
import * as m from "~/paraglide/messages";

export const AUTO_FILL_PREVIEW_ACTIVE = "field_edit.auto_fill_preview_active";

registerNotificationCode(AUTO_FILL_PREVIEW_ACTIVE, { severity: "warning", message: () => m[AUTO_FILL_PREVIEW_ACTIVE]() });

/** Canvas edit click ignored because the background auto-fill preview is active. */
export function notifyAutoFillPreviewActive(): void {
  notify({ source: "field_setup", code: AUTO_FILL_PREVIEW_ACTIVE });
}

export const NOTHING_SELECTED = "field_edit.nothing_selected";
export const NOTHING_COPIED = "field_edit.nothing_copied";
export const CLIPBOARD_UNAVAILABLE = "field_edit.clipboard_unavailable";
export const SMOOTHING_AFFECTED = "field_edit.smoothing_affected";
export const SMOOTHING_EMPTY_RESULT = "field_edit.smoothing_empty_result";

registerNotificationCode(NOTHING_SELECTED, { severity: "info", message: () => m[NOTHING_SELECTED]() });
registerNotificationCode(NOTHING_COPIED, { severity: "info", message: () => m[NOTHING_COPIED]() });
registerNotificationCode(CLIPBOARD_UNAVAILABLE, { severity: "info", message: () => m[CLIPBOARD_UNAVAILABLE]() });
registerNotificationCode(SMOOTHING_AFFECTED, { severity: "info", message: () => m[SMOOTHING_AFFECTED]() });
registerNotificationCode(SMOOTHING_EMPTY_RESULT, { severity: "warning", message: () => m[SMOOTHING_EMPTY_RESULT]() });

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

/** First add operation after smoothing discarded only part of a shape. */
export function notifySmoothingAffected(): void {
  notify({ source: "field_setup", code: SMOOTHING_AFFECTED });
}

/** Smoothing discarded every new cell from an otherwise addable shape. */
export function notifySmoothingEmptyResult(): void {
  notify({ source: "field_setup", code: SMOOTHING_EMPTY_RESULT });
}
