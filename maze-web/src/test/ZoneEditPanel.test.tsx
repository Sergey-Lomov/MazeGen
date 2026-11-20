import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { ZoneEditPanel } from "../components/features/ZoneEditPanel";
import { useMazeStore } from "../store/mazeStore";
import { zonesInitialState } from "../store/slices/zonesSlice";
import type { Zone } from "../wasm/mazeService";
import * as m from "~/paraglide/messages";

const zones: Zone[] = [
  { id: 1, name: "Hall", kind: "manual", cells: [[0, 0, 0], [0, 1, 0]] },
  { id: 2, name: "", kind: "manual", cells: [[0, 1, 0]] },
  { id: 3, name: "Far", kind: "manual", cells: [[0, 5, 5]] },
];

function setup(editId: number) {
  useMazeStore.setState({ ...zonesInitialState, openCard: "zones", zones, nextZoneId: 4, zoneEditDraft: zones.find((z) => z.id === editId) ?? null, activeFloorId: useMazeStore.getState().floors[0].id });
  const done: string[] = [];
  render(<ZoneEditPanel onDone={() => done.push("done")} onCancel={() => done.push("cancel")} />);
  return done;
}

describe("ZoneEditPanel", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState }));

  it("shows the size and lists the zones it intersects with as bubbles", () => {
    setup(1);
    expect(screen.getByText(m["zones.size_plural"]({ count: 2 }))).toBeInTheDocument();
    expect(screen.getByText(m["zones.intersections_title"]())).toBeInTheDocument();
    expect(screen.getByText(m["zones.default_name"]({ id: 2 }))).toBeInTheDocument();
  });

  it("hides the Intersections section when nothing intersects", () => {
    setup(3);
    expect(screen.queryByText(m["zones.intersections_title"]())).toBeNull();
  });

  it("hovering an intersection bubble highlights that zone instead of the edited one", () => {
    setup(1);
    fireEvent.mouseEnter(screen.getByText(m["zones.default_name"]({ id: 2 })));
    expect(useMazeStore.getState().hoveredZoneId).toBe(2);
    fireEvent.mouseLeave(screen.getByText(m["zones.default_name"]({ id: 2 })));
    expect(useMazeStore.getState().hoveredZoneId).toBeNull();
  });

  it("fills the name field with the default name of an unnamed zone", () => {
    setup(2);
    expect(screen.getByDisplayValue(m["zones.default_name"]({ id: 2 }))).toBeInTheDocument();
  });

  it("disables the colour reset while the colour is automatic and resets an explicit one", () => {
    setup(1);
    const reset = screen.getByRole("button", { name: m["zones.color_reset"]() });
    expect(reset).toBeDisabled();
    act(() => useMazeStore.getState().setZoneColor(0x123456));
    expect(screen.getByRole("button", { name: m["zones.color_reset"]() })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: m["zones.color_reset"]() }));
    expect(useMazeStore.getState().zoneEditDraftColor).toBeNull();
  });

  it("Done calls onDone, not onCancel", () => {
    const done = setup(1);
    fireEvent.click(screen.getByText(m["zones.edit_done"]()));
    expect(done).toEqual(["done"]);
  });

  it("renames the zone from the name field", () => {
    setup(1);
    fireEvent.change(screen.getByDisplayValue("Hall"), { target: { value: "Lobby" } });
    expect(useMazeStore.getState().zoneEditDraft?.name).toBe("Lobby");
    expect(useMazeStore.getState().zones[0].name).toBe("Hall");
  });
});

describe("zone editor groups", () => {
  beforeEach(() => useMazeStore.setState({
    ...zonesInitialState, openCard: "zones", activeFloorId: useMazeStore.getState().floors[0].id, zones, nextZoneId: 4, zoneEditDraft: zones[1], zoneEditDraftGroupIds: [1],
    zoneGroups: [{ id: 1, name: "Has", zoneIds: [2] }, { id: 2, name: "Free", zoneIds: [] }], nextZoneGroupId: 3,
  }));

  it("lists the zone's groups and removes it from one with the trash", () => {
    render(<ZoneEditPanel onDone={() => {}} onCancel={() => {}} />);
    const rows = screen.getAllByTestId("zone-group-row");
    expect(rows).toHaveLength(1);
    fireEvent.click(within(rows[0]).getByRole("button", { name: m["zone_groups.remove_zone"]() }));
    expect(useMazeStore.getState().zoneEditDraftGroupIds).toEqual([]);
    // Only the draft changed: the group keeps the zone until Done.
    expect(useMazeStore.getState().zoneGroups[0].zoneIds).toEqual([2]);
    expect(screen.getByText(m["zones.no_groups"]())).toBeInTheDocument();
  });

  it("New group queues a group to create on Done; its trash takes it back, and no group exists meanwhile", () => {
    render(<ZoneEditPanel onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: m["zone_groups.add_to_group"]() }));
    fireEvent.click(screen.getByText(m["zone_groups.new"]()));
    fireEvent.change(screen.getAllByRole("textbox").at(-1)!, { target: { value: "Fresh" } });
    fireEvent.click(screen.getByText(m["common.ok"]()));
    expect(useMazeStore.getState().zoneEditDraftNewGroups).toEqual(["Fresh"]);
    expect(useMazeStore.getState().zoneGroups).toHaveLength(2);
    const row = screen.getAllByTestId("zone-group-row").find((r) => r.textContent?.includes("Fresh"))!;
    fireEvent.click(within(row).getByRole("button", { name: m["zone_groups.remove_zone"]() }));
    expect(useMazeStore.getState().zoneEditDraftNewGroups).toEqual([]);
  });

  it("the plus opens the picker; a click adds the zone and closes it", () => {
    render(<ZoneEditPanel onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: m["zone_groups.add_to_group"]() }));
    // Only the group without the zone is offered.
    const cells = screen.getAllByTestId("zone-group-cell");
    expect(cells).toHaveLength(1);
    fireEvent.click(within(cells[0]).getByText("Free"));
    expect(useMazeStore.getState().zoneEditDraftGroupIds).toEqual([1, 2]);
    expect(useMazeStore.getState().zoneGroups[1].zoneIds).toEqual([]);
    expect(screen.queryByTestId("zone-group-cell")).toBeNull();
  });
});

