import { registerNotificationCode } from "./notificationRegistry";
import { notify, retractErrorOccurrence } from "./notificationStore";
import * as m from "~/paraglide/messages";
import { MAX_UPLOADED_BYTES, MAX_UPLOADED_FACES, MAX_UPLOAD_FILE_BYTES, type UploadLimitError } from "../pixi/renderers/rasterFont/rasterFontStore";

/** Toasts of the font pipeline (GitHub issue #974): every case where a project font cannot be drawn from its
 *  own atlas is reported here, never silently replaced by Roboto or canvas text. */
export const FONT_SOURCE = "fonts";

export const FONT_CODES = {
  unavailable: "fonts.unavailable",
  permissionDenied: "fonts.permission_denied",
  weightUnavailable: "fonts.weight_unavailable",
  conversionFailed: "fonts.conversion_failed",
  glyphsMissing: "fonts.glyphs_missing",
  atlasFull: "fonts.atlas_full",
  manualNotFound: "fonts.manual_not_found",
  uploadRefused: "fonts.upload_refused",
} as const;

registerNotificationCode(FONT_CODES.unavailable, {
  severity: "error",
  message: (p) => m["fonts.unavailable"]({ fonts: String(p.fonts) }),
});
registerNotificationCode(FONT_CODES.permissionDenied, {
  severity: "error",
  message: (p) => m["fonts.permission_denied"]({ fonts: String(p.fonts) }),
});
registerNotificationCode(FONT_CODES.weightUnavailable, {
  severity: "error",
  message: (p) => m["fonts.weight_unavailable"]({ font: String(p.font), requested: Number(p.requested), used: Number(p.used) }),
});
registerNotificationCode(FONT_CODES.conversionFailed, {
  severity: "error",
  message: (p) => m["fonts.conversion_failed"]({ font: String(p.font), weight: Number(p.weight) }),
});
registerNotificationCode(FONT_CODES.glyphsMissing, {
  severity: "warning",
  dedupParams: ["font", "chars"],
  message: (p) => m["fonts.glyphs_missing"]({ font: String(p.font), chars: String(p.chars) }),
});
registerNotificationCode(FONT_CODES.atlasFull, {
  severity: "warning",
  dedupParams: ["font", "weight"],
  message: (p) => m["fonts.atlas_full"]({ font: String(p.font), weight: Number(p.weight) }),
});

registerNotificationCode(FONT_CODES.manualNotFound, {
  severity: "warning",
  dedupParams: ["font"],
  message: (p) => m["fonts.manual_not_found"]({ font: String(p.font) }),
});

const MB = 1024 * 1024;
registerNotificationCode(FONT_CODES.uploadRefused, {
  severity: "warning",
  dedupParams: ["reason"],
  message: (p) => {
    switch (p.reason as UploadLimitError) {
      case "file-too-large": return m["fonts.upload_file_too_large"]({ limit: MAX_UPLOAD_FILE_BYTES / MB });
      case "too-many-fonts": return m["fonts.upload_too_many"]({ limit: MAX_UPLOADED_FACES });
      case "storage-full": return m["fonts.upload_storage_full"]({ limit: MAX_UPLOADED_BYTES / MB });
    }
  },
});

/** An upload was refused because of a size limit: a warning, nothing is stored. */
export function reportUploadRefused(reason: UploadLimitError): void {
  notify({ source: FONT_SOURCE, code: FONT_CODES.uploadRefused, params: { reason } });
}

/** Problems already reported and still standing, by key. A repeated report of one is dropped, so a font
 *  that stays broken raises one error and not one per refresh; `clearFontProblem` re-arms it. */
const reported = new Map<string, { code: string; occurrenceId: number | null }>();

/** Reports an error problem once per `key` until `clearFontProblem(key)`. Returns whether it was raised. */
export function reportFontProblemOnce(key: string, code: string, params: Record<string, string | number>, details?: string): boolean {
  if (reported.has(key)) return false;
  reported.set(key, { code, occurrenceId: notify({ source: FONT_SOURCE, code, params, details }) });
  return true;
}

/** A font typed in by name is not installed: a warning, nothing is added. */
export function reportManualFontNotFound(font: string): void {
  notify({ source: FONT_SOURCE, code: FONT_CODES.manualNotFound, params: { font } });
}

/** The problem `key` is resolved: its error leaves the screen and the problem is re-armed. */
export function clearFontProblem(key: string): void {
  const problem = reported.get(key);
  if (!problem) return;
  reported.delete(key);
  if (problem.occurrenceId !== null) retractErrorOccurrence(FONT_SOURCE, problem.code, problem.occurrenceId);
}

/** Resolves every problem whose key starts with `prefix`, except `keep`. */
export function clearFontProblemsWithPrefix(prefix: string, keep?: string): void {
  for (const key of [...reported.keys()]) if (key.startsWith(prefix) && key !== keep) clearFontProblem(key);
}

/** Display name of a font in a toast: the family, the default font being Roboto. */
export function fontDisplayName(family: string): string {
  return family.trim() || "Roboto";
}

/** Tests only. */
export function resetFontProblems(): void {
  reported.clear();
}
