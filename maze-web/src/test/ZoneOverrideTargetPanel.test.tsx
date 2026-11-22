import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ZoneOverrideTargetPanel } from "../components/features/ZoneOverrideTargetPanel";
import { ZoneOverrideControls, ZoneOverridesSection } from "../components/ZoneOverridesSection";
import { ZoneOverrideConflictModal } from "../components/features/ZoneOverrideConflictModal";
import { ZONE_OVERRIDE_PARAM_KEYS } from "../domain/zoneOverrides";
import { useMazeStore } from "../store/mazeStore";
import { zonesInitialState } from "../store/slices/zonesSlice";
import type { Zone } from "../wasm/mazeService";
import * as m from "~/paraglide/messages";

const zones: Zone[] = [
  { id: 1, name: "Alpha", kind: "auto", cells: [[0, 0, 0]] },
  { id: 2, name: "Beta", kind: "manual", cells: [[0, 1, 0]] },
  { id: 3, name: "Gamma", kind: "manual", cells: [[0, 2, 0]] },
];
const state = () => useMazeStore.getState();

describe("zone override target panel (GitHub issue #1038)", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState, zones, zoneGroups: [{ id: 7, name: "Team", zoneIds: [2, 3] }] }));

  it("lists manual zones only until automatic ones are shown, filters by search and picks a zone", async () => {
    const onPick = vi.fn();
    render(<ZoneOverrideTargetPanel onPick={onPick} onClose={() => {}} />);
    expect(screen.getAllByTestId("zone-cell")).toHaveLength(2);
    fireEvent.click(screen.getByLabelText(m["generation.zone_override_show_auto"]()));
    expect(screen.getAllByTestId("zone-cell")).toHaveLength(3);
    fireEvent.change(screen.getByPlaceholderText(m["generation.zone_override_search"]()), { target: { value: "gam" } });
    await waitFor(() => expect(screen.getAllByTestId("zone-cell")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("zone-cell"));
    expect(onPick).toHaveBeenCalledWith({ kind: "zone", id: 3 });
  });

  it("lights the group's zones while a group cell is hovered and picks the group", () => {
    const onPick = vi.fn();
    render(<ZoneOverrideTargetPanel onPick={onPick} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: m["generation.zone_override_mode_groups"]() }));
    const cell = screen.getByTestId("zone-group-cell");
    fireEvent.mouseEnter(cell);
    expect(state().hoveredZoneGroupId).toBe(7);
    fireEvent.mouseLeave(cell);
    expect(state().hoveredZoneGroupId).toBeNull();
    fireEvent.click(cell);
    expect(onPick).toHaveBeenCalledWith({ kind: "group", id: 7 });
  });
});

