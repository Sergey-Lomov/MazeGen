import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ZoneEditPanel } from "../components/features/ZoneEditPanel";
import { useMazeStore } from "../store/mazeStore";
import { zonesTransientUi } from "../store/slices/zonesSlice";
import type { Zone } from "../wasm/mazeService";
import * as m from "~/paraglide/messages";

const zones: Zone[] = [
  { id: 1, name: "Hall", kind: "manual", cells: [[0, 0, 0], [0, 1, 0]] },
  { id: 2, name: "", kind: "manual", cells: [[0, 1, 0]] },
  { id: 3, name: "Far", kind: "manual", cells: [[0, 5, 5]] },
];

function setup(editId: number) {
  useMazeStore.setState({ ...zonesTransientUi, openCard: "zones", zones, nextZoneId: 4, zoneEditId: editId, activeFloorId: useMazeStore.getState().floors[0].id });
  const done: string[] = [];
  render(<ZoneEditPanel onDone={() => done.push("done")} onCancel={() => done.push("cancel")} />);
  return done;
}

describe("ZoneEditPanel", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesTransientUi }));

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
    act(() => useMazeStore.getState().setZoneColor(1, 0x123456));
    expect(screen.getByRole("button", { name: m["zones.color_reset"]() })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: m["zones.color_reset"]() }));
    expect(1 in useMazeStore.getState().zoneColorOverrides).toBe(false);
  });

  it("Done calls onDone, not onCancel", () => {
    const done = setup(1);
    fireEvent.click(screen.getByText(m["zones.edit_done"]()));
    expect(done).toEqual(["done"]);
  });

  it("renames the zone from the name field", () => {
    setup(1);
    fireEvent.change(screen.getByDisplayValue("Hall"), { target: { value: "Lobby" } });
    expect(useMazeStore.getState().zones[0].name).toBe("Lobby");
  });
});
