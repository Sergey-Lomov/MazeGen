import * as m from "~/paraglide/messages";
import { registerNotificationCode } from "../notifications/notificationRegistry";
import { notify } from "../notifications/notificationStore";

const READ_FAILED = "file_load.read_failed";
const INVALID_JSON = "file_load.invalid_json";
registerNotificationCode(READ_FAILED, { category: "error", message: () => m[READ_FAILED]() });
registerNotificationCode(INVALID_JSON, { category: "error", message: () => m[INVALID_JSON]() });

/** Reads a user-picked file as JSON for the project/style load dialogs. I/O and JSON syntax
 *  failures are reported as `error` toasts under `source` and abort the load (`onJson` is not
 *  called); `onJson` handles the parsed value (its own validation errors are its own concern). */
export function readJsonFile(file: File, source: string, onJson: (json: unknown) => void): void {
  const reader = new FileReader();
  reader.onerror = () => notify({ source, code: READ_FAILED, details: reader.error?.message });
  reader.onload = (ev) => {
    let json: unknown;
    try {
      json = JSON.parse(ev.target?.result as string);
    } catch (err) {
      notify({ source, code: INVALID_JSON, details: err instanceof Error ? err.message : String(err) });
      return;
    }
    onJson(json);
  };
  reader.readAsText(file);
}
