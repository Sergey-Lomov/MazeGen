import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notificationKey, notificationMessage, registerNotificationCode, stableStringify } from "../notifications/notificationRegistry";
import {
  ERROR_MAX_OCCURRENCES,
  NOTICE_MAX_QUEUED,
  NOTICE_MAX_VISIBLE,
  closeAllErrors,
  closeAllNotices,
  closeErrorCard,
  closeNotice,
  noticeDisplayDuration,
  notify,
  resetNotifications,
  setNoticeZonePaused,
  useNotificationStore,
} from "../notifications/notificationStore";
import { resetAnnouncer, useAnnouncerStore } from "../notifications/announcer";

// 10-char message → 4000 + 50 * 10 = 4500 ms display duration.
const SHORT = "Rejected!!";
const SHORT_MS = 4500;

registerNotificationCode("test.notice", { severity: "warning", message: () => SHORT });
registerNotificationCode("test.notice_at", {
  severity: "warning",
  message: (p) => `At ${p.x}`,
});
registerNotificationCode("test.notice_by_floor", {
  severity: "warning",
  message: (p) => `Floor ${p.floor} ${p.x}`,
  dedupParams: ["floor"],
});
registerNotificationCode("test.error", { severity: "error", message: (p) => `Failed ${p.n ?? ""}` });
registerNotificationCode("test.error_b", { severity: "error", message: () => "Other failure" });

const state = () => useNotificationStore.getState();
const announced = (politeness: "polite" | "assertive") =>
  useAnnouncerStore.getState().entries.filter((e) => e.politeness === politeness).map((e) => e.text);

function noticeN(i: number) {
  notify({ source: `s${i}`, code: "test.notice" });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetNotifications();
  resetAnnouncer();
});

afterEach(() => {
  resetNotifications();
  resetAnnouncer();
  vi.useRealTimers();
});

describe("dedup key", () => {
  it("serializes selected params with sorted keys", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    expect(notificationKey("src", "c", { a: 1, b: 2 }, ["b", "a"])).toBe(notificationKey("src", "c", { b: 2, a: 1 }, ["a", "b"]));
  });

  it("ignores params outside dedupParams", () => {
    expect(notificationKey("src", "c", { x: 1 })).toBe(notificationKey("src", "c", { x: 2 }));
    expect(notificationKey("src", "c", { floor: 1, x: 1 }, ["floor"]))
      .not.toBe(notificationKey("src", "c", { floor: 2, x: 1 }, ["floor"]));
  });

  it("separates sources and codes", () => {
    expect(notificationKey("a", "c")).not.toBe(notificationKey("b", "c"));
    expect(notificationKey("a", "c1")).not.toBe(notificationKey("a", "c2"));
  });
});

describe("notificationMessage", () => {
  it("renders the registered message and falls back to the raw code", () => {
    expect(notificationMessage("test.notice_at", { x: 4 })).toBe("At 4");
    expect(notificationMessage("test.unregistered", {})).toBe("test.unregistered");
  });
});

