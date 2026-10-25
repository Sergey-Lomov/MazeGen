import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getLocale } from "~/paraglide/runtime";
import { NotificationHost, NOTIFICATION_ZONE_WIDTH, NOTIFICATION_Z_INDEX } from "../components/notifications/NotificationHost";
import { Announcer } from "../components/Announcer";
import { Modal } from "../components/Modal";
import { registerNotificationCode } from "../notifications/notificationRegistry";
import { notify, resetNotifications, useNotificationStore } from "../notifications/notificationStore";
import { resetAnnouncer } from "../notifications/announcer";
import { setLocale } from "../i18n/localeStore";
import { overlay } from "../styles/theme";
import { useMazeStore } from "../store/mazeStore";

registerNotificationCode("host.notice", {
  category: "notice",
  message: (p) => (getLocale() === "ru" ? `Отказ ${p.x ?? ""}` : `Rejected ${p.x ?? ""}`).trim(),
});
registerNotificationCode("host.error", {
  category: "error",
  message: (p) => `Failed ${p.n}`,
});

function renderHost() {
  return render(<><NotificationHost canvasLeft={0} /><Announcer /></>);
}

const host = () => document.querySelector<HTMLElement>("[data-testid='notification-host']")!;
const politeTexts = () => Array.from(screen.getByTestId("announcer-polite").children).map((c) => c.textContent);
const assertiveTexts = () => Array.from(screen.getByTestId("announcer-assertive").children).map((c) => c.textContent);

beforeEach(() => {
  resetNotifications();
  resetAnnouncer();
});

afterEach(() => {
  cleanup();
  act(() => {
    resetNotifications();
    resetAnnouncer();
    setLocale("en");
  });
  vi.useRealTimers();
});

