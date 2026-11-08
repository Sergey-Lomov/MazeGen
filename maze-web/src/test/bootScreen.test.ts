import { afterEach, describe, expect, it } from "vitest";
import { setBootScreenStatus } from "../startup/bootScreen";

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
