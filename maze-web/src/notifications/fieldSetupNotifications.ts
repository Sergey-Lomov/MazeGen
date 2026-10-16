import { registerNotificationCode } from "./notificationRegistry";
import { notify } from "./notificationStore";
import * as m from "~/paraglide/messages";

export const AUTO_FILL_PREVIEW_ACTIVE = "field_edit.auto_fill_preview_active";

registerNotificationCode(AUTO_FILL_PREVIEW_ACTIVE, { category: "notice", message: () => m[AUTO_FILL_PREVIEW_ACTIVE]() });

/** Canvas edit click ignored because the background auto-fill preview is active. */
export function notifyAutoFillPreviewActive(): void {
  notify({ source: "field_setup", code: AUTO_FILL_PREVIEW_ACTIVE });
}
