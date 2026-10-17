import { useCallback, useEffect, useRef, useState } from "react";
export { normalizeChannelInput as parseChannelInput } from "./inputNormalization";

/** Per-channel text-input buffers shared by the color-picker model editors (`RgbModelEditor`,
 *  `HslModelEditor`, and the models that follow). Each channel input keeps a local text buffer so
 *  an emptied / in-progress value isn't forced back to a number mid-edit; the buffer is dropped on
 *  blur (`clearBuffer`) and whenever the working color changes from *outside* this editor.
 *
 *  "Outside" vs "this editor's own edit" is told apart by an internal `expectedColor` ref: every
 *  commit the editor makes must call `markSelfEdit(nextColor)` so the matching `color` prop update
 *  is recognised as self-inflicted and left alone. Any other `color` change runs `onExternalChange`
 *  (for editors that keep derived model state, e.g. HSL) and clears every buffer.
 *
 *  @param color            the working color prop, watched for outside changes
 *  @param onExternalChange optional — run when `color` changes from outside (before buffers clear)
 */
export function useChannelInputs<K extends string>(
  color: number,
  onExternalChange?: (color: number) => void,
) {
  const [buffers, setBuffers] = useState<Partial<Record<K, string>>>({});

  const expectedColor = useRef(color);
  const onExternalRef = useRef(onExternalChange);
  onExternalRef.current = onExternalChange;

  useEffect(() => {
    if (color !== expectedColor.current) {
      expectedColor.current = color;
      onExternalRef.current?.(color);
      setBuffers({});
    }
  }, [color]);

  /** Record a color this editor itself just produced so its `color` prop update isn't treated as
   *  an outside change. Call it on every commit before / with `onChange`. */
  const markSelfEdit = useCallback((nextColor: number) => {
    expectedColor.current = nextColor;
  }, []);

  /** Buffer the raw text for a channel; the editor commits the parsed value itself. */
  const setBuffer = useCallback((channel: K, raw: string) => {
    setBuffers((b) => ({ ...b, [channel]: raw }));
  }, []);

  const clearBuffer = useCallback((channel: K) => {
    setBuffers((b) => {
      const next = { ...b };
      delete next[channel];
      return next;
    });
  }, []);

  return { buffers, markSelfEdit, setBuffer, clearBuffer };
}
