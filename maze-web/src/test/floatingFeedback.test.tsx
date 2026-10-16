import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as floating from "@floating-ui/react-dom";
import { Tooltip, TOOLTIP_HOVER_DELAY_MS } from "../components/Tooltip";
import { useFieldHint, type FieldHintController, type FieldHintReason } from "../components/FieldHint";
import { FLOATING_Z_INDEX } from "../components/floating/floatingPosition";
import { ColorRow, UnregisteredColorRow } from "../components/ColorRow";
import { ColorVisibilityProvider } from "../components/ColorVisibilityContext";
import type { ColorField } from "../pixi/selectors/projectColorsSelector";
import { Announcer } from "../components/Announcer";
import { resetAnnouncer } from "../notifications/announcer";
import { noticeDisplayDuration } from "../notifications/notificationStore";
import { setLocale } from "../i18n/localeStore";
import { overlay } from "../styles/theme";
import { getLocale } from "~/paraglide/runtime";

vi.mock("@floating-ui/react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@floating-ui/react-dom")>();
  return { ...actual, useFloating: vi.fn(actual.useFloating) };
});

/** jsdom has no `PointerEvent`, so `pointerType` is not set from the init dict. */
function tap(el: Element) {
  const event = createEvent.pointerDown(el);
  Object.defineProperty(event, "pointerType", { value: "touch" });
  fireEvent(el, event);
}

const politeTexts = () => Array.from(screen.getByTestId("announcer-polite").children).map((c) => c.textContent);

beforeEach(() => resetAnnouncer());

afterEach(() => {
  cleanup();
  act(() => resetAnnouncer());
  vi.useRealTimers();
  vi.mocked(floating.useFloating).mockClear();
});

function expectSharedPlacement() {
  const calls = vi.mocked(floating.useFloating).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const options = calls[calls.length - 1][0]!;
  expect(options.middleware?.map((mw) => mw && mw.name).slice(0, 3)).toEqual(["offset", "flip", "shift"]);
  expect(options.whileElementsMounted).toBe(floating.autoUpdate);
  expect(options.strategy).toBe("fixed");
}

