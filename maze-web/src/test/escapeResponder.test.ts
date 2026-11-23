import { afterEach, describe, expect, it, vi } from "vitest";
import { claimEscape, escapePriority } from "../keyboard/escapeResponder";

const releases: (() => void)[] = [];

function claim(responder: () => boolean, priority?: number): void {
  releases.push(claimEscape(responder, priority));
}

function pressEscape(init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape", ...init });
  window.dispatchEvent(event);
  return event;
}

afterEach(() => {
  while (releases.length > 0) releases.pop()!();
});

describe("Escape responder dispatcher", () => {
  it("uses the latest responder at the same priority and consumes that one press", () => {
    const older = vi.fn(() => true);
    const newer = vi.fn(() => true);
    claim(older, escapePriority.transient);
    claim(newer, escapePriority.transient);

    const event = pressEscape();

    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("falls through an inactive responder and honours priority", () => {
    const panel = vi.fn(() => true);
    const inactiveTransient = vi.fn(() => false);
    const modal = vi.fn(() => true);
    claim(panel, escapePriority.panel);
    claim(inactiveTransient, escapePriority.transient);
    claim(modal, escapePriority.modal);

    pressEscape({ key: "", code: "Escape" });
    expect(modal).toHaveBeenCalledOnce();
    expect(inactiveTransient).not.toHaveBeenCalled();
    expect(panel).not.toHaveBeenCalled();

    releases.pop()!();
    pressEscape();
    expect(inactiveTransient).toHaveBeenCalledOnce();
    expect(panel).toHaveBeenCalledOnce();
  });
});
