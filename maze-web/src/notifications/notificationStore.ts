/** Toast channel store (GitHub issue #767, epic #766): the `notice` and `error` zones.
 *
 * Notice zone — at most `NOTICE_MAX_VISIBLE` visible and `NOTICE_MAX_QUEUED` queued. A repeat
 * (same dedup key) never creates a new item: a queued one gets fresh params and update time, a
 * visible one gets fresh params and a restarted display timer, capped at `NOTICE_ACTIVE_CAP_MS` of
 * total active display. A notice closed by that cap suppresses its key for `NOTICE_SUPPRESS_MS`.
 *
 * All notice timers (display and queue aging) run on an "active clock" that stops while the zone
 * is hovered (`setNoticeZonePaused`), so nothing disappears under the pointer.
 *
 * Error zone — errors aggregate by `source + code` into cards; each `notify` call is a separate
 * occurrence and moves its card to the bottom (most recently updated last). At most `ERROR_MAX_OCCURRENCES` occurrences across all cards; cards never expire. */

import { create } from "zustand";
import {
  getNotificationCode,
  notificationKey,
  notificationMessage,
  type NotificationParams,
} from "./notificationRegistry";
import { announce } from "./announcer";

export const NOTICE_MAX_VISIBLE = 3;
export const NOTICE_MAX_QUEUED = 5;
export const NOTICE_QUEUE_TTL_MS = 10_000;
export const NOTICE_BASE_MS = 4000;
export const NOTICE_PER_CHAR_MS = 50;
export const NOTICE_MAX_DISPLAY_MS = 8000;
export const NOTICE_ACTIVE_CAP_MS = 12_000;
export const NOTICE_SUPPRESS_MS = 5000;
export const ERROR_MAX_OCCURRENCES = 20;
export const ERROR_VISIBLE_CARDS = 2;

export interface NotifyInput {
  /** Emitting feature/component, part of every dedup key. */
  source: string;
  /** Registered code (`registerNotificationCode`). */
  code: string;
  params?: NotificationParams;
  /** Free-form technical details, listed in the error card's "Details". */
  details?: string;
}

export interface NoticeItem {
  id: number;
  key: string;
  source: string;
  code: string;
  params: NotificationParams;
  details?: string;
  /** Active-clock time of the last create/repeat. */
  updatedAt: number;
  /** Active-clock time the notice became visible; unset while queued. */
  shownAt?: number;
  /** Active-clock time the visible notice expires; unset while queued. */
  expiresAt?: number;
  /** Active-clock time the current display timer (re)started — base of the countdown indicator. */
  timerStart?: number;
}

export interface ErrorOccurrence {
  id: number;
  params: NotificationParams;
  details?: string;
}

export interface ErrorCard {
  key: string;
  source: string;
  code: string;
  /** Oldest first; the card shows the last one. */
  occurrences: ErrorOccurrence[];
}

interface NotificationState {
  notices: NoticeItem[];
  queue: NoticeItem[];
  errors: ErrorCard[];
  /** True while the notice zone is hovered and its active clock is stopped. */
  noticesPaused: boolean;
}

const initialState = (): NotificationState => ({ notices: [], queue: [], errors: [], noticesPaused: false });

export const useNotificationStore = create<NotificationState>(initialState);

// --- active clock -------------------------------------------------------------------------------

let clockBase = 0;
let resumedAt: number | null = Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
/** Dedup key → real time until which repeats are ignored (closed by the active-time cap). */
const suppressedUntil = new Map<string, number>();

/** Current active-clock time — the time base of `NoticeItem` timestamps. */
export function noticeActiveNow(): number {
  return activeNow();
}

function activeNow(): number {
  return resumedAt === null ? clockBase : clockBase + (Date.now() - resumedAt);
}

export function noticeDisplayDuration(text: string): number {
  return Math.min(NOTICE_BASE_MS + NOTICE_PER_CHAR_MS * text.length, NOTICE_MAX_DISPLAY_MS);
}

function durationOf(item: Pick<NoticeItem, "code" | "params">): number {
  return noticeDisplayDuration(notificationMessage(item.code, item.params));
}

function show(item: NoticeItem, now: number): NoticeItem {
  announce(notificationMessage(item.code, item.params), "polite");
  return { ...item, shownAt: now, timerStart: now, expiresAt: now + durationOf(item) };
}

/** Applies every expiry/aging deadline up to `now` and fills free visible slots from the queue. */
function process(state: NotificationState, now: number): NotificationState {
  const notices: NoticeItem[] = [];
  for (const n of state.notices) {
    if (n.expiresAt! > now) { notices.push(n); continue; }
    if (n.expiresAt! >= n.shownAt! + NOTICE_ACTIVE_CAP_MS) {
      suppressedUntil.set(n.key, Date.now() + NOTICE_SUPPRESS_MS);
    }
  }
  const queue = state.queue.filter((q) => now - q.updatedAt < NOTICE_QUEUE_TTL_MS);
  while (notices.length < NOTICE_MAX_VISIBLE && queue.length > 0) {
    notices.push(show(queue.shift()!, now));
  }
  const unchanged = notices.length === state.notices.length && queue.length === state.queue.length
    && notices.every((n, i) => n === state.notices[i]);
  return unchanged ? state : { ...state, notices, queue };
}

