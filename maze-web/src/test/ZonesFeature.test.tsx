import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ZonesFeature } from "../components/features/ZonesFeature";
import { useMazeStore } from "../store/mazeStore";
import { zonesTransientUi } from "../store/slices/zonesSlice";
import * as m from "~/paraglide/messages";

const raised = vi.hoisted(() => vi.fn());
vi.mock("../components/SidePanel", async (importActual) => {
  const actual = await importActual<typeof import("../components/SidePanel")>();
  return { ...actual, bringSidePanelToFront: (key: string) => { raised(key); actual.bringSidePanelToFront(key); } };
});

describe("ZonesFeature", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesTransientUi, openCard: "zones" }));

  it("adds a zone from the card: manual list and the zone editor open together", () => {
    render(<ZonesFeature />);
    fireEvent.click(screen.getByText(m["zones.add"]()));
    const state = useMazeStore.getState();
    expect(state.zonesListMode).toBe("manual");
    // The new zone is only a draft: the list does not show it until Done.
    expect(state.zones).toHaveLength(0);
    expect(state.zoneEditDraft).toMatchObject({ kind: "manual", cells: [] });
    expect(screen.queryAllByTestId("zone-cell")).toHaveLength(0);
    const titles = [...document.querySelectorAll("[data-side-panel-title]")].map((el) => el.getAttribute("data-side-panel-title"));
    expect(titles).toEqual([m["zones.list_title"](), m["zones.edit"]()]);
  });

  it("Add zone of the list does what the card's does: it raises the editor of the zone being added", () => {
    render(<ZonesFeature />);
    fireEvent.click(screen.getAllByText(m["zones.add"]())[0]);
    raised.mockClear();
    fireEvent.click(screen.getAllByText(m["zones.add"]())[1]);
    expect(raised.mock.calls.map(([key]) => key)).toEqual(["zones", "zone-edit"]);
    expect(useMazeStore.getState().zoneEditDraft?.id).toBe(1);
  });

  it("leaving the zones card drops unconfirmed zone and group drafts", () => {
    const { unmount } = render(<ZonesFeature />);
    fireEvent.click(screen.getAllByText(m["zones.add"]())[0]);
    useMazeStore.getState().addZoneGroup();
    unmount();
    expect(useMazeStore.getState().zoneEditDraft).toBeNull();
    expect(useMazeStore.getState().zoneGroupEditDraft).toBeNull();
  });

  it("Add group of the list raises the editor of the group being added over the list", () => {
    render(<ZonesFeature />);
    fireEvent.click(screen.getByText(m["zone_groups.open_list"]()));
    fireEvent.click(screen.getByText(m["zone_groups.add"]()));
    raised.mockClear();
    fireEvent.click(screen.getByText(m["zone_groups.add"]()));
    expect(raised.mock.calls.map(([key]) => key)).toEqual(["zone-group-edit"]);
    expect(useMazeStore.getState().zoneGroupEditDraft?.id).toBe(1);
  });
});
