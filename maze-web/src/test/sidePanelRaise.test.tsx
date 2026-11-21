import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SidePanel } from "../components/SidePanel";
import { useSidePanelOpen } from "../components/sidePanelStack";
import { useMazeStore } from "../store/mazeStore";
import { PANEL_OPENING_ACTIONS } from "../store/sidePanelRaise";

function twoPanels() {
  render(
    <>
      <SidePanel title="Target" stackKey="zone-edit" onClose={vi.fn()}>target content</SidePanel>
      <SidePanel title="Cover" stackKey="cover" onClose={vi.fn()}>cover content</SidePanel>
    </>,
  );
  expect(screen.getByText("target content")).not.toBeVisible();
}

describe("panel-opening store actions raise their panel (GitHub issue #1049)", () => {
  it("names only actions that exist on the store", () => {
    const state = useMazeStore.getState() as unknown as Record<string, unknown>;
    for (const { name } of PANEL_OPENING_ACTIONS) expect(typeof state[name], name).toBe("function");
  });

  it("raises on an open call even when it changes nothing, including a falsy id", () => {
    twoPanels();
    act(() => useMazeStore.getState().setZoneEditId(0));
    expect(screen.getByText("target content")).toBeVisible();
  });

  it("does not raise on a close or clear call", () => {
    twoPanels();
    act(() => useMazeStore.getState().setZoneEditId(null));
    expect(screen.getByText("target content")).not.toBeVisible();
  });
});

describe("useSidePanelOpen", () => {
  function Owner({ late }: { late: boolean }) {
    const [open, setOpen] = useSidePanelOpen("owned");
    return (
      <>
        <button onClick={() => setOpen(true)}>open</button>
        <button onClick={() => setOpen(false)}>close</button>
        {open && <SidePanel title="Owned" stackKey="owned" onClose={() => setOpen(false)}>owned content</SidePanel>}
        {late && <SidePanel title="Late" stackKey="late" onClose={vi.fn()}>late content</SidePanel>}
      </>
    );
  }

  it("opening an already open panel that a later panel covers raises it", () => {
    const { rerender } = render(<Owner late={false} />);
    fireEvent.click(screen.getByText("open"));
    rerender(<Owner late />);
    expect(screen.getByText("owned content")).not.toBeVisible();
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByText("owned content")).toBeVisible();
  });

  it("closing unmounts the panel", () => {
    render(<Owner late={false} />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByText("owned content")).not.toBeInTheDocument();
  });
});
