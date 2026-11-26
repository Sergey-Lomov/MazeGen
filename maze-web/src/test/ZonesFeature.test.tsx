import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ZonesFeature } from "../components/features/ZonesFeature";
import { useMazeStore } from "../store/mazeStore";
import { zonesInitialState } from "../store/slices/zonesSlice";
import * as m from "~/paraglide/messages";

const panel = (title: string) => document.querySelector<HTMLElement>(`[data-side-panel-title="${title}"]`)!;

describe("ZonesFeature", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState, openCard: "zones", zoneGroupsListMode: "manual" }));

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

describe("ZonesFeature problems (GitHub issue #1034)", () => {
  // A cell this far out is never a cell of the default field.
  const farZone = { id: 1, name: "Far", kind: "manual" as const, cells: [[0, 9999, 9999]] as [number, number, number][] };
  const { floors: initialFloors, activeFloorId: initialFloorId } = useMazeStore.getState();
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState, openCard: "zones" }));
  afterEach(() => useMazeStore.setState({ floors: initialFloors, activeFloorId: initialFloorId }));

  it("keeps the Warnings section collapsed at first and counts a zone with invalid cells, the empty zones and the unused ones", () => {
    useMazeStore.setState({ zones: [farZone, { id: 2, name: "Idle", kind: "manual", cells: [] }], nextZoneId: 3 });
    render(<ZonesFeature />);
    expect(screen.getByText(m["common.warnings"]({ count: "3" }))).toBeInTheDocument();
    expect(screen.queryByText(m["zones.warning_invalid_cells"]())).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(m["common.warnings"]({ count: "3" })));
    // One bubble per kind, the zones as chips below; the count is the number of bubbles.
    expect(screen.getByText(m["zones.warning_empty"]())).toBeInTheDocument();
    expect(screen.getAllByTestId("zone-problem-chip").map((chip) => chip.textContent)).toEqual(["Far", "Idle", "Far", "Idle"]);
    expect(screen.getByText(m["zones.warning_invalid_cells"]())).toBeInTheDocument();
    expect(screen.getByText(m["zones.warning_unused"]())).toBeInTheDocument();
  });

  it("a zone in a group is not unused, an unused group warns for itself, an empty or used one does not (GitHub issue #1093)", () => {
    const inGroup = { id: 1, name: "Member", kind: "manual" as const, cells: [[0, 0, 0]] as [number, number, number][] };
    useMazeStore.setState({
      zones: [inGroup],
      nextZoneId: 2,
      zoneGroups: [{ id: 1, name: "Idle group", zoneIds: [1] }, { id: 2, name: "Used group", zoneIds: [1] }, { id: 3, name: "Hollow", zoneIds: [] }],
      nextZoneGroupId: 4,
      zoneOverrides: [{ id: 1, zoneIds: [], groupIds: [2], params: {} }],
      nextZoneOverrideId: 2,
    });
    render(<ZonesFeature />);
    // Unused groups + empty groups: two bubbles; no unused-zone bubble.
    fireEvent.click(screen.getByText(m["common.warnings"]({ count: "2" })));
    expect(screen.queryByText(m["zones.warning_unused"]())).not.toBeInTheDocument();
    expect(screen.getByText(m["zones.warning_unused_groups"]())).toBeInTheDocument();
    const chips = screen.getAllByTestId("zone-problem-chip").map((chip) => chip.textContent);
    expect(chips).toContain(m["zone_groups.bubble_label"]({ name: "Idle group" }));
    expect(chips).not.toContain(m["zone_groups.bubble_label"]({ name: "Used group" }));
  });

  it("hovering the invalid cells warning lights those cells through the shared coordinate warning", () => {
    useMazeStore.setState({ zones: [farZone], nextZoneId: 2 });
    render(<ZonesFeature />);
    fireEvent.click(screen.getByText(m["common.warnings"]({ count: "2" })));
    fireEvent.mouseEnter(screen.getByText(m["zones.warning_invalid_cells"]()));
    const hovered = useMazeStore.getState().hoveredCoordinateWarning;
    expect(hovered?.targets).toEqual([{ point: [9999, 9999], level: 0 }]);
    // The cells are drawn merged into one contour group.
    expect(hovered?.groups).toEqual([{ targets: [{ point: [9999, 9999], level: 0 }], outset: false }]);
    fireEvent.mouseLeave(screen.getByText(m["zones.warning_invalid_cells"]()));
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
  });

  it("hovering a zone chip of the invalid warning lights the zone and only that zone's cells outside the field", () => {
    const nearFar = { id: 2, name: "Other", kind: "manual" as const, cells: [[0, 8888, 8888]] as [number, number, number][] };
    useMazeStore.setState({ zones: [farZone, nearFar], nextZoneId: 3 });
    render(<ZonesFeature />);
    fireEvent.click(screen.getByText(m["common.warnings"]({ count: "2" })));
    const chip = screen.getAllByTestId("zone-problem-chip")[0];
    fireEvent.mouseEnter(chip);
    expect(useMazeStore.getState().hoveredZoneId).toBe(1);
    expect(useMazeStore.getState().hoveredCoordinateWarning?.targets).toEqual([{ point: [9999, 9999], level: 0 }]);
    fireEvent.mouseLeave(chip);
    expect(useMazeStore.getState().hoveredZoneId).toBeNull();
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
  });

  it("a zone used by an override is not reported as unused", () => {
    useMazeStore.setState({ zones: [{ ...farZone, cells: [[0, 0, 0]] }], nextZoneId: 2, zoneOverrides: [{ id: 1, zoneIds: [1], groupIds: [], params: {} }], nextZoneOverrideId: 2 });
    render(<ZonesFeature />);
    expect(screen.getByText(m["common.warnings"]({ count: "0" }))).toBeInTheDocument();
  });

  it("warns about an empty manual group, naming it, but not about an automatic one", () => {
    useMazeStore.setState({ zoneGroups: [{ id: 1, name: "Hollow", zoneIds: [] }, { id: 2 ** 30, name: "", zoneIds: [] }], nextZoneGroupId: 2 });
    render(<ZonesFeature />);
    fireEvent.click(screen.getByText(m["common.warnings"]({ count: "1" })));
    expect(screen.getByText(m["zones.warning_empty"]())).toBeInTheDocument();
    expect(screen.getByTestId("zone-problem-chip").textContent).toBe(m["zone_groups.bubble_label"]({ name: "Hollow" }));
  });

  it("hovering a zone chip lights the zone and a click goes to its lowest floor unless the active floor holds it", () => {
    const floors = [{ id: "floor_0", title: "0", titleCustomized: false }, { id: "floor_1", title: "1", titleCustomized: false }, { id: "floor_2", title: "2", titleCustomized: false }];
    useMazeStore.setState({ zones: [{ id: 1, name: "Up", kind: "manual", cells: [[1, 0, 0], [2, 0, 0]] }], nextZoneId: 2, floors, activeFloorId: "floor_0" } as never);
    render(<ZonesFeature />);
    fireEvent.click(screen.getByText(m["common.warnings"]({ count: "1" })));
    const chip = screen.getByTestId("zone-problem-chip");
    fireEvent.mouseEnter(chip);
    expect(useMazeStore.getState().hoveredZoneId).toBe(1);
    fireEvent.mouseLeave(chip);
    expect(useMazeStore.getState().hoveredZoneId).toBeNull();
    fireEvent.click(chip);
    expect(useMazeStore.getState().activeFloorId).toBe("floor_1");
  });

  it("disables Remove unavailable cells with nothing to remove, and removes the cells otherwise", () => {
    useMazeStore.setState({ zones: [{ ...farZone, cells: [] }], nextZoneId: 2 });
    const { unmount } = render(<ZonesFeature />);
    expect(screen.getByText(m["zones.remove_invalid"]())).toBeDisabled();
    unmount();

    useMazeStore.setState({ zones: [farZone], nextZoneId: 2 });
    render(<ZonesFeature />);
    fireEvent.mouseEnter(screen.getByText(m["zones.remove_invalid"]()));
    expect(useMazeStore.getState().hoveredCoordinateWarning).not.toBeNull();
    fireEvent.click(screen.getByText(m["zones.remove_invalid"]()));
    // The button turns disabled under the pointer, so the highlight must not wait for a mouse leave.
    expect(useMazeStore.getState().hoveredCoordinateWarning).toBeNull();
    expect(useMazeStore.getState().zones).toEqual([{ ...farZone, cells: [] }]);
    expect(screen.getByText(m["zones.remove_invalid"]())).toBeDisabled();
  });
});
