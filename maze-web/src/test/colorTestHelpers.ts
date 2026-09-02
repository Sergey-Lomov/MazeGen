import { fireEvent, screen } from "@testing-library/react";
import * as m from "~/paraglide/messages";

/** The `ColorSwatch` in the `ColorRow` whose label is `labelNode` (a text node from
 *  `screen.getByText` / `getAllByText`). `ColorRow` renders `<span>{label}</span><ColorSwatch/>`
 *  as siblings, so the swatch is the `role="button"` in the label's parent row. */
export function swatchForLabel(labelNode: HTMLElement): Element {
  const swatch = labelNode.parentElement!.querySelector('[role="button"]');
  if (!swatch) throw new Error("no ColorSwatch found in the label's row");
  return swatch;
}

/** Drive the `ColorSwatch` -> `ColorPickerPanel` flow (GitHub issue #499): click the swatch to
 *  open the picker, type `hex` into its hex field, hit "Apply". Replaces the old
 *  `fireEvent.change(input[type=color], ...)` one-liner now that the native input is gone. Only one
 *  picker is ever open at a time, so the global `screen` queries are unambiguous. */
export function pickColor(swatch: Element, hex: string) {
  fireEvent.click(swatch);
  fireEvent.change(screen.getByLabelText(m["color_picker.hex_label"]()), { target: { value: hex } });
  fireEvent.click(screen.getByText(m["common.apply"]()));
}

/** `swatchForLabel` + `pickColor` for the common case of a uniquely-labeled color row. */
export function pickColorForLabel(labelNode: HTMLElement, hex: string) {
  pickColor(swatchForLabel(labelNode), hex);
}
