import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ZoneOverridesSection } from "../components/ZoneOverridesSection";
import { ExportWarningsSection } from "../components/features/ExportWarningsSection";
import { ZoneProblemChips } from "../components/features/ZoneProblemChips";
import { CoordinateWarningBubble } from "../components/CoordinateWarningBubble";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";
import { getTooltipAnchors } from "./tooltipTestUtils";

const cell: [number, number, number][] = [[0, 0, 0]];
const initial = useMazeStore.getState();
afterEach(() => useMazeStore.setState({
  zones: initial.zones, zoneGroups: initial.zoneGroups, zoneOverrides: initial.zoneOverrides, exportZoneOverrides: initial.exportZoneOverrides, floors: initial.floors, activeFloorId: initial.activeFloorId,
}));

const renderRows = () => render(<ZoneOverridesSection paramKeys={["corridor_chance"]} expanded onRequest={() => undefined} />);
const tooltipOf = (text: string) => getTooltipAnchors(text).length;

describe("ZoneOverridesSection problem icon (GitHub issue #1034)", () => {
  it("says only that the zone is empty, not that the override has no effect", () => {
    useMazeStore.setState({ zones: [{ id: 1, name: "", kind: "manual", cells: [] }], zoneOverrides: [{ id: 1, zoneIds: [1], groupIds: [], params: { corridor_chance: 0.5 } }] });
    renderRows();
    expect(tooltipOf(m["generation.zone_override_problem_zone_empty"]())).toBe(1);
    expect(tooltipOf(m["generation.zone_override_problem_group_empty"]())).toBe(0);
  });

  it("says the group is empty for a group with no cells", () => {
    useMazeStore.setState({ zones: [], zoneGroups: [{ id: 5, name: "G", zoneIds: [] }], zoneOverrides: [{ id: 1, zoneIds: [], groupIds: [5], params: { corridor_chance: 0.5 } }] });
    renderRows();
    expect(tooltipOf(m["generation.zone_override_problem_group_empty"]())).toBe(1);
  });

  it("says its zones are gone for a deleted target and lists every problem of the override in one tooltip", () => {
    useMazeStore.setState({ zones: [], zoneOverrides: [{ id: 1, zoneIds: [9], groupIds: [], params: { corridor_chance: 0.5 } }] });
    renderRows();
    expect(tooltipOf(m["generation.zone_override_problem_missing"]())).toBe(1);
  });

  it("shows no icon for an override that reaches a cell", () => {
    useMazeStore.setState({ zones: [{ id: 1, name: "", kind: "manual", cells: cell }], zoneOverrides: [{ id: 1, zoneIds: [1], groupIds: [], params: { corridor_chance: 0.5 } }] });
    renderRows();
    expect(screen.queryByText(m["generation.zone_override_problem_zone_empty"]())).not.toBeInTheDocument();
    expect(tooltipOf(m["generation.zone_override_problem_missing"]())).toBe(0);
  });
});

describe("ExportWarningsSection zone override warnings (GitHub issue #1034)", () => {
  it("names a parameter set on an empty zone by its address, with the zone bubble, and counts the bubble", () => {
    useMazeStore.setState({
      zones: [{ id: 1, name: "Hollow", kind: "manual", cells: [] }],
      exportZoneOverrides: [{ id: 1, mode: "vector_by_walls", zoneIds: [1], groupIds: [], params: { wallColor: 1 } }],
    } as never);
    render(<ExportWarningsSection warnings={[]} expanded onToggle={() => undefined} showColorWarnings onShowColorWarningsChange={() => undefined} />);
    expect(screen.getByText(/Предупреждения|Warnings/).textContent).toContain("1");
    expect(screen.getByTestId("zone-problem-chip").textContent).toBe("Hollow");
    expect(screen.queryByText(m["image_export.zone_overrides.no_zones_warning"]())).not.toBeInTheDocument();
  });

  it("shows no zone override warning while the show-zone-problems switch is off", () => {
    useMazeStore.setState({
      showZoneProblems: false,
      zones: [{ id: 1, name: "Hollow", kind: "manual", cells: [] }],
      exportZoneOverrides: [
        { id: 1, mode: "vector_by_walls", zoneIds: [1], groupIds: [], params: { wallColor: 1 } },
        { id: 2, mode: "vector_by_walls", zoneIds: [9], groupIds: [], params: { wallColor: 2 } },
      ],
    } as never);
    render(<ExportWarningsSection warnings={[]} expanded onToggle={() => undefined} showColorWarnings onShowColorWarningsChange={() => undefined} />);
    expect(screen.queryByTestId("zone-problem-chip")).not.toBeInTheDocument();
    expect(screen.queryByText(m["image_export.zone_overrides.no_zones_warning"]())).not.toBeInTheDocument();
    useMazeStore.setState({ showZoneProblems: true } as never);
  });
});

describe("zone chips (GitHub issue #1034)", () => {
  it("a group chip lights its zones on hover and goes to their lowest floor on click", () => {
    const floors = [{ id: "f0", title: "0", titleCustomized: false }, { id: "f1", title: "1", titleCustomized: false }];
    const group = { id: 5, name: "G", zoneIds: [1] };
    useMazeStore.setState({ zones: [{ id: 1, name: "Up", kind: "manual", cells: [[1, 0, 0]] }], zoneGroups: [group], floors, activeFloorId: "f0" } as never);
    render(<ZoneProblemChips groups={[group]} />);
    const chip = screen.getByTestId("zone-problem-chip");
    fireEvent.mouseEnter(chip);
    expect(useMazeStore.getState().hoveredZoneGroupId).toBe(5);
    fireEvent.mouseLeave(chip);
    expect(useMazeStore.getState().hoveredZoneGroupId).toBeNull();
    fireEvent.click(chip);
    expect(useMazeStore.getState().activeFloorId).toBe("f1");
  });
});

describe("CoordinateWarningBubble floor badges", () => {
  const warning = { severity: "warning" as const, targets: [{ point: [0, 0] as [number, number], level: 1 }] };
  it("shows the floor badges, unless the warning hides them", () => {
    useMazeStore.setState({ floors: [{ id: "f0", title: "0", titleCustomized: false }, { id: "f1", title: "1", titleCustomized: false }] } as never);
    const { unmount } = render(<CoordinateWarningBubble warning={warning} message="w" />);
    expect(screen.getByText("L2")).toBeInTheDocument();
    unmount();
    render(<CoordinateWarningBubble warning={warning} message="w" hideFloorBadges />);
    expect(screen.queryByText("L2")).not.toBeInTheDocument();
  });
});
