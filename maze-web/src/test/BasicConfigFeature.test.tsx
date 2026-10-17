import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { BasicConfigFeature } from "../components/features/BasicConfigFeature";
import { useMazeStore } from "../store/mazeStore";

describe("BasicConfigFeature keyboard confirmation", () => {
  let confirmTessellation: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    confirmTessellation = vi.fn();
    useMazeStore.setState({
      openCard: "basic_config",
      previewKind: "square",
      tessellationKind: "square",
      confirmTessellation,
    });
  });

  it.each([
    ["Enter", "Enter"],
    ["Space", " "],
  ])("confirms from the open card with %s and clears header focus", (code, key) => {
    render(<BasicConfigFeature />);
    const header = document.createElement("button");
    document.body.append(header);
    header.focus();

    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code, key });
    header.dispatchEvent(event);

    expect(confirmTessellation).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(header);
    header.remove();
  });
});
