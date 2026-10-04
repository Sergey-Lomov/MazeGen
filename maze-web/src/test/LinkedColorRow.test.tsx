import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LinkedColorRow } from "../components/features/LinkedRows";
import { LinkContextProvider } from "../components/features/LinkContext";
import type { ParamDescriptor, ParamLink } from "../store/parameterLinks";
import * as m from "~/paraglide/messages";

vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (cfg: { points: [number, number][] }) => cfg.points.map(([x, y]: [number, number]) => [x, y]),
}));

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => { vi.unstubAllGlobals(); });

type P = "source" | "target";

const registry: Record<P, ParamDescriptor> = {
  source: { type: "color", equals: Object.is, label: "Source", group: [], format: String },
  target: { type: "color", equals: Object.is, label: "Target", group: [], format: String },
};

const hexLabel = () => m["color_picker.hex_label"]();
const cancelLabel = () => m["common.cancel"]();
const applyLabel = () => m["common.apply"]();

function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: "" }));
}

// GitHub issue #666: cancelling a color-picker edit on a linked field must not leave the field's
// incoming link disabled (overridden), even though every preview/commit tick while the picker was
// open did disable it (correct for a real edit) — Cancel undoes the whole session.
describe("LinkedColorRow cancel/override interaction (GitHub issue #666)", () => {
  function renderRow(links: ParamLink<P>[], onChange = vi.fn(), onSetLinkEnabled = vi.fn()) {
    return render(
      <LinkContextProvider value={{ links, registry, onSetLinkEnabled, onAddLink: vi.fn() }}>
        <LinkedColorRow label="Target" color={0x000000} onChange={onChange} linkTarget="target" />
      </LinkContextProvider>,
    );
  }

  it("re-enables a link that was enabled on open after Cancel, via onSetLinkEnabled", () => {
    const onSetLinkEnabled = vi.fn();
    const links: ParamLink<P>[] = [{ id: "l1", source: "source", target: "target", enabled: true }];
    renderRow(links, vi.fn(), onSetLinkEnabled);
    openPicker();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#abcdef" } });
    fireEvent.click(screen.getByText(cancelLabel()));
    expect(onSetLinkEnabled).toHaveBeenCalledWith("target", true);
  });

  it("does not call onSetLinkEnabled on Cancel when the link was already disabled before open", () => {
    const onSetLinkEnabled = vi.fn();
    const links: ParamLink<P>[] = [{ id: "l1", source: "source", target: "target", enabled: false }];
    renderRow(links, vi.fn(), onSetLinkEnabled);
    openPicker();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#abcdef" } });
    fireEvent.click(screen.getByText(cancelLabel()));
    expect(onSetLinkEnabled).not.toHaveBeenCalled();
  });

  it("does not call onSetLinkEnabled on Cancel when there is no link at all for this field", () => {
    const onSetLinkEnabled = vi.fn();
    renderRow([], vi.fn(), onSetLinkEnabled);
    openPicker();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#abcdef" } });
    fireEvent.click(screen.getByText(cancelLabel()));
    expect(onSetLinkEnabled).not.toHaveBeenCalled();
  });

  it("does not call onSetLinkEnabled on Apply (a real commit keeps the override)", () => {
    const onSetLinkEnabled = vi.fn();
    const links: ParamLink<P>[] = [{ id: "l1", source: "source", target: "target", enabled: true }];
    renderRow(links, vi.fn(), onSetLinkEnabled);
    openPicker();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#abcdef" } });
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onSetLinkEnabled).not.toHaveBeenCalled();
  });

  it("restores enabled state from whatever it was at open time, not the latest render's links prop", () => {
    // The link starts enabled; re-rendering with a changed `links` prop (as the store would after a
    // preview tick disables it) must not affect what the snapshot captured at open.
    const onSetLinkEnabled = vi.fn();
    const links: ParamLink<P>[] = [{ id: "l1", source: "source", target: "target", enabled: true }];
    const { rerender } = renderRow(links, vi.fn(), onSetLinkEnabled);
    openPicker();
    const disabledLinks: ParamLink<P>[] = [{ id: "l1", source: "source", target: "target", enabled: false }];
    rerender(
      <LinkContextProvider value={{ links: disabledLinks, registry, onSetLinkEnabled, onAddLink: vi.fn() }}>
        <LinkedColorRow label="Target" color={0x000000} onChange={vi.fn()} linkTarget="target" />
      </LinkContextProvider>,
    );
    fireEvent.click(screen.getByText(cancelLabel()));
    expect(onSetLinkEnabled).toHaveBeenCalledWith("target", true);
  });
});