describe("Tooltip", () => {
  it("links aria-describedby to the content from a focusable wrapper", () => {
    render(<Tooltip content="Locked by group colors"><button disabled>X</button></Tooltip>);
    const anchor = screen.getByTestId("tooltip-anchor");
    expect(anchor.tabIndex).toBe(0);
    const description = document.getElementById(anchor.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe("Locked by group colors");
  });

  it("is inert without content", () => {
    render(<Tooltip content={undefined}><button>X</button></Tooltip>);
    const anchor = screen.getByTestId("tooltip-anchor");
    expect(anchor.hasAttribute("tabindex")).toBe(false);
    expect(anchor.hasAttribute("aria-describedby")).toBe(false);
    fireEvent.focus(anchor);
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  it("shows on focus in a body portal above modals with flip/shift placement", () => {
    const { container } = render(<Tooltip content="Why"><span>X</span></Tooltip>);
    fireEvent.focus(screen.getByTestId("tooltip-anchor"));
    const bubble = screen.getByTestId("tooltip");
    expect(container.contains(bubble)).toBe(false);
    expect(bubble.parentElement).toBe(document.body);
    expect(Number(bubble.style.zIndex)).toBe(FLOATING_Z_INDEX);
    expect(FLOATING_Z_INDEX).toBeGreaterThan(overlay.zIndex);
    expectSharedPlacement();
    fireEvent.blur(screen.getByTestId("tooltip-anchor"));
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  it("shows on hover after a delay and hides on leave", () => {
    vi.useFakeTimers();
    render(<Tooltip content="Why"><span>X</span></Tooltip>);
    const anchor = screen.getByTestId("tooltip-anchor");
    fireEvent.pointerEnter(anchor, { pointerType: "mouse" });
    expect(screen.queryByTestId("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    expect(screen.getByTestId("tooltip")).toBeTruthy();
    fireEvent.pointerLeave(anchor, { pointerType: "mouse" });
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  it("shows on tap and hides on tap outside", () => {
    render(<><Tooltip content="Why"><span>X</span></Tooltip><div data-testid="outside" /></>);
    tap(screen.getByTestId("tooltip-anchor"));
    expect(screen.getByTestId("tooltip")).toBeTruthy();
    tap(screen.getByTestId("outside"));
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  it("hides on Escape", () => {
    render(<Tooltip content="Why"><span>X</span></Tooltip>);
    const anchor = screen.getByTestId("tooltip-anchor");
    fireEvent.focus(anchor);
    fireEvent.keyDown(anchor, { key: "Escape" });
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  it("ColorRow exposes its disabledHint through the tooltip, not the native title", () => {
    const { container, rerender } = render(<UnregisteredColorRow label="Fill" color={0} onChange={() => {}} disabled disabledHint="Set by group" />);
    expect(container.querySelector("[title='Set by group']")).toBeNull();
    const anchor = screen.getByTestId("tooltip-anchor");
    expect(document.getElementById(anchor.getAttribute("aria-describedby")!)?.textContent).toBe("Set by group");
    rerender(<UnregisteredColorRow label="Fill" color={0} onChange={() => {}} disabledHint="Set by group" />);
    expect(screen.getByTestId("tooltip-anchor").hasAttribute("aria-describedby")).toBe(false);
  });

  it("ColorRow hides the caller's disabledHint when the row is disabled only by field visibility", () => {
    const hiddenField = { key: "fill", name: () => "Fill", at: (color: number) => ({ key: "fill", name: "Fill", color }), isVisible: () => false } as unknown as ColorField;
    render(
      <ColorVisibilityProvider value={{} as never}>
        <ColorRow label="Fill" color={0} onChange={() => {}} field={hiddenField} disabledHint="Set by group" />
      </ColorVisibilityProvider>,
    );
    expect(screen.getByTestId("tooltip-anchor").hasAttribute("aria-describedby")).toBe(false);
  });
});

const tooLong: FieldHintReason = { key: "too_long", message: () => (getLocale() === "ru" ? "Слишком длинно" : "Too long") };
const rounded: FieldHintReason = { key: "rounded", message: () => "Rounded" };
const sameDuration: FieldHintReason = { key: "same_duration", message: () => "Too long" };

/** Notice-toast duration of "Too long" — the field-hint timer uses the same formula. */
const HINT_MS = noticeDisplayDuration("Too long");

let controller: FieldHintController;
function HintedField({ withLabel = false }: { withLabel?: boolean }) {
  const hint = useFieldHint();
  controller = hint;
  return (
    <div>
      {withLabel && <span data-testid="label" ref={hint.labelRef}>Size</span>}
      <input data-testid="field" ref={hint.anchorRef} aria-describedby={hint.describedBy} style={{ width: 64, ...hint.fieldStyle }} />
      {hint.hint}
    </div>
  );
}

function renderField() {
  return render(<><HintedField /><Announcer /></>);
}

describe("useFieldHint", () => {
  it("renders in a body portal with flip/shift placement and links aria-describedby", () => {
    const { container } = renderField();
    act(() => controller.show(tooLong));
    const hint = screen.getByTestId("field-hint");
    expect(container.contains(hint)).toBe(false);
    expect(hint.parentElement).toBe(document.body);
    expect(Number(hint.style.zIndex)).toBe(FLOATING_Z_INDEX);
    expect(screen.getByTestId("field").getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint.hasAttribute("role")).toBe(false);
    expect(hint.hasAttribute("aria-live")).toBe(false);
    expectSharedPlacement();
  });

  it("announces once; a repeat of the same reason is silent, a new reason replaces it", () => {
    renderField();
    act(() => controller.show(tooLong));
    act(() => controller.show(tooLong));
    expect(politeTexts()).toEqual(["Too long"]);
    expect(screen.getAllByTestId("field-hint")).toHaveLength(1);
    act(() => controller.show(rounded));
    expect(screen.getAllByTestId("field-hint")).toHaveLength(1);
    expect(screen.getByTestId("field-hint").textContent).toBe("Rounded");
    expect(politeTexts()).toEqual(["Too long", "Rounded"]);
  });

  it("closes after the active duration; a repeat restarts the timer", () => {
    vi.useFakeTimers();
    renderField();
    act(() => controller.show(tooLong));
    act(() => vi.advanceTimersByTime(HINT_MS - 1000));
    act(() => controller.show(tooLong));
    act(() => vi.advanceTimersByTime(HINT_MS - 1000));
    expect(screen.getByTestId("field-hint")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByTestId("field-hint")).toBeNull();
    expect(screen.getByTestId("field").hasAttribute("aria-describedby")).toBe(false);
  });

  it("pauses while hovered", () => {
    vi.useFakeTimers();
    renderField();
    act(() => controller.show(tooLong));
    act(() => vi.advanceTimersByTime(HINT_MS - 1000));
    expect(screen.getByTestId("field-hint-countdown").style.animationPlayState).toBe("running");
    fireEvent.mouseEnter(screen.getByTestId("field-hint"));
    expect(screen.getByTestId("field-hint-countdown").style.animationPlayState).toBe("paused");
    act(() => vi.advanceTimersByTime(HINT_MS * 2));
    expect(screen.getByTestId("field-hint")).toBeTruthy();
    fireEvent.mouseLeave(screen.getByTestId("field-hint"));
    act(() => vi.advanceTimersByTime(999));
    expect(screen.getByTestId("field-hint")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId("field-hint")).toBeNull();
  });

  it("restarts the timer when a new reason replaces the current message", () => {
    vi.useFakeTimers();
    renderField();
    act(() => controller.show(tooLong));
    act(() => vi.advanceTimersByTime(HINT_MS - 1000));
    act(() => controller.show(rounded));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByTestId("field-hint")).toBeTruthy();
    act(() => vi.advanceTimersByTime(noticeDisplayDuration("Rounded") - 1000));
    expect(screen.queryByTestId("field-hint")).toBeNull();
  });

  it("restarts the timer when a new reason has the same message duration", () => {
    vi.useFakeTimers();
    renderField();
    act(() => controller.show(tooLong));
    act(() => vi.advanceTimersByTime(HINT_MS - 1000));
    act(() => controller.show(sameDuration));
    act(() => vi.advanceTimersByTime(HINT_MS - 1000));
    expect(screen.getByTestId("field-hint")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByTestId("field-hint")).toBeNull();
  });

  it("closes on dismiss, on its close button and on unmount; refocus keeps it", () => {
    const { unmount } = renderField();
    act(() => controller.show(tooLong));
    fireEvent.blur(screen.getByTestId("field"));
    fireEvent.focus(screen.getByTestId("field"));
    expect(screen.getByTestId("field-hint")).toBeTruthy();
    expect(screen.getByTestId("field").style.outline).not.toBe("");
    act(() => controller.dismiss());
    expect(screen.queryByTestId("field-hint")).toBeNull();
    expect(screen.getByTestId("field").style.outline).toBe("");
    expect(screen.getByTestId("field").style.width).toBe("64px");

    act(() => controller.show(tooLong));
    expect(politeTexts()).toEqual(["Too long", "Too long"]);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByTestId("field-hint")).toBeNull();

    act(() => controller.show(rounded));
    unmount();
    expect(document.querySelector("[data-testid='field-hint']")).toBeNull();
  });

  it("spans from the label to the field when a label is attached, outlining the field", () => {
    render(<HintedField withLabel />);
    const rect = (left: number, right: number) => ({ x: left, y: 10, left, top: 10, right, bottom: 30, width: right - left, height: 20, toJSON: () => ({}) });
    screen.getByTestId("label").getBoundingClientRect = () => rect(20, 80);
    screen.getByTestId("field").getBoundingClientRect = () => rect(100, 160);
    act(() => controller.show(tooLong));
    const options = vi.mocked(floating.useFloating).mock.calls.at(-1)![0]!;
    expect(options.middleware?.map((mw) => mw && mw.name)).toContain("size");
    const reference = vi.mocked(floating.useFloating).mock.results.at(-1)!.value.refs.reference.current;
    const span = reference.getBoundingClientRect();
    expect([span.left, span.right, span.width]).toEqual([20, 160, 140]);
    expect(screen.getByTestId("field").style.outline).not.toBe("");
  });

  it("is at least as wide as the label-to-field span", async () => {
    render(<HintedField withLabel />);
    const rect = (left: number, right: number) => ({ x: left, y: 10, left, top: 10, right, bottom: 30, width: right - left, height: 20, toJSON: () => ({}) });
    screen.getByTestId("label").getBoundingClientRect = () => rect(20, 80);
    screen.getByTestId("field").getBoundingClientRect = () => rect(100, 160);
    act(() => controller.show(tooLong));
    await waitFor(() => expect(screen.getByTestId("field-hint").style.minWidth).toBe("140px"));
    expect(screen.getByTestId("field-hint").style.width).toBe("");
  });

  it("does nothing without a mounted field", () => {
    function Unanchored() {
      controller = useFieldHint();
      return <>{controller.hint}</>;
    }
    render(<><Unanchored /><Announcer /></>);
    act(() => controller.show(tooLong));
    expect(screen.queryByTestId("field-hint")).toBeNull();
    expect(politeTexts()).toEqual([]);
  });

  it("re-translates in place on locale switch without re-announcing", () => {
    renderField();
    act(() => controller.show(tooLong));
    try {
      act(() => setLocale("ru"));
      expect(screen.getByTestId("field-hint").textContent).toBe("Слишком длинно");
      expect(politeTexts()).toEqual(["Too long"]);
    } finally {
      act(() => setLocale("en"));
    }
  });
});
