/** Screen calibration for the print-preview "Physical size (1:1)" zoom (GitHub issue #476).
 *
 * The browser does not expose the display's real physical pixel density, and a CSS pixel is not a
 * device pixel (OS display scaling, browser zoom). So the user calibrates, and we store, the
 * *effective CSS pixels per inch* under their current browser/OS configuration — measured against a
 * standard bank / ID card (ISO/IEC 7810 ID-1, 85.60 mm wide, a single worldwide standard).
 *
 * This is a property of the user's device/configuration, NOT of the project — persisted in
 * `localStorage`, never in a project file. Same imperative-store + `useSyncExternalStore` pattern
 * as `i18n/localeStore.ts`. Before calibration the value is `null` (the 1:1 button opens the
 * calibration modal instead of zooming). */

const STORAGE_KEY = "printScreenCalibration.cssPpi";
const MM_PER_INCH = 25.4;

/** ISO/IEC 7810 ID-1 (standard bank / ID card) — width, a single worldwide standard. */
export const CALIBRATION_CARD_WIDTH_MM = 85.6;
export const CALIBRATION_CARD_HEIGHT_MM = 53.98;
/** ISO/IEC 7810 ID-1 corner radius. */
export const CALIBRATION_CARD_CORNER_RADIUS_MM = 3.18;
/** Starting position of the calibration slider — a typical effective CSS PPI. NOT a confirmed value. */
export const CALIBRATION_START_CSS_PPI = 96;
/** Realistic range of effective CSS PPI (OS scaling usually keeps this near ~96..150). */
export const MIN_CSS_PPI = 60;
export const MAX_CSS_PPI = 200;

export function mmToCssPx(mm: number, cssPpi: number): number {
  return (mm / MM_PER_INCH) * cssPpi;
}

function clampCssPpi(cssPpi: number): number {
  return Math.min(MAX_CSS_PPI, Math.max(MIN_CSS_PPI, cssPpi));
}

// Cached so getSnapshot() returns a stable value between calls (useSyncExternalStore requirement).
// `undefined` = not yet read from localStorage; `null` = read, nothing stored / invalid.
let cached: number | null | undefined;

function readStorage(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number.parseFloat(raw);
    // Clamp on read too, not just on write: a value persisted by a different build (wider range) or
    // hand-edited in devtools must not flow unclamped into the 1:1 viewport-scale formula.
    return Number.isFinite(parsed) && parsed > 0 ? clampCssPpi(parsed) : null;
  } catch {
    return null;
  }
}

/** Calibrated effective CSS PPI, or `null` if the user has not calibrated yet. */
export function loadCalibratedCssPpi(): number | null {
  if (cached === undefined) cached = readStorage();
  return cached;
}

export function saveCalibratedCssPpi(cssPpi: number): void {
  const value = clampCssPpi(cssPpi);
  cached = value;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // Storage unavailable (private mode, quota) — keep the in-memory value, drop persistence.
    }
  }
  notify();
}

const subscribers = new Set<() => void>();

export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function notify(): void {
  subscribers.forEach((fn) => fn());
}

/** For `useSyncExternalStore` — returns the cached primitive (`number | null`), stable by value. */
export function getSnapshot(): number | null {
  return loadCalibratedCssPpi();
}

/** For `useSyncExternalStore`'s server snapshot — no calibration exists server-side. */
export function getServerSnapshot(): number | null {
  return null;
}

/** Drops the in-memory cache so the next read re-hits `localStorage` — tests only (the value never
 * changes out from under a running app except through `saveCalibratedCssPpi`, which updates the
 * cache itself). */
export function __resetCalibrationCacheForTests(): void {
  cached = undefined;
}
