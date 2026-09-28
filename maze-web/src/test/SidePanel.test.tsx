import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidePanel } from "../components/SidePanel";

// GitHub issue #629: independently-toggled features (e.g. `DebugPanel` and
// `VertexBasedSettingsPanel`, or the post-edit "Changes" and "Manage split nodes" panels) may each
// mount their own `SidePanel` at once with no coordination between them. Only the most recently
// mounted instance should be visible; unmounting it should reveal the one mounted before it,
// instead of both showing at once or the slot going empty.

describe("SidePanel mount-order stack (GitHub issue #629)", () => {
  it("shows only the most recently mounted panel, hiding the earlier one", () => {
    const { rerender } = render(
      <SidePanel title="First" onClose={vi.fn()}>first content</SidePanel>,
    );
    expect(screen.getByText("First")).toBeVisible();

    rerender(
      <>
        <SidePanel title="First" onClose={vi.fn()}>first content</SidePanel>
        <SidePanel title="Second" onClose={vi.fn()}>second content</SidePanel>
      </>,
    );

    expect(screen.getByText("Second")).toBeVisible();
    // Still mounted (its content is in the DOM), just hidden — not unmounted, so its own internal
    // state (e.g. scroll position, a draft) survives underneath.
    expect(screen.getByText("first content")).not.toBeVisible();
  });

  it("restores the previous panel when the top one unmounts", () => {
    const { rerender } = render(
      <>
        <SidePanel title="First" onClose={vi.fn()}>first content</SidePanel>
        <SidePanel title="Second" onClose={vi.fn()}>second content</SidePanel>
      </>,
    );
    expect(screen.getByText("Second")).toBeVisible();
    expect(screen.getByText("First")).not.toBeVisible();

    // Closing the top panel unmounts it (the owning feature drops it from the tree) — the
    // previously-mounted one should reappear, not leave the slot empty.
    rerender(
      <SidePanel title="First" onClose={vi.fn()}>first content</SidePanel>,
    );

    expect(screen.getByText("First")).toBeVisible();
    expect(screen.queryByText("Second")).not.toBeInTheDocument();
  });

  // Regression: the stack used to register instances in a `useEffect`, so when two `SidePanel`s
  // mount together in the very same commit (e.g. two features opening panels from the same parent
  // render), both read the stack as empty on that first render — neither was visible for a frame.
  // Registration now happens eagerly during render, so the second one's first paint already sees
  // the first one on the stack, with no separate `rerender` needed to reach the correct state.
  it("shows the later panel immediately when both mount together in one render, no flash", () => {
    render(
      <>
        <SidePanel title="First" onClose={vi.fn()}>first content</SidePanel>
        <SidePanel title="Second" onClose={vi.fn()}>second content</SidePanel>
      </>,
    );

    expect(screen.getByText("Second")).toBeVisible();
    expect(screen.getByText("First")).not.toBeVisible();
  });

  it("an overlay panel mounted on top of a normal panel is the one shown", () => {
    const { rerender } = render(
      <SidePanel title="Base" onClose={vi.fn()}>base content</SidePanel>,
    );
    expect(screen.getByText("Base")).toBeVisible();

    rerender(
      <>
        <SidePanel title="Base" onClose={vi.fn()}>base content</SidePanel>
        <SidePanel title="Overlay" onClose={vi.fn()} overlay>overlay content</SidePanel>
      </>,
    );

    expect(screen.getByText("Overlay")).toBeVisible();
    expect(screen.getByText("Base")).not.toBeVisible();

    rerender(
      <SidePanel title="Base" onClose={vi.fn()}>base content</SidePanel>,
    );
    expect(screen.getByText("Base")).toBeVisible();
  });
});
