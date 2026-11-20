import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ZoneCombinePanel } from "../components/features/ZoneCombinePanel";
import { FieldToolsSection } from "../components/features/FieldToolsSection";
import { useMazeStore } from "../store/mazeStore";
import { zonesInitialState } from "../store/slices/zonesSlice";
import type { Zone } from "../wasm/mazeService";
import * as m from "~/paraglide/messages";

const zones: Zone[] = [
  { id: 1, name: "Hall", kind: "manual", cells: [[0, 0, 0], [0, 1, 0]] },
  { id: 2, name: "Wing", kind: "manual", cells: [[0, 1, 0], [0, 2, 0]] },
  { id: 3, name: "Same", kind: "manual", cells: [[0, 0, 0], [0, 1, 0]] },
];

function setup() {
  useMazeStore.setState({ ...zonesInitialState, openCard: "zones", zones, nextZoneId: 4, zoneEditDraft: zones[0], zoneCombine: { op: "union", otherId: null } });
  render(<ZoneCombinePanel />);
}

describe("ZoneCombinePanel", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState }));

  it("lists every zone but the edited one and asks to choose while none is picked", () => {
    setup();
    expect(screen.getAllByTestId("zone-combine-cell")).toHaveLength(2);
    expect(screen.getByText(m["zones.combine_pick"]())).toBeInTheDocument();
    expect(screen.getByText(m["zones.combine_apply"]())).toBeDisabled();
  });

  it("picking a zone marks it and reports the change", () => {
    setup();
    fireEvent.click(screen.getByText("Wing"));
    expect(screen.getByTestId("list-cell-current")).toBeInTheDocument();
    expect(screen.getByText(m["zones.combine_line"]({ delta: "+1", total: 3 }))).toBeInTheDocument();
    expect(screen.queryByText(m["zones.combine_pick"]())).toBeNull();
  });

  it("warns when the mode leaves the zone as it is", () => {
    setup();
    fireEvent.click(screen.getByText("Same"));
    expect(screen.getByText(m["zones.combine_no_change"]())).toBeInTheDocument();
  });

  it("warns when the edited zone would become empty", () => {
    setup();
    fireEvent.click(screen.getByText("Wing"));
    fireEvent.click(screen.getByText(m["zones.combine_subtraction"]()));
    expect(screen.queryByText(m["zones.combine_empty"]())).toBeNull();
    fireEvent.click(screen.getByText("Same"));
    expect(screen.getByText(m["zones.combine_empty"]())).toBeInTheDocument();
  });

  it("applies to the draft and closes", () => {
    setup();
    fireEvent.click(screen.getByText("Wing"));
    fireEvent.click(screen.getByText(m["zones.combine_intersection"]()));
    expect(screen.getByText(m["zones.combine_line"]({ delta: "-1", total: 1 }))).toBeInTheDocument();
    fireEvent.click(screen.getByText(m["zones.combine_apply"]()));
    expect(useMazeStore.getState().zoneEditDraft?.cells).toEqual([[0, 1, 0]]);
    expect(useMazeStore.getState().zoneCombine).toBeNull();
  });
});

describe("combine tool button", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState, openCard: "zones", zones, nextZoneId: 4 }));

  it("is offered only while a zone is edited, and toggles the panel", () => {
    const { unmount } = render(<FieldToolsSection />);
    expect(screen.queryByRole("button", { name: m["zones.combine_tool"]() })).toBeNull();
    unmount();

    useMazeStore.setState({ zoneEditDraft: zones[0] });
    render(<FieldToolsSection />);
    const button = screen.getByRole("button", { name: m["zones.combine_tool"]() });
    fireEvent.click(button);
    expect(useMazeStore.getState().zoneCombine).toEqual({ op: "union", otherId: null });
    fireEvent.click(button);
    expect(useMazeStore.getState().zoneCombine).toBeNull();
  });
});

describe("ZoneCombinePanel hover", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState }));

  it("highlights the zone under the pointer and clears it on leave", () => {
    useMazeStore.setState({ ...zonesInitialState, openCard: "zones", zones, nextZoneId: 4, zoneEditDraft: zones[0], zoneCombine: { op: "union", otherId: null } });
    render(<ZoneCombinePanel />);
    const cell = screen.getByText("Wing").closest("[data-testid='zone-combine-cell']")!;
    fireEvent.mouseEnter(cell);
    expect(useMazeStore.getState().hoveredZoneId).toBe(2);
    fireEvent.mouseLeave(cell);
    expect(useMazeStore.getState().hoveredZoneId).toBeNull();
  });
});
