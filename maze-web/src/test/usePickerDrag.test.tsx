import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, createEvent } from "@testing-library/react";
import { usePickerDrag, type Frac } from "../components/usePickerDrag";

/** jsdom's PointerEvent ctor ignores clientX/clientY — build the event, then patch the coords on
 *  (all the hook reads). `fireEvent(target, e)` for React handlers; `dispatchEvent` for window. */
function firePointer(target: Window | HTMLElement, type: "pointerdown" | "pointermove" | "pointerup", clientX: number, clientY: number) {
  const el = target === window ? document.body : (target as HTMLElement);
  const e = createEvent[type === "pointerdown" ? "pointerDown" : type === "pointermove" ? "pointerMove" : "pointerUp"](el);
  Object.assign(e, { clientX, clientY, pointerId: 1 });
  if (target === window) window.dispatchEvent(e);
  else fireEvent(target as HTMLElement, e);
}

/** Minimal host: a 200×100 box wired to `usePickerDrag`, reporting every `Frac` it receives. */
function Harness({ onMove }: { onMove: (f: Frac) => void }) {
  const { ref, onPointerDown } = usePickerDrag(onMove);
  return (
    <div ref={ref} data-testid="box" onPointerDown={onPointerDown} />
  );
}

function pinRect(el: HTMLElement) {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

describe("usePickerDrag", () => {
  it("reports the clamped 0-1 fraction on pointer-down and while dragging, stops on pointer-up", () => {
    const seen: Frac[] = [];
    const { getByTestId } = render(<Harness onMove={(f) => seen.push(f)} />);
    const box = getByTestId("box");
    pinRect(box);

    box.setPointerCapture = vi.fn();
    firePointer(box, "pointerdown", 100, 25);
    expect(seen.at(-1)).toEqual({ x: 0.5, y: 0.25 });

    firePointer(window, "pointermove", 300, -50);
    expect(seen.at(-1)).toEqual({ x: 1, y: 0 }); // clamped

    firePointer(window, "pointerup", 0, 0);
    const count = seen.length;
    firePointer(window, "pointermove", 10, 10);
    expect(seen.length).toBe(count); // drag ended — no more reports
  });

  it("removes its window listeners on unmount", () => {
    const seen: Frac[] = [];
    const { getByTestId, unmount } = render(<Harness onMove={(f) => seen.push(f)} />);
    const box = getByTestId("box");
    pinRect(box);
    box.setPointerCapture = vi.fn();
    firePointer(box, "pointerdown", 0, 0);
    unmount();
    firePointer(window, "pointermove", 50, 50);
    expect(seen.length).toBe(1); // only the pointer-down report
  });
});