describe("notice zone", () => {
  it("display duration is 4 s + 50 ms per character, capped at 8 s", () => {
    expect(noticeDisplayDuration("")).toBe(4000);
    expect(noticeDisplayDuration("x".repeat(20))).toBe(5000);
    expect(noticeDisplayDuration("x".repeat(200))).toBe(8000);
  });

  it("expires after its display duration", () => {
    noticeN(0);
    vi.advanceTimersByTime(SHORT_MS - 1);
    expect(state().notices).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(state().notices).toHaveLength(0);
  });

  it("keeps at most 3 visible and 5 queued, dropping the oldest queued on overflow", () => {
    for (let i = 0; i < NOTICE_MAX_VISIBLE + NOTICE_MAX_QUEUED + 1; i++) {
      noticeN(i);
      vi.advanceTimersByTime(10);
    }
    expect(state().notices.map((n) => n.source)).toEqual(["s0", "s1", "s2"]);
    expect(state().queue.map((n) => n.source)).toEqual(["s4", "s5", "s6", "s7", "s8"]);
  });

  it("drops the least recently updated queued notice on overflow", () => {
    for (let i = 0; i < NOTICE_MAX_VISIBLE + NOTICE_MAX_QUEUED; i++) {
      noticeN(i);
      vi.advanceTimersByTime(10);
    }
    noticeN(3); // refresh the first queued notice
    noticeN(99);
    expect(state().queue.map((n) => n.source)).toEqual(["s3", "s5", "s6", "s7", "s99"]);
  });

  it("starts the display timer of a queued notice only when it becomes visible", () => {
    for (let i = 0; i < 4; i++) noticeN(i);
    vi.advanceTimersByTime(SHORT_MS);
    expect(state().notices.map((n) => n.source)).toEqual(["s3"]);
    vi.advanceTimersByTime(SHORT_MS - 1);
    expect(state().notices).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(state().notices).toHaveLength(0);
  });

  it("drops a queued notice not updated for 10 s; a repeat refreshes its update time", () => {
    registerNotificationCode("test.long", { severity: "warning", message: () => "x".repeat(200) });
    for (let i = 0; i < 3; i++) notify({ source: `l${i}`, code: "test.long" });
    noticeN(3);
    noticeN(4);
    vi.advanceTimersByTime(5000);
    noticeN(4);
    // Repeats keep the visible notices alive until their 12 s cap, so the queue can age.
    for (let i = 0; i < 3; i++) notify({ source: `l${i}`, code: "test.long" });
    vi.advanceTimersByTime(5000);
    expect(state().queue.map((q) => q.source)).toEqual(["s4"]);
    vi.advanceTimersByTime(2000);
    expect(state().notices.map((n) => n.source)).toEqual(["s4"]);
  });

  it("updates a visible repeat in place and restarts its timer", () => {
    notify({ source: "a", code: "test.notice_at", params: { x: 1 } });
    vi.advanceTimersByTime(3000);
    notify({ source: "a", code: "test.notice_at", params: { x: 2 } });
    expect(state().notices).toHaveLength(1);
    expect(state().notices[0].params).toEqual({ x: 2 });
    vi.advanceTimersByTime(4000);
    expect(state().notices).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(state().notices).toHaveLength(0);
  });

  it("updates a queued repeat in place", () => {
    for (let i = 0; i < 3; i++) noticeN(i);
    notify({ source: "q", code: "test.notice_at", params: { x: 1 } });
    notify({ source: "q", code: "test.notice_at", params: { x: 2 } });
    expect(state().queue).toHaveLength(1);
    expect(state().queue[0].params).toEqual({ x: 2 });
  });

  it("keeps notices with different dedupParams separate", () => {
    notify({ source: "a", code: "test.notice_by_floor", params: { floor: 1, x: 1 } });
    notify({ source: "a", code: "test.notice_by_floor", params: { floor: 2, x: 1 } });
    notify({ source: "a", code: "test.notice_by_floor", params: { floor: 1, x: 5 } });
    expect(state().notices.map((n) => n.params)).toEqual([{ floor: 1, x: 5 }, { floor: 2, x: 1 }]);
  });

  it("caps total active display at 12 s and then suppresses the key for 5 s", () => {
    noticeN(0);
    for (let t = 0; t < 11_000; t += 1000) {
      vi.advanceTimersByTime(1000);
      noticeN(0);
    }
    vi.advanceTimersByTime(999);
    expect(state().notices).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(state().notices).toHaveLength(0);

    noticeN(0);
    expect(state().notices).toHaveLength(0);
    vi.advanceTimersByTime(4999);
    noticeN(0);
    expect(state().notices).toHaveLength(0);
    vi.advanceTimersByTime(1);
    noticeN(0);
    expect(state().notices).toHaveLength(1);
  });

  it("does not suppress after normal expiry or manual close", () => {
    noticeN(0);
    vi.advanceTimersByTime(SHORT_MS);
    noticeN(0);
    expect(state().notices).toHaveLength(1);
    closeNotice(state().notices[0].id);
    noticeN(0);
    expect(state().notices).toHaveLength(1);
  });

  it("pauses display and queue aging while the zone is hovered", () => {
    for (let i = 0; i < 4; i++) noticeN(i);
    vi.advanceTimersByTime(1000);
    setNoticeZonePaused(true);
    vi.advanceTimersByTime(60_000);
    expect(state().notices).toHaveLength(3);
    expect(state().queue).toHaveLength(1);
    setNoticeZonePaused(false);
    vi.advanceTimersByTime(SHORT_MS - 1000 - 1);
    expect(state().notices).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(state().notices.map((n) => n.source)).toEqual(["s3"]);
  });

  it("counts only active time towards the 12 s cap", () => {
    noticeN(0);
    for (let t = 0; t < 6; t++) {
      vi.advanceTimersByTime(1000);
      noticeN(0);
    }
    setNoticeZonePaused(true);
    vi.advanceTimersByTime(30_000);
    setNoticeZonePaused(false);
    // 6 s active so far; the cap is reached after 6 s more.
    for (let t = 0; t < 5; t++) {
      vi.advanceTimersByTime(1000);
      noticeN(0);
    }
    vi.advanceTimersByTime(999);
    expect(state().notices).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(state().notices).toHaveLength(0);
  });

  it("promotes a queued notice on manual close", () => {
    for (let i = 0; i < 4; i++) noticeN(i);
    closeNotice(state().notices[1].id);
    expect(state().notices.map((n) => n.source)).toEqual(["s0", "s2", "s3"]);
    expect(state().queue).toHaveLength(0);
  });

  it("close all clears visible and queued notices", () => {
    for (let i = 0; i < 5; i++) noticeN(i);
    closeAllNotices();
    expect(state().notices).toHaveLength(0);
    expect(state().queue).toHaveLength(0);
  });

  it("announces a notice politely once, when it becomes visible", () => {
    for (let i = 0; i < 4; i++) noticeN(i);
    noticeN(0);
    noticeN(3);
    expect(announced("polite")).toHaveLength(3);
    vi.advanceTimersByTime(SHORT_MS);
    expect(announced("polite")).toHaveLength(4);
  });
});

