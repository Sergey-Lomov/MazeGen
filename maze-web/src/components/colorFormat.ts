/** Re-exports the color-model math from `domain/colorMath.ts` (moved there in GitHub issue #647 so
 *  the parameter-links engine's per-channel color modifiers can share it without `store/` reaching
 *  into `components/`). Kept as a thin re-export so every existing `components/colorFormat` import
 *  (`ColorSwatch`, `ColorPickerPanel`, the model editors, etc.) is unaffected. */
export * from "../domain/colorMath";
