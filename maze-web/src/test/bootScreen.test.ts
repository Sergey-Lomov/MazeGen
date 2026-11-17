import { afterEach, describe, expect, it, vi } from "vitest";
import { setBootScreenStatus, showBootScreenError } from "../startup/bootScreen";

afterEach(() => {
  document.body.replaceChildren();
});

describe("setBootScreenStatus", () => {
  it("updates the status and exposes a determinate progress value", () => {
    document.body.innerHTML = '<div id="boot-status"></div><div id="boot-progress-track"><div id="boot-progress-bar"></div></div><div id="boot-progress-value"></div>';

    setBootScreenStatus("Loading engine", 0.425);

    expect(document.getElementById("boot-status")).toHaveTextContent("Loading engine");
    expect(document.getElementById("boot-progress-value")).toHaveTextContent("43%");
    expect(document.getElementById("boot-progress-track")).toHaveAttribute("aria-valuenow", "43");
    expect(document.getElementById("boot-progress-bar")).not.toHaveClass("loading-progress-indeterminate");
  });

  it("clears the numeric value for an indeterminate stage", () => {
    document.body.innerHTML = '<div id="boot-status"></div><div id="boot-progress-track" aria-valuenow="50"><div id="boot-progress-bar"></div></div><div id="boot-progress-value">50%</div>';

    setBootScreenStatus("Preparing interface");

    expect(document.getElementById("boot-progress-value")).toBeEmptyDOMElement();
    expect(document.getElementById("boot-progress-track")).not.toHaveAttribute("aria-valuenow");
    expect(document.getElementById("boot-progress-bar")).toHaveClass("loading-progress-indeterminate");
  });
});

describe("showBootScreenError", () => {
  it("backs off instead of resolving at once when the loading screen is gone", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      void showBootScreenError("Engine failed", "Retry").then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  const screen = '<div class="boot-content"><div id="boot-status"></div><div id="boot-progress-track"><div id="boot-progress-bar"></div></div><div id="boot-progress-value"></div></div>';

  it("shows the message with a retry button and hides the progress bar", () => {
    document.body.innerHTML = screen;

    void showBootScreenError("Engine failed", "Retry");

    expect(document.getElementById("boot-status")).toHaveTextContent("Engine failed");
    expect(document.getElementById("boot-progress-track")).not.toBeVisible();
    expect(document.getElementById("boot-retry")).toHaveTextContent("Retry");
  });

  it("restores the loading state and resolves when retry is clicked", async () => {
    document.body.innerHTML = screen;

    const retried = showBootScreenError("Engine failed", "Retry");
    document.getElementById("boot-retry")!.click();
    await retried;

    expect(document.getElementById("boot-retry")).toBeNull();
    expect(document.getElementById("boot-status")).not.toHaveClass("boot-error");
    expect(document.getElementById("boot-progress-track")).toBeVisible();
  });
});