describe("error zone", () => {
  it("aggregates by source + code regardless of params", () => {
    notify({ source: "a", code: "test.error", params: { n: 1 }, details: "d1" });
    notify({ source: "a", code: "test.error", params: { n: 2 }, details: "d2" });
    notify({ source: "b", code: "test.error", params: { n: 3 } });
    expect(state().errors).toHaveLength(2);
    expect(state().errors[0].occurrences.map((o) => [o.params, o.details])).toEqual([[{ n: 1 }, "d1"], [{ n: 2 }, "d2"]]);
  });

  it("moves a card with a new occurrence to the bottom", () => {
    notify({ source: "a", code: "test.error", params: { n: 1 } });
    notify({ source: "a", code: "test.error_b" });
    notify({ source: "a", code: "test.error", params: { n: 2 } });
    expect(state().errors.map((c) => c.code)).toEqual(["test.error_b", "test.error"]);
  });

  it("never auto-dismisses", () => {
    notify({ source: "a", code: "test.error" });
    vi.advanceTimersByTime(10 * 60_000);
    expect(state().errors).toHaveLength(1);
  });

  it("keeps at most 20 occurrences across cards, removing emptied cards", () => {
    notify({ source: "a", code: "test.error_b" });
    for (let i = 0; i < ERROR_MAX_OCCURRENCES; i++) notify({ source: "a", code: "test.error", params: { n: i } });
    expect(state().errors.map((c) => c.code)).toEqual(["test.error"]);
    expect(state().errors[0].occurrences).toHaveLength(ERROR_MAX_OCCURRENCES);
    notify({ source: "a", code: "test.error", params: { n: 99 } });
    const occ = state().errors[0].occurrences;
    expect(occ).toHaveLength(ERROR_MAX_OCCURRENCES);
    expect(occ[0].params).toEqual({ n: 1 });
    expect(occ[occ.length - 1].params).toEqual({ n: 99 });
  });

  it("drops the oldest occurrence even when it is not in the first card", () => {
    notify({ source: "a", code: "test.error", params: { n: 0 } });
    notify({ source: "a", code: "test.error_b" });
    for (let i = 1; i < ERROR_MAX_OCCURRENCES - 1; i++) notify({ source: "a", code: "test.error", params: { n: i } });
    // Order is now [error_b(oldest-but-one), error(n0 … n18)]; the oldest occurrence (n0) is in the second card.
    notify({ source: "a", code: "test.error_b" });
    const error = state().errors.find((c) => c.code === "test.error")!;
    expect(error.occurrences[0].params).toEqual({ n: 1 });
    expect(state().errors.find((c) => c.code === "test.error_b")!.occurrences).toHaveLength(2);
  });

  it("announces assertively once per new card only", () => {
    notify({ source: "a", code: "test.error", params: { n: 1 } });
    notify({ source: "a", code: "test.error", params: { n: 2 } });
    notify({ source: "a", code: "test.error_b" });
    expect(announced("assertive")).toEqual(["Failed 1", "Other failure"]);
    expect(announced("polite")).toEqual([]);
  });

  it("close card and close all", () => {
    notify({ source: "a", code: "test.error" });
    notify({ source: "a", code: "test.error_b" });
    closeErrorCard(state().errors[0].key);
    expect(state().errors.map((c) => c.code)).toEqual(["test.error_b"]);
    closeAllErrors();
    expect(state().errors).toHaveLength(0);
  });

  it("is independent of the notice zone", () => {
    for (let i = 0; i < 3; i++) notify({ source: "a", code: `test.error${i === 0 ? "" : "_b"}`, params: { n: i } });
    noticeN(0);
    expect(state().notices).toHaveLength(1);
    closeAllNotices();
    expect(state().errors).toHaveLength(2);
    noticeN(1);
    closeAllErrors();
    expect(state().notices).toHaveLength(1);
  });

  it("rejects unregistered codes", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    notify({ source: "a", code: "test.unknown" });
    expect(state().notices).toHaveLength(0);
    expect(state().errors).toHaveLength(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
