import { useSyncExternalStore } from "react";
import {
  subscribe,
  getSnapshot,
  getServerSnapshot,
} from "../../pixi/imageExport/screenCalibration";

/** Reactive read of the calibrated effective CSS PPI (`screenCalibration.ts`, GitHub issue #476) —
 * `null` until the user calibrates. Re-renders on calibration changes (the modal's Apply). Same
 * `useSyncExternalStore` shape as `i18n/useLocale.ts`. */
export function useCalibratedCssPpi(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
