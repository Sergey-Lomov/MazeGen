import { useSyncExternalStore } from "react";
import { LABEL_FONT_LOADED_EVENT } from "../../domain/renderers/fontChoice";
import { textMetricsKey } from "../../pixi/textFit";

const subscribe = (listener: () => void) => {
  window.addEventListener(LABEL_FONT_LOADED_EVENT, listener);
  return () => window.removeEventListener(LABEL_FONT_LOADED_EVENT, listener);
};

/** Changes whenever a label font finishes loading or converting (GitHub issue #974). Warnings and text fit
 *  measured while a font was still the fallback must be measured again: put it among the inputs of every
 *  memo that calls `measureText`. */
export function useTextMetricsKey(): string {
  return useSyncExternalStore(subscribe, textMetricsKey);
}
