/** "Recently used" colors for the color picker (GitHub issue #506, sub-issue of #498).
 *
 * A session convenience, not project data — persisted in `localStorage`, global to the app (not
 * per project), so the project file is untouched. Same imperative-store + `useSyncExternalStore`
 * pattern as `pixi/imageExport/screenCalibration.ts`. Reads/writes are wrapped in try/catch; on
 * any failure (storage unavailable, corrupt JSON) the list is treated as empty. */

const STORAGE_KEY = "colorPicker.recentColors";
export const MAX_RECENT_COLORS = 12;

// Cached so getSnapshot() returns a stable reference between calls (useSyncExternalStore
// requirement). `undefined` = not yet read from localStorage.
let cached: number[] | undefined;

function readStorage(): number[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).slice(0, MAX_RECENT_COLORS);
  } catch {
    return [];
  }
}

function writeStorage(colors: number[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
  } catch {
    // Storage unavailable (private mode, quota) — keep the in-memory value, drop persistence.
  }
}

/** Most-recent-first list of colors committed via Apply, de-duplicated, capped to
 * `MAX_RECENT_COLORS`. */
export function loadRecentColors(): number[] {
  if (cached === undefined) cached = readStorage();
  return cached;
}

/** Record a newly-applied color as most recent — moves it to the front if already present, caps
 * the list, and persists. */
export function pushRecentColor(color: number): void {
  const current = loadRecentColors();
  const next = [color, ...current.filter((c) => c !== color)].slice(0, MAX_RECENT_COLORS);
  cached = next;
  writeStorage(next);
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

/** For `useSyncExternalStore` — returns the cached array (stable reference until the next push). */
export function getSnapshot(): number[] {
  return loadRecentColors();
}

/** For `useSyncExternalStore`'s server snapshot — no recent colors exist server-side. */
export function getServerSnapshot(): number[] {
  return [];
}

/** Drops the in-memory cache so the next read re-hits `localStorage` — tests only. */
export function __resetRecentColorsCacheForTests(): void {
  cached = undefined;
}
