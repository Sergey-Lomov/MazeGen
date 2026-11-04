import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BasicConfigFeature } from "../components/features/BasicConfigFeature";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";

describe("BasicConfigFeature keyboard confirmation", () => {
  let confirmTessellation = vi.fn<() => void>();

  beforeEach(() => {
    confirmTessellation = vi.fn<() => void>();
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

  it("restores the preview to the confirmed settings when the warning is cancelled", () => {
    useMazeStore.setState({ confirmTessellation: useMazeStore.getInitialState().confirmTessellation });
    useMazeStore.getState().setPreviewKind("square");
    useMazeStore.getState().confirmTessellation();
    useMazeStore.setState({ mazeDirty: true });
    useMazeStore.getState().setPreviewKind("hex");
    render(<BasicConfigFeature />);

    fireEvent.click(screen.getByText(m["tessellation.confirm_btn"]()));
    fireEvent.click(screen.getByText(m["common.cancel"]()));

    expect(useMazeStore.getState().previewKind).toBe("square");
    expect(useMazeStore.getState().tessellationKind).toBe("square");
  });
});
