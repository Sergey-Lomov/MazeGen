/** Whether a font picker is open (GitHub issue #966). While it is, every highlighted font reaches the
 *  settings as a preview and is drawn by canvas text; the MSDF atlas of a font is only built once the
 *  picker closes with the font applied (or the open-time font restored), so browsing the list never
 *  converts anything. */

let open = false;
const listeners = new Set<() => void>();

export function setFontPickerOpen(value: boolean): void {
  if (open === value) return;
  open = value;
  for (const listener of [...listeners]) listener();
}

export function isFontPickerOpen(): boolean {
  return open;
}

/** Calls `listener` whenever the picker opens or closes. */
export function subscribeFontPicker(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