describe("zone overrides section", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState, zones, zoneGroups: [{ id: 7, name: "Team", zoneIds: [2, 3] }] }));

  it("is absent without overrides of the parameter", () => {
    state().addZoneOverride({ cyclicity: 0.2 }, { kind: "zone", id: 2 });
    const { container } = render(<ZoneOverridesSection paramKeys={["branching"]} expanded onRequest={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is absent while collapsed", () => {
    state().addZoneOverride({ branching: 0.2 }, { kind: "zone", id: 2 });
    const { container } = render(<ZoneOverridesSection paramKeys={["branching"]} expanded={false} onRequest={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the chevron only while the parameter has overrides", () => {
    const controls = <ZoneOverrideControls paramKeys={["branching"]} globalValues={[0.5]} expanded={false} onToggle={() => {}} onRequest={() => {}} />;
    const { rerender } = render(controls);
    expect(screen.queryByLabelText(m["generation.zone_overrides_show"]())).toBeNull();
    state().addZoneOverride({ branching: 0.2 }, { kind: "zone", id: 2 });
    rerender(controls);
    expect(screen.getByLabelText(m["generation.zone_overrides_show"]())).toBeTruthy();
  });

  it("lights a zone or a group on hover", () => {
    state().addZoneOverride({ branching: 0.2 }, { kind: "zone", id: 2 });
    state().addZoneOverride({ branching: 0.4 }, { kind: "group", id: 7 });
    render(<ZoneOverridesSection paramKeys={["branching"]} expanded onRequest={() => {}} />);
    const [zoneBubble, groupBubble] = screen.getAllByTestId("zone-override-target");
    // Groups are listed before zones inside one row, so look the bubbles up by text.
    const zoneTarget = [zoneBubble, groupBubble].find((b) => b.textContent === "Beta")!;
    const groupTarget = [zoneBubble, groupBubble].find((b) => b.textContent?.includes("Team"))!;
    fireEvent.mouseEnter(zoneTarget);
    expect(state().hoveredZoneId).toBe(2);
    fireEvent.mouseLeave(zoneTarget);
    fireEvent.mouseEnter(groupTarget);
    expect(state().hoveredZoneGroupId).toBe(7);
    expect(groupTarget.textContent).toContain(m["generation.zone_override_group_prefix"]());
  });

  it("shows a switch for an on/off parameter and stores it as 0 or 1", () => {
    state().addZoneOverride({ allow_non_consecutive_elevator_floors: 0 }, { kind: "zone", id: 2 });
    render(<ZoneOverridesSection paramKeys={["allow_non_consecutive_elevator_floors"]} expanded onRequest={() => {}} />);
    const toggle = screen.getByLabelText(m["generation.zone_override_value"]()) as HTMLInputElement;
    expect(toggle.type).toBe("checkbox");
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(state().zoneOverrides[0].params.allow_non_consecutive_elevator_floors).toBe(1);
    fireEvent.click(toggle);
    expect(state().zoneOverrides[0].params.allow_non_consecutive_elevator_floors).toBe(0);
  });
});

describe("zone override conflicts", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState, zones, zoneGroups: [] }));

  it("marks an overlapping row with a warning icon instead of a bubble", () => {
    state().addZoneOverride({ branching: 0.2 }, { kind: "zone", id: 2 });
    state().addZoneOverride({ branching: 0.4 }, { kind: "zone", id: 2 });
    render(<ZoneOverridesSection paramKeys={["branching"]} expanded onRequest={() => {}} />);
    expect(screen.getAllByTestId("zone-override-target")).toHaveLength(2);
    // One tooltip-carrying icon per row, no text bubble under the rows.
    expect(screen.getAllByText(m["generation.zone_override_conflict"]())).toHaveLength(2);
  });

  it("lists every affected parameter once in the info modal", () => {
    render(<ZoneOverrideConflictModal params={["elevator_span_min", "elevator_span_max", "branching"]} onClose={() => {}} />);
    expect(screen.getAllByText(`${m["generation.category.vertical"]()} ${m["generation.elevator_span"]()}`)).toHaveLength(1);
    expect(screen.getByText(m["generation.branching"]())).toBeTruthy();
  });

  it("names every overridable parameter in the info modal", () => {
    render(<ZoneOverrideConflictModal params={ZONE_OVERRIDE_PARAM_KEYS} onClose={() => {}} />);
    const items = [...document.querySelectorAll("li")].map((li) => li.textContent);
    expect(items.every((text) => !!text)).toBe(true);
    // The two span bounds share one label.
    expect(items).toHaveLength(ZONE_OVERRIDE_PARAM_KEYS.length - 1);
  });
});

describe("zone override bubble click", () => {
  it("shows a floor that holds the zone, unless the active floor already does", () => {
    const setActiveFloorId = vi.fn();
    useMazeStore.setState({
      ...zonesInitialState,
      zones: [{ id: 2, name: "Beta", kind: "manual", cells: [[1, 1, 0]] }],
      zoneGroups: [],
      floors: [{ id: "f0" }, { id: "f1" }] as never,
      activeFloorId: "f0",
      setActiveFloorId,
    });
    state().addZoneOverride({ branching: 0.2 }, { kind: "zone", id: 2 });
    render(<ZoneOverridesSection paramKeys={["branching"]} expanded onRequest={() => {}} />);
    fireEvent.click(screen.getByTestId("zone-override-target"));
    expect(setActiveFloorId).toHaveBeenCalledWith("f1");
    setActiveFloorId.mockClear();
    act(() => useMazeStore.setState({ activeFloorId: "f1" }));
    fireEvent.click(screen.getByTestId("zone-override-target"));
    expect(setActiveFloorId).not.toHaveBeenCalled();
  });
});
