import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { NoExportRendererHint } from "../components/NoExportRendererHint";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import * as m from "~/paraglide/messages";

beforeEach(() => {
  useMazeStore.setState({ ...baseStoreState(), openCard: "image_export", activeRenderMode: null });
});

describe("NoExportRendererHint", () => {
  it("shows while Image Export is open with no renderer, and hides once one is chosen", () => {
    render(<NoExportRendererHint />);
    expect(screen.getByText(m["image_export.no_renderer_hint"]())).toBeTruthy();
    act(() => useMazeStore.setState({ activeRenderMode: "vector_by_walls" }));
    expect(screen.queryByText(m["image_export.no_renderer_hint"]())).toBeNull();
  });

  it("stays hidden when another card is open", () => {
    useMazeStore.setState({ openCard: "generation" });
    render(<NoExportRendererHint />);
    expect(screen.queryByText(m["image_export.no_renderer_hint"]())).toBeNull();
  });
});
