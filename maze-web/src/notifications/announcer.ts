/** Screen-reader announcement queue backing the shared `Announcer` component (GitHub issue #767).
 *
 * Toasts and field hints have no live roles of their own; they push their text here exactly once
 * (on appearance), and `Announcer` renders each entry into the matching hidden live region —
 * `assertive` for errors, `polite` for notices and hints. Polite entries are appended one by one,
 * so screen readers read them sequentially. Entries are dropped after `ANNOUNCEMENT_TTL_MS`, long
 * after the region announced them, so the regions never grow unbounded. */

import { create } from "zustand";

export type AnnouncementPoliteness = "assertive" | "polite";

export interface Announcement {
  id: number;
  text: string;
  politeness: AnnouncementPoliteness;
}

export const ANNOUNCEMENT_TTL_MS = 7000;

interface AnnouncerState {
  entries: Announcement[];
}

export const useAnnouncerStore = create<AnnouncerState>(() => ({ entries: [] }));

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function announce(text: string, politeness: AnnouncementPoliteness): void {
  if (!text) return;
  const id = nextId++;
  useAnnouncerStore.setState((s) => ({ entries: [...s.entries, { id, text, politeness }] }));
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    useAnnouncerStore.setState((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
  }, ANNOUNCEMENT_TTL_MS));
}

/** Clears all entries and pending removal timers (tests). */
export function resetAnnouncer(): void {
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
  useAnnouncerStore.setState({ entries: [] });
}
