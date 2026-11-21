import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ZonesFeature } from "../components/features/ZonesFeature";
import { useMazeStore } from "../store/mazeStore";
import { zonesInitialState } from "../store/slices/zonesSlice";
import * as m from "~/paraglide/messages";

const panel = (title: string) => document.querySelector<HTMLElement>(`[data-side-panel-title="${title}"]`)!;

describe("ZonesFeature", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState, openCard: "zones" }));

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

  it("Add zone of the list raises the editor of the zone being added over the list", () => {
    render(<ZonesFeature />);
    fireEvent.click(screen.getAllByText(m["zones.add"]())[0]);
    fireEvent.click(screen.getByText(m["zones.open_list"]()));
    expect(panel(m["zones.edit"]())).not.toBeVisible();
    fireEvent.click(screen.getAllByText(m["zones.add"]())[1]);
    expect(panel(m["zones.edit"]())).toBeVisible();
    expect(useMazeStore.getState().zoneEditDraft?.id).toBe(1);
  });

  it("opening the zones list again, then pressing a zone's edit button, shows the editor over the list", () => {
    useMazeStore.setState({ zones: [{ id: 1, name: "A", kind: "manual", cells: [] }], nextZoneId: 2 });
    render(<ZonesFeature />);
    fireEvent.click(screen.getAllByText(m["zones.add"]())[0]);
    fireEvent.click(screen.getByText(m["zones.open_list"]()));
    expect(panel(m["zones.edit"]())).not.toBeVisible();
    act(() => useMazeStore.getState().setZoneEditId(1));
    expect(panel(m["zones.edit"]())).toBeVisible();
  });

  it("opening the groups list again, then a group's edit, shows the group editor over the list", () => {
    useMazeStore.setState({ zoneGroups: [{ id: 1, name: "G", zoneIds: [] }], nextZoneGroupId: 2 });
    render(<ZonesFeature />);
    fireEvent.click(screen.getByText(m["zone_groups.open_list"]()));
    fireEvent.click(screen.getByText(m["zone_groups.add"]()));
    fireEvent.click(screen.getByText(m["zone_groups.open_list"]()));
    expect(panel(m["zone_groups.edit"]())).not.toBeVisible();
    act(() => useMazeStore.getState().setZoneGroupEditId(1));
    expect(panel(m["zone_groups.edit"]())).toBeVisible();
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
    fireEvent.click(screen.getByText(m["zone_groups.open_list"]()));
    expect(panel(m["zone_groups.edit"]())).not.toBeVisible();
    fireEvent.click(screen.getByText(m["zone_groups.add"]()));
    expect(panel(m["zone_groups.edit"]())).toBeVisible();
    expect(useMazeStore.getState().zoneGroupEditDraft?.id).toBe(1);
  });
});
