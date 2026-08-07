import type React from "react";
import type { ExportFormatId } from "../../store/storeTypes";
import { PngExportSettingsPanel } from "./PngExportSettingsPanel";
import * as m from "~/paraglide/messages";

export interface ExportFormatDescriptor {
  id: ExportFormatId;
  label: () => string;
  /** Settings panel content shown in the format's `SidePanel`, or `null` for a format with no
   * settings yet. */
  SettingsPanel: React.ComponentType | null;
}

/// Single source of truth for the Image Export card's format list — one entry per output format.
/// Adding a format means adding one entry here (plus its own export implementation) — no other
/// list to keep in sync.
export const EXPORT_FORMATS: ExportFormatDescriptor[] = [
  { id: "png", label: () => m["image_export.format.png.label"](), SettingsPanel: PngExportSettingsPanel },
];

/** Looks up a format's descriptor, or `null` if `id` isn't registered. */
export function resolveExportFormat(id: ExportFormatId): ExportFormatDescriptor | null {
  return EXPORT_FORMATS.find((format) => format.id === id) ?? null;
}
