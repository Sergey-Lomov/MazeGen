import * as m from "~/paraglide/messages";

/** Reads a user-picked file as JSON for the project/style load dialogs. I/O and JSON syntax
 *  failures are reported through `onError` with the shared messages; `onJson` handles the parsed
 *  value (its own validation errors are its own concern). */
export function readJsonFile(file: File, onJson: (json: unknown) => void, onError: (message: string) => void): void {
  const reader = new FileReader();
  reader.onerror = () => onError(m["project.load_error_io"]());
  reader.onload = (ev) => {
    let json: unknown;
    try {
      json = JSON.parse(ev.target?.result as string);
    } catch {
      onError(m["project.load_error_json"]());
      return;
    }
    onJson(json);
  };
  reader.readAsText(file);
}
