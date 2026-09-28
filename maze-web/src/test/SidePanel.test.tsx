import { describe, it, expect, vi } from "vitest";
import { StrictMode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { SidePanel } from "../components/SidePanel";
import { ConfirmModal } from "../components/ConfirmModal";

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

  // Regression: registering the stack via a render-time push paired with an effect-time-only pop
  // desyncs under `StrictMode`'s mount-cleanup-mount effect cycle — the first cleanup pops the id
  // with nothing to push it back, leaving even a lone panel stuck reading as non-top (hidden). Push
  // and pop now both live in the same `useLayoutEffect`, which stays balanced under that cycle.
  it("stays visible under StrictMode's double effect invocation", () => {
    render(
      <StrictMode>
        <SidePanel title="Only" onClose={vi.fn()}>only content</SidePanel>
      </StrictMode>,
    );

    expect(screen.getByText("Only")).toBeVisible();
  });

  // Regression: an overlay panel takes no width of its own (`position: absolute`), so it relies on
  // whatever's underneath it in the slot to size the slot's width. The base panel below it used to
  // get `display: none` like any other non-topmost entry — dropping it out of flow entirely — which
  // left the slot with nothing to size itself by, collapsing it to zero width and taking the
  // overlay's `inset: 0` down with it (looked like the whole side-panel area vanishing). The base
  // panel must stay in flow (contributing its `width`) while only overlays sit above it.
  it("base panel keeps its width in flow under an overlay, so the slot doesn't collapse", () => {
    const { rerender } = render(
      <SidePanel title="Base" onClose={vi.fn()}>base content</SidePanel>,
    );
    // "Base"'s title span -> header div -> the panel's own root div (the one carrying `width`,
    // `display`, `visibility`).
    const basePanel = screen.getByText("Base").parentElement!.parentElement!;

    rerender(
      <>
        <SidePanel title="Base" onClose={vi.fn()}>base content</SidePanel>
        <SidePanel title="Overlay" onClose={vi.fn()} overlay>overlay content</SidePanel>
      </>,
    );

    expect(screen.getByText("Overlay")).toBeVisible();
    // Not `display: none` — the base panel must stay laid out (`display` still a flex value) so its
    // own `width` keeps sizing the slot; it's merely not painted (`visibility: hidden`).
    expect(basePanel).not.toHaveStyle({ display: "none" });
    expect(basePanel).toHaveStyle({ visibility: "hidden" });
  });
});

// GitHub issue #631: Escape closes the topmost SidePanel, but a Modal dialog stacked on top of it
// must take precedence — Escape then closes only the dialog, leaving the panel open.
describe("SidePanel Escape-to-close (GitHub issue #631)", () => {
  it("closes the panel on Escape", () => {
    const onClose = vi.fn();
    render(<SidePanel title="Panel" onClose={onClose}>content</SidePanel>);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on other keys", () => {
    const onClose = vi.fn();
    render(<SidePanel title="Panel" onClose={onClose}>content</SidePanel>);

    fireEvent.keyDown(window, { key: "Enter" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes only the topmost panel when several are stacked, not the one underneath", () => {
    const onCloseFirst = vi.fn();
    const onCloseSecond = vi.fn();
    render(
      <>
        <SidePanel title="First" onClose={onCloseFirst}>first content</SidePanel>
        <SidePanel title="Second" onClose={onCloseSecond}>second content</SidePanel>
      </>,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onCloseSecond).toHaveBeenCalledTimes(1);
    expect(onCloseFirst).not.toHaveBeenCalled();
  });

  it("defers to an open Modal — Escape closes the dialog, not the panel underneath", () => {
    const onClosePanel = vi.fn();
    const onCancelModal = vi.fn();
    render(
      <>
        <SidePanel title="Panel" onClose={onClosePanel}>content</SidePanel>
        <ConfirmModal message="Discard?" onConfirm={vi.fn()} onCancel={onCancelModal} />
      </>,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onCancelModal).toHaveBeenCalledTimes(1);
    expect(onClosePanel).not.toHaveBeenCalled();
  });

  it("resumes closing on Escape once the Modal on top of it closes", () => {
    const onClosePanel = vi.fn();
    const onCancelModal = vi.fn();
    const { rerender } = render(
      <>
        <SidePanel title="Panel" onClose={onClosePanel}>content</SidePanel>
        <ConfirmModal message="Discard?" onConfirm={vi.fn()} onCancel={onCancelModal} />
      </>,
    );

    rerender(<SidePanel title="Panel" onClose={onClosePanel}>content</SidePanel>);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClosePanel).toHaveBeenCalledTimes(1);
  });
});
