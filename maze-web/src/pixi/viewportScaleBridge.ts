/** Tiny imperative bridge from `MazeScene.getViewportScale()` (a live Pixi value, not store
 * state) to the PNG export settings panel's "match current zoom" button — the settings panel is
 * reached generically through `exportFormatRegistry.ts`'s `SettingsPanel: React.ComponentType`
 * (no props), so a scene-bound callback can't be prop-drilled through the registry the way
 * `onExportPng` is drilled explicitly. `App.tsx` registers the getter once the scene is ready;
 * `PngExportSettingsPanel` reads it on click, not reactively (no re-render needed — the value is
 * only read at the moment the button is pressed). */
let getter: (() => number) | null = null;

export function setViewportScaleGetter(fn: (() => number) | null): void {
  getter = fn;
}

export function getCurrentViewportScale(): number {
  return getter ? getter() : 1;
}

/** Second slot of the same bridge (GitHub issue #476): the print settings panel's "Physical size
 * (1:1)" button is a viewport command (`MazeScene.applyPrintPhysicalZoom`), and — like the "match
 * current zoom" getter above — the panel is reached generically through `exportFormatRegistry.ts`
 * with no props, so a scene-bound callback can't be prop-drilled to it. `App.tsx` registers the
 * applier once the scene is ready; the panel calls it on click. Not reactive. */
let physicalZoomApplier: ((targetViewportScale: number) => void) | null = null;

export function setPhysicalZoomApplier(fn: ((targetViewportScale: number) => void) | null): void {
  physicalZoomApplier = fn;
}

export function applyPhysicalZoom(targetViewportScale: number): void {
  physicalZoomApplier?.(targetViewportScale);
}
