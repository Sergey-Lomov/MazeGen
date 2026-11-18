import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ZonesPanel } from "../components/features/ZonesPanel";
import { FloorBadgeRow } from "../components/FloorBadgeRow";
import { cssColor } from "../components/EntityColorSwatch";
import { useMazeStore } from "../store/mazeStore";
import { zonesTransientUi } from "../store/slices/zonesSlice";
import { bubbleColors } from "../components/Bubble";
import type { Zone } from "../wasm/mazeService";
import * as m from "~/paraglide/messages";

const floors = [
  { id: "floor_0", title: "Floor 1" },
  { id: "floor_1", title: "Floor 2" },
  { id: "floor_2", title: "Floor 3" },
];

const zones: Zone[] = [
  { id: 1, name: "Alpha", kind: "auto", cells: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] },
  { id: 2, name: "Beta", kind: "manual", cells: [[0, 1, 0]] },
  { id: 3, name: "", kind: "manual", cells: [] },
];

function setup(overrides: Partial<ReturnType<typeof useMazeStore.getState>> = {}) {
  useMazeStore.setState({ ...zonesTransientUi, floors, activeFloorId: "floor_0", zones, nextZoneId: 4, ...overrides });
  return render(<ZonesPanel onClose={() => {}} />);
}

describe("ZonesPanel", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesTransientUi }));

  it("shows the zone count of each section in its switch segment", () => {
    setup();
    expect(screen.getByText(m["zones.mode_auto"]({ count: 1 }))).toBeInTheDocument();
    expect(screen.getByText(m["zones.mode_manual"]({ count: 2 }))).toBeInTheDocument();
  });

  it("lists only the zones of the selected section and switches on click", () => {
    setup();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Beta")).toBeNull();
    fireEvent.click(screen.getByText(m["zones.mode_manual"]({ count: 2 })));
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("#3")).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).toBeNull();
  });

  it("offers Add only in the manual section, and adds an empty manual zone", () => {
    setup();
    expect(screen.queryByText(m["zones.add"]())).toBeNull();
    fireEvent.click(screen.getByText(m["zones.mode_manual"]({ count: 2 })));
    fireEvent.click(screen.getByText(m["zones.add"]()));
    expect(useMazeStore.getState().zones.at(-1)).toMatchObject({ id: 4, kind: "manual", cells: [] });
  });

  it("shows the cell count and the floors a zone occupies", () => {
    setup();
    const cell = screen.getByTestId("zone-cell");
    expect(within(cell).getByText(m["zones.cell_count_plural"]({ count: 3 }))).toBeInTheDocument();
    expect(within(cell).getAllByRole("button").map((b) => b.textContent)).toEqual(expect.arrayContaining(["L1", "L2", "L3"]));
  });

  it("hides the floor badges on a single-floor maze", () => {
    setup({ floors: [floors[0]] });
    expect(within(screen.getByTestId("zone-cell")).queryByText("L1")).toBeNull();
  });

  it("hovering a card sets the hovered zone and leaving clears it", () => {
    setup();
    const cell = screen.getByTestId("zone-cell");
    fireEvent.mouseEnter(cell);
    expect(useMazeStore.getState().hoveredZoneId).toBe(1);
    fireEvent.mouseLeave(cell);
    expect(useMazeStore.getState().hoveredZoneId).toBeNull();
  });

  it("clears the hover when the panel unmounts", () => {
    const { unmount } = setup();
    fireEvent.mouseEnter(screen.getByTestId("zone-cell"));
    unmount();
    expect(useMazeStore.getState().hoveredZoneId).toBeNull();
  });

  it("the eye button toggles the zone's visibility", () => {
    setup();
    fireEvent.click(screen.getByLabelText(m["zones.hide"]()));
    expect(useMazeStore.getState().hiddenZoneIds).toEqual([1]);
    fireEvent.click(screen.getByLabelText(m["zones.show"]()));
    expect(useMazeStore.getState().hiddenZoneIds).toEqual([]);
  });

  it("gives auto zones no edit or delete button", () => {
    setup();
    expect(screen.queryByLabelText(m["zones.delete"]())).toBeNull();
    expect(screen.queryByLabelText(m["zones.edit"]())).toBeNull();
  });

  it("deletes a manual zone only after the confirmation", () => {
    setup({ zonesListMode: "manual" });
    fireEvent.click(screen.getAllByLabelText(m["zones.delete"]())[0]);
    expect(useMazeStore.getState().zones).toHaveLength(3);
    fireEvent.click(screen.getByText(m["common.cancel"]()));
    expect(useMazeStore.getState().zones).toHaveLength(3);
    fireEvent.click(screen.getAllByLabelText(m["zones.delete"]())[0]);
    fireEvent.click(screen.getByText(m["common.ok"]()));
    expect(useMazeStore.getState().zones.map((z) => z.id)).toEqual([1, 3]);
  });

  it("paints each card's swatch with the zone's canvas colour", () => {
    setup();
    const swatch = screen.getByTestId("zone-color-dot");
    expect(swatch.style.background).not.toBe("");
  });
});

describe("FloorBadgeRow", () => {
  beforeEach(() => useMazeStore.setState({ floors, activeFloorId: "floor_0" }));

  it("renders standard bubbles that switch the floor on click", () => {
    render(<FloorBadgeRow levels={[0, 2]} />);
    fireEvent.click(screen.getByText("L3"));
    expect(useMazeStore.getState().activeFloorId).toBe("floor_2");
  });

  it("switches the floor with Enter and Space", () => {
    render(<FloorBadgeRow levels={[1, 2]} />);
    fireEvent.keyDown(screen.getByText("L2"), { key: "Enter" });
    expect(useMazeStore.getState().activeFloorId).toBe("floor_1");
    fireEvent.keyDown(screen.getByText("L3"), { key: " " });
    expect(useMazeStore.getState().activeFloorId).toBe("floor_2");
  });

  it("does nothing for a floor that no longer exists", () => {
    render(<FloorBadgeRow levels={[7]} />);
    const badge = screen.getByText("L8");
    expect(badge).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(badge);
    expect(useMazeStore.getState().activeFloorId).toBe("floor_0");
  });

  it("uses the caller's colours when given, the neutral bubble colours otherwise", () => {
    const { rerender } = render(<FloorBadgeRow levels={[0]} />);
    expect(screen.getByText("L1").style.color).toBe(toCss(bubbleColors("neutral").text));
    rerender(<FloorBadgeRow levels={[0]} bg="rgb(1, 2, 3)" text="rgb(4, 5, 6)" />);
    expect(screen.getByText("L1").style.background).toBe("rgb(1, 2, 3)");
    expect(screen.getByText("L1").style.color).toBe("rgb(4, 5, 6)");
  });

  it("renders nothing on a single-floor maze or without levels", () => {
    useMazeStore.setState({ floors: [floors[0]] });
    const { container, rerender } = render(<FloorBadgeRow levels={[0]} />);
    expect(container).toBeEmptyDOMElement();
    useMazeStore.setState({ floors });
    rerender(<FloorBadgeRow levels={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("cssColor", () => {
  it("pads to six hex digits", () => {
    expect(cssColor(0x0000ff)).toBe("#0000ff");
    expect(cssColor(0xabcdef)).toBe("#abcdef");
    expect(cssColor(0)).toBe("#000000");
  });
});

// Reads a colour back the way the DOM normalises it.
function toCss(color: string): string {
  const probe = document.createElement("span");
  probe.style.color = color;
  return probe.style.color;
}