describe("NotificationHost", () => {
  it("stays after an open modal in DOM order with a higher z-index", async () => {
    renderHost();
    render(<Modal title="Dialog" onClose={() => {}}>body</Modal>);
    // The host re-appends itself from a MutationObserver callback (a microtask).
    await act(async () => notify({ source: "a", code: "host.notice" }));
    const modalOverlay = screen.getByText("Dialog").closest("div[style*='position: fixed']")!;
    expect(modalOverlay.compareDocumentPosition(host()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(host().parentElement).toBe(document.body);
    const zoneRoot = host().firstElementChild as HTMLElement;
    expect(Number(zoneRoot.style.zIndex)).toBe(NOTIFICATION_Z_INDEX);
    expect(NOTIFICATION_Z_INDEX).toBeGreaterThan(overlay.zIndex);
    expect(zoneRoot.style.width).toBe(`${NOTIFICATION_ZONE_WIDTH}px`);
  });

  it("renders errors above notices", () => {
    renderHost();
    act(() => {
      notify({ source: "a", code: "host.notice" });
      notify({ source: "a", code: "host.error", params: { n: 1 } });
    });
    const errorZone = screen.getByTestId("error-zone");
    const noticeZone = screen.getByTestId("notice-zone");
    expect(errorZone.compareDocumentPosition(noticeZone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows at most 3 notices and Close all from 2 items, counting queued ones", () => {
    renderHost();
    act(() => notify({ source: "s0", code: "host.notice" }));
    expect(screen.queryByText("Close all")).toBeNull();
    act(() => {
      for (let i = 1; i < 5; i++) notify({ source: `s${i}`, code: "host.notice", params: { x: i } });
    });
    expect(screen.getAllByTestId("notice-toast")).toHaveLength(3);
    fireEvent.click(within(screen.getByTestId("notice-zone")).getByText("Close all"));
    expect(screen.queryByTestId("notice-zone")).toBeNull();
    expect(useNotificationStore.getState().queue).toHaveLength(0);
  });

  it("closes a single toast with its close button", () => {
    renderHost();
    act(() => notify({ source: "a", code: "host.notice" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("notice-toast")).toBeNull();
  });

  it("collapses older error cards into an expandable 'N more errors' row", () => {
    renderHost();
    act(() => {
      for (let i = 0; i < 3; i++) notify({ source: `s${i}`, code: "host.error", params: { n: i } });
    });
    expect(screen.getAllByTestId("error-card")).toHaveLength(2);
    expect(within(host()).getByText("Failed 1")).toBeInTheDocument();
    expect(within(host()).getByText("Failed 2")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("more-errors"));
    expect(screen.getAllByTestId("error-card")).toHaveLength(3);
    expect(screen.queryByTestId("more-errors")).toBeNull();
  });

  it("shows the latest occurrence with a counter and lists details newest first", () => {
    renderHost();
    act(() => {
      notify({ source: "a", code: "host.error", params: { n: 1 }, details: "trace 1" });
      notify({ source: "a", code: "host.error", params: { n: 2 }, details: "trace 2" });
    });
    const card = screen.getByTestId("error-card");
    expect(within(card).getByTestId("error-count")).toHaveTextContent("×2");
    fireEvent.click(within(card).getByRole("button", { name: "Details" }));
    const items = within(screen.getByTestId("error-details")).getAllByRole("listitem");
    // The latest occurrence's message is the headline, so only its details are added; an older
    // occurrence with a different message shows that message too. The copy control lives beside
    // the Details label, outside the scrollable list.
    expect(within(items[0]).getByText("trace 2")).toBeInTheDocument();
    expect(within(items[1]).getByText("Failed 1")).toBeInTheDocument();
    expect(within(items[1]).getByText("trace 1")).toBeInTheDocument();
    const copy = within(card).getByRole("button", { name: "Copy" });
    expect(copy).toBeInTheDocument();
    expect(screen.getByTestId("error-details")).not.toContainElement(copy);
    fireEvent.click(within(card).getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByTestId("error-card")).toBeNull();
  });

  it("expands and collapses details in place with aria-expanded", () => {
    renderHost();
    act(() => notify({ source: "a", code: "host.error", params: { n: 1 }, details: "trace" }));
    const toggle = screen.getByRole("button", { name: "Details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.querySelector("svg")).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByTestId("error-card")).getAllByText("Failed 1")).toHaveLength(1);
    expect(screen.getByText("trace")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("error-details")).toBeNull();
  });

  it("shows up to three failure-detail lines before details scroll", () => {
    renderHost();
    act(() => notify({ source: "a", code: "host.error", params: { n: 1 }, details: "line 1\nline 2\nline 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const details = screen.getByTestId("error-details");
    expect(details).toHaveStyle({ scrollbarColor: "#ff6b6b #2a1a1a" });
    expect(details).toHaveStyle({ maxHeight: "48px", overflowY: "auto" });
    expect(details.querySelector("pre")!).toHaveStyle({ lineHeight: "16px" });
  });

  it("has no details toggle when there is nothing to add to the headline", () => {
    renderHost();
    act(() => {
      notify({ source: "a", code: "host.error", params: { n: 1 } });
      notify({ source: "a", code: "host.error", params: { n: 1 } });
    });
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });

  it("copies an occurrence's message and details with an icon button", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderHost();
    act(() => notify({ source: "a", code: "host.error", params: { n: 7 }, details: "stack" }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const copy = screen.getByRole("button", { name: "Copy" });
    expect(copy.textContent).toBe("");
    await act(async () => { fireEvent.click(copy); });
    expect(writeText).toHaveBeenCalledWith("Failed 7\nstack");
  });

  it("copies every occurrence from the details header", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderHost();
    act(() => {
      notify({ source: "a", code: "host.error", params: { n: 1 }, details: "trace 1" });
      notify({ source: "a", code: "host.error", params: { n: 2 }, details: "trace 2" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy" })); });
    expect(writeText).toHaveBeenCalledWith("Failed 2\ntrace 2\n\nFailed 1\ntrace 1");
  });

  it("shows a check mark after copying and restores the copy icon", async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      renderHost();
      act(() => notify({ source: "a", code: "host.error", params: { n: 7 }, details: "stack" }));
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      const copy = screen.getByRole("button", { name: "Copy" });
      const iconBefore = copy.innerHTML;
      await act(async () => { fireEvent.click(copy); });
      expect(copy.innerHTML).not.toBe(iconBefore);
      act(() => { vi.advanceTimersByTime(1500); });
      expect(copy.innerHTML).toBe(iconBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed WASM registry load from its error card", async () => {
    let resolveLoad!: () => void;
    const loadRegistry = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve; }));
    useMazeStore.setState({ registryError: "fetch failed", loadRegistry });
    renderHost();
    act(() => notify({ source: "generation", code: "generation.registry_load_failed", details: "fetch failed" }));

    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(loadRegistry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();

    await act(async () => {
      useMazeStore.setState({ registryError: null });
      resolveLoad();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("error-card")).toBeNull();
  });

  it("makes every button keyboard-focusable", async () => {
    const user = userEvent.setup();
    renderHost();
    act(() => {
      notify({ source: "a", code: "host.notice" });
      notify({ source: "b", code: "host.notice" });
      notify({ source: "a", code: "host.error", params: { n: 1 } });
    });
    const buttons = Array.from(host().querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    const reached = new Set<Element>();
    const focusableElements = host().querySelectorAll("button, [tabindex='0']");
    for (let i = 0; i < focusableElements.length; i++) {
      await user.tab();
      if (document.activeElement) reached.add(document.activeElement);
    }
    buttons.forEach((b) => expect(reached.has(b)).toBe(true));
  });

  it("places Close all below the items it closes", () => {
    renderHost();
    act(() => {
      notify({ source: "a", code: "host.notice" });
      notify({ source: "b", code: "host.notice" });
      notify({ source: "a", code: "host.error", params: { n: 1 } });
      notify({ source: "b", code: "host.error", params: { n: 2 } });
    });
    for (const [zoneId, itemId] of [["notice-zone", "notice-toast"], ["error-zone", "error-card"]]) {
      const zone = screen.getByTestId(zoneId);
      const closeAll = within(zone).getByText("Close all");
      const items = within(zone).getAllByTestId(itemId);
      expect(items[items.length - 1].compareDocumentPosition(closeAll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("shows a countdown line that restarts on repeat and pauses on hover", () => {
    vi.useFakeTimers();
    resetNotifications();
    renderHost();
    act(() => notify({ source: "a", code: "host.notice" }));
    const first = screen.getByTestId("notice-countdown");
    expect(first.style.animationName).toBe("notice-countdown");
    expect(first.style.transform).toBe("scaleX(1)");
    expect(first.style.animationPlayState).toBe("running");

    act(() => { vi.advanceTimersByTime(1000); });
    act(() => notify({ source: "a", code: "host.notice" }));
    const restarted = screen.getByTestId("notice-countdown");
    expect(restarted).not.toBe(first);
    expect(restarted.style.transform).toBe("scaleX(1)");

    fireEvent.mouseEnter(screen.getByTestId("notice-zone"));
    expect(screen.getByTestId("notice-countdown")).toBe(restarted);
    expect(restarted.style.animationPlayState).toBe("paused");
  });

  it("resumes the timers when the hovered zone unmounts", () => {
    vi.useFakeTimers();
    resetNotifications();
    renderHost();
    act(() => {
      notify({ source: "a", code: "host.notice" });
      notify({ source: "b", code: "host.notice" });
    });
    fireEvent.mouseEnter(screen.getByTestId("notice-zone"));
    fireEvent.click(within(screen.getByTestId("notice-zone")).getByText("Close all"));
    expect(useNotificationStore.getState().noticesPaused).toBe(false);
    act(() => notify({ source: "c", code: "host.notice" }));
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.queryByTestId("notice-toast")).toBeNull();
  });

  it("does not move the host while focus is inside it", async () => {
    renderHost();
    await act(async () => notify({ source: "a", code: "host.notice" }));
    const close = within(host()).getByRole("button", { name: "Close" });
    act(() => { close.focus(); });
    const sibling = document.createElement("div");
    await act(async () => { document.body.appendChild(sibling); });
    expect(document.activeElement).toBe(close);
    expect(host().compareDocumentPosition(sibling) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => { close.blur(); });
    const another = document.createElement("div");
    await act(async () => { document.body.appendChild(another); });
    expect(document.body.lastElementChild).toBe(host());
    sibling.remove();
    another.remove();
  });

  it("pauses timers while the zone is hovered", () => {
    vi.useFakeTimers();
    resetNotifications();
    renderHost();
    act(() => notify({ source: "a", code: "host.notice" }));
    fireEvent.mouseEnter(screen.getByTestId("notice-zone"));
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId("notice-toast")).toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByTestId("notice-zone"));
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.queryByTestId("notice-toast")).toBeNull();
  });

  it("announces each text exactly once and has no live roles on toasts", () => {
    renderHost();
    act(() => {
      notify({ source: "a", code: "host.notice", params: { x: 1 } });
      notify({ source: "a", code: "host.notice", params: { x: 2 } });
      notify({ source: "a", code: "host.error", params: { n: 1 } });
      notify({ source: "a", code: "host.error", params: { n: 2 } });
    });
    expect(politeTexts()).toEqual(["Rejected 1"]);
    expect(assertiveTexts()).toEqual(["Failed 1"]);
    expect(host().querySelector("[aria-live], [role='alert'], [role='status']")).toBeNull();
  });

  it("re-translates visible toasts on language switch without re-announcing", () => {
    renderHost();
    act(() => notify({ source: "a", code: "host.notice", params: { x: 3 } }));
    expect(within(host()).getByText("Rejected 3")).toBeInTheDocument();
    act(() => setLocale("ru"));
    expect(within(host()).getByText("Отказ 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Закрыть" })).toBeInTheDocument();
    expect(politeTexts()).toEqual(["Rejected 3"]);
  });
});
