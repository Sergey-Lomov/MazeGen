import { registerNotificationCode } from "../../notifications/notificationRegistry";
import { notify } from "../../notifications/notificationStore";
import * as m from "~/paraglide/messages";

/** Source and code of the error toast raised when an in-place save fails. */
export const FILE_SAVE_SOURCE = "file_save";
export const FILE_SAVE_CODES = { failed: "file_save.failed" } as const;

registerNotificationCode(FILE_SAVE_CODES.failed, { severity: "error", message: () => m["file_save.failed"]() });

/** Minimal File System Access API surface used here (not in every TypeScript `lib.dom`). */
interface WritableLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface SaveHandle {
  readonly name: string;
  createWritable(): Promise<WritableLike>;
}

interface SavePickerOptions {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}

type PickerWindow = { showSaveFilePicker?: (options: SavePickerOptions) => Promise<SaveHandle> };

/** Handle of the file each kind (`project`, `style`, `quality`) was last saved to. Session-only: a
 *  handle cannot be restored from a name, and the browser re-checks write permission on use. */
const handles = new Map<string, SaveHandle>();

/** True when the browser can write to a user-chosen file (`showSaveFilePicker`). Otherwise saving
 *  falls back to the regular download flow. */
export function supportsInPlaceSave(): boolean {
  return typeof window !== "undefined" && typeof (window as PickerWindow).showSaveFilePicker === "function";
}

/** File name the kind was last saved to in this session, or null. */
export function lastSavedFileName(kind: string): string | null {
  return handles.get(kind)?.name ?? null;
}

/** Forgets every remembered handle (tests). */
export function resetSavedHandles(): void {
  handles.clear();
}

export type SaveInPlaceResult = "saved" | "cancelled" | "failed";

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Writes `data` as pretty-printed JSON to the file the kind was last saved to when `fileName` is
 *  still that file's name; otherwise opens the native save dialog (which asks before replacing an
 *  existing file) and remembers the chosen file for the next save. The write goes through a
 *  writable stream that the browser commits only on `close`, so a failure midway leaves the
 *  existing file untouched. A failure shows an error toast and forgets the handle, so the next
 *  save asks for a file again. Must be called synchronously from a user gesture. */
export async function saveJsonInPlace(kind: string, data: unknown, fileName: string, extension: string): Promise<SaveInPlaceResult> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/octet-stream" });
  let handle = handles.get(kind);
  try {
    if (!handle || handle.name !== fileName) {
      if (!picker) throw new Error("showSaveFilePicker is not available");
      handle = await picker.call(window, {
        suggestedName: fileName,
        types: [{ description: extension, accept: { "application/octet-stream": [extension] } }],
      });
    }
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    handles.set(kind, handle);
    return "saved";
  } catch (error) {
    if (isAbort(error)) return "cancelled";
    handles.delete(kind);
    notify({ source: FILE_SAVE_SOURCE, code: FILE_SAVE_CODES.failed, details: error instanceof Error ? error.message : String(error) });
    return "failed";
  }
}
