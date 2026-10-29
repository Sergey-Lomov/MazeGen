import type { FieldConfig } from "../fieldConfig";
import { fieldOperationAvailable } from "./fieldOps";

/** The canvas side of the field clipboard; the field editor controller registers itself. */
export interface FieldClipboardHost {
  copySelection(): void;
  paste(): void;
}

let host: FieldClipboardHost | null = null;

export function registerFieldClipboardHost(next: FieldClipboardHost | null): void {
  host = next;
}

export function copyFieldSelection(): void {
  host?.copySelection();
}

export function pasteFieldClipboard(): void {
  host?.paste();
}

/** Copy / Paste move cells by a translation, so they need a tessellation with translation symmetry. */
export function fieldClipboardSupported(tessellation: FieldConfig["tessellation"]): boolean {
  return fieldOperationAvailable(tessellation, "translate");
}

export type FieldClipboardBlock = "tessellation" | "no_selection" | "empty_clipboard";

/** Why Copy / Paste is unavailable, or null when it is available. The tessellation reason wins. */
export function fieldClipboardBlock(
  tool: "copy" | "paste",
  tessellation: FieldConfig["tessellation"],
  hasSelection: boolean,
  hasClipboard: boolean,
): FieldClipboardBlock | null {
  if (!fieldClipboardSupported(tessellation)) return "tessellation";
  if (tool === "copy") return hasSelection ? null : "no_selection";
  return hasClipboard ? null : "empty_clipboard";
}
