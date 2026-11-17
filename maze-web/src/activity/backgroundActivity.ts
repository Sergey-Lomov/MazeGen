/** Registry of running background processes (GitHub issue #1004). A process kind (`fonts`, `analytics`) is
 *  active while at least one job of it runs; jobs of one kind share one indicator bubble, and the optional job
 *  label (a font name) is listed in it. The registry knows nothing about timing: `BackgroundActivityStack`
 *  decides when a bubble appears and disappears. */

export type ActivityKind = "fonts" | "analytics";

export interface ActivitySnapshot {
  kind: ActivityKind;
  /** Distinct labels of the running jobs, sorted; empty while no job is named. */
  labels: readonly string[];
}

/** Running jobs per kind, and per label within a kind (two jobs with one label count twice). */
const jobs = new Map<ActivityKind, Map<string, number>>();
const listeners = new Set<() => void>();
let snapshot: readonly ActivitySnapshot[] = [];

function publish(): void {
  snapshot = [...jobs].map(([kind, labels]) => ({ kind, labels: [...labels.keys()].filter(Boolean).sort() }));
  for (const listener of [...listeners]) listener();
}

/** Marks the start of a job of `kind`; pair with `endActivity` of the same arguments. */
export function beginActivity(kind: ActivityKind, label = ""): void {
  let labels = jobs.get(kind);
  if (!labels) jobs.set(kind, (labels = new Map()));
  labels.set(label, (labels.get(label) ?? 0) + 1);
  publish();
}

export function endActivity(kind: ActivityKind, label = ""): void {
  const labels = jobs.get(kind);
  if (!labels) return;
  const left = (labels.get(label) ?? 0) - 1;
  if (left > 0) labels.set(label, left);
  else labels.delete(label);
  if (labels.size === 0) jobs.delete(kind);
  publish();
}

/** Keeps `kind` active while `work` is pending, however it settles. */
export function trackActivity<T>(kind: ActivityKind, work: Promise<T>, label = ""): Promise<T> {
  beginActivity(kind, label);
  return work.finally(() => endActivity(kind, label));
}

/** Running kinds in the order they started. A stable reference until something changes, so it can serve as a
 *  `useSyncExternalStore` snapshot. */
export function runningActivities(): readonly ActivitySnapshot[] {
  return snapshot;
}

export function isActivityRunning(kind: ActivityKind): boolean {
  return jobs.has(kind);
}

export function subscribeActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