function reschedule(): void {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  if (resumedAt === null) return;
  const { notices, queue } = useNotificationStore.getState();
  const deadlines = [
    ...notices.map((n) => n.expiresAt!),
    ...queue.map((q) => q.updatedAt + NOTICE_QUEUE_TTL_MS),
  ];
  if (deadlines.length === 0) return;
  timer = setTimeout(tick, Math.max(0, Math.min(...deadlines) - activeNow()));
}

function tick(): void {
  timer = null;
  const state = useNotificationStore.getState();
  const next = process(state, activeNow());
  if (next !== state) useNotificationStore.setState(next);
  reschedule();
}

// --- notice zone --------------------------------------------------------------------------------

function addNotice(input: NotifyInput, dedupParams: readonly string[] | undefined): void {
  const now = activeNow();
  const params = input.params ?? {};
  const key = notificationKey(input.source, input.code, params, dedupParams);
  const until = suppressedUntil.get(key);
  if (until !== undefined) {
    if (Date.now() < until) return;
    suppressedUntil.delete(key);
  }

  const state = process(useNotificationStore.getState(), now);
  const visible = state.notices.find((n) => n.key === key);
  if (visible) {
    const updated = { ...visible, params, details: input.details, updatedAt: now, timerStart: now };
    updated.expiresAt = Math.min(now + durationOf(updated), visible.shownAt! + NOTICE_ACTIVE_CAP_MS);
    useNotificationStore.setState({ ...state, notices: state.notices.map((n) => (n === visible ? updated : n)) });
    reschedule();
    return;
  }

  const queued = state.queue.find((q) => q.key === key);
  if (queued) {
    const updated = { ...queued, params, details: input.details, updatedAt: now };
    useNotificationStore.setState({ ...state, queue: state.queue.map((q) => (q === queued ? updated : q)) });
    reschedule();
    return;
  }

  const item: NoticeItem = {
    id: nextId++,
    key,
    source: input.source,
    code: input.code,
    params,
    details: input.details,
    updatedAt: now,
  };
  if (state.notices.length < NOTICE_MAX_VISIBLE) {
    useNotificationStore.setState({ ...state, notices: [...state.notices, show(item, now)] });
  } else {
    let queue = [...state.queue, item];
    if (queue.length > NOTICE_MAX_QUEUED) {
      const oldest = queue.reduce((a, b) => (b.updatedAt < a.updatedAt ? b : a));
      queue = queue.filter((q) => q !== oldest);
    }
    useNotificationStore.setState({ ...state, queue });
  }
  reschedule();
}

export function closeNotice(id: number): void {
  const state = useNotificationStore.getState();
  const stripped = {
    ...state,
    notices: state.notices.filter((n) => n.id !== id),
    queue: state.queue.filter((q) => q.id !== id),
  };
  useNotificationStore.setState(process(stripped, activeNow()));
  reschedule();
}

export function closeAllNotices(): void {
  useNotificationStore.setState({ notices: [], queue: [] });
  reschedule();
}

/** Pauses (hover in) / resumes (hover out) every notice-zone timer, including queue aging. */
export function setNoticeZonePaused(paused: boolean): void {
  if (paused === (resumedAt === null)) return;
  if (paused) {
    clockBase = activeNow();
    resumedAt = null;
  } else {
    resumedAt = Date.now();
  }
  useNotificationStore.setState({ noticesPaused: paused });
  reschedule();
}

// --- error zone ---------------------------------------------------------------------------------

function addError(input: NotifyInput): void {
  const key = notificationKey(input.source, input.code);
  const occurrence: ErrorOccurrence = { id: nextId++, params: input.params ?? {}, details: input.details };
  const { errors } = useNotificationStore.getState();
  const existing = errors.find((c) => c.key === key);
  // A card with a new occurrence moves to the bottom, so the visible "newest" cards are the most
  // recently updated ones and a repeat never stays hidden in the collapsed group.
  let next = existing
    ? [...errors.filter((c) => c !== existing), { ...existing, occurrences: [...existing.occurrences, occurrence] }]
    : [...errors, { key, source: input.source, code: input.code, occurrences: [occurrence] }];

  let total = next.reduce((sum, c) => sum + c.occurrences.length, 0);
  while (total > ERROR_MAX_OCCURRENCES) {
    // Occurrence ids grow monotonically, so the smallest id is the oldest occurrence overall.
    let oldest = next[0];
    for (const c of next) if (c.occurrences[0].id < oldest.occurrences[0].id) oldest = c;
    next = next
      .map((c) => (c === oldest ? { ...c, occurrences: c.occurrences.slice(1) } : c))
      .filter((c) => c.occurrences.length > 0);
    total--;
  }
  useNotificationStore.setState({ errors: next });
  if (!existing) announce(notificationMessage(input.code, occurrence.params), "assertive");
}

export function closeErrorCard(key: string): void {
  useNotificationStore.setState((s) => ({ errors: s.errors.filter((c) => c.key !== key) }));
}

export function closeAllErrors(): void {
  useNotificationStore.setState({ errors: [] });
}

// --- public API ---------------------------------------------------------------------------------

/** Reports a rejected action (`notice` code) or a failed operation (`error` code). */
export function notify(input: NotifyInput): void {
  const def = getNotificationCode(input.code);
  if (!def) {
    console.error(`notify: unregistered notification code "${input.code}"`);
    return;
  }
  if (def.category === "error") addError(input);
  else addNotice(input, def.dedupParams);
}

/** Clears both zones, the suppression list and the active clock (tests). */
export function resetNotifications(): void {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  clockBase = 0;
  resumedAt = Date.now();
  suppressedUntil.clear();
  useNotificationStore.setState(initialState());
}
