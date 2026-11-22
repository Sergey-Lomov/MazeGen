import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ZoneGroupPickerDialog, ZoneGroupNameDialog } from "../components/features/ZoneGroupDialogs";
import { ZonesPanel } from "../components/features/ZonesPanel";
import { ZoneGroupsPanel, ZoneGroupEditPanel } from "../components/features/ZoneGroupsPanel";
import { zoneChipColors, zoneColors } from "../domain/selectors/zoneSelectors";
import { cssColor } from "../components/EntityColorSwatch";
import { brightColor } from "../domain/colorMath";
import { autoGroupIdOf } from "../domain/autoZones";
import { useMazeStore } from "../store/mazeStore";
import { zonesInitialState } from "../store/slices/zonesSlice";
import type { Zone } from "../wasm/mazeService";
import * as m from "~/paraglide/messages";

const zones: Zone[] = [
  { id: 1, name: "Alpha", kind: "auto", cells: [[0, 0, 0]] },
  { id: 2, name: "Beta", kind: "manual", cells: [[0, 1, 0]] },
  { id: 3, name: "Gamma", kind: "manual", cells: [] },
];

function state() {
  return useMazeStore.getState();
}

describe("zone groups store", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState, zones, nextZoneId: 4 }));

  it("adds an empty group as a draft and opens it; the list gets it on Done", () => {
    state().addZoneGroup();
    expect(state().zoneGroups).toEqual([]);
    expect(state().zoneGroupEditDraft).toEqual({ id: 1, name: "", zoneIds: [] });
    expect(state().zoneGroupEditId).toBe(1);
    state().addZonesToGroup(1, [2]);
    state().commitZoneGroupEdit();
    expect(state().zoneGroups).toEqual([{ id: 1, name: "", zoneIds: [2] }]);
    expect(state().zoneGroupEditDraft).toBeNull();
  });

  it("adding again while a new group is edited changes nothing", () => {
    state().addZoneGroup();
    state().setZoneGroupName(1, "Keep");
    state().addZoneGroup();
    expect(state().zoneGroupEditDraft).toEqual({ id: 1, name: "Keep", zoneIds: [] });
    expect(state().nextZoneGroupId).toBe(2);
  });

  it("never reuses a deleted group id", () => {
    state().addZoneGroup();
    state().commitZoneGroupEdit();
    state().removeZoneGroup(1);
    state().addZoneGroup();
    state().commitZoneGroupEdit();
    expect(state().zoneGroups.map((g) => g.id)).toEqual([2]);
  });

  it("adds each zone once and ignores unknown ids", () => {
    state().addZoneGroup();
    state().addZonesToGroup(1, [2, 2, 99]);
    state().addZonesToGroup(1, [2, 3]);
    expect(state().zoneGroupEditDraft?.zoneIds).toEqual([2, 3]);
  });

  it("drops a deleted zone from every group and from the group draft", () => {
    useMazeStore.setState({ zoneGroups: [{ id: 5, name: "Old", zoneIds: [2, 3] }] });
    state().setZoneGroupEditId(5);
    state().removeZone(2);
    expect(state().zoneGroups[0].zoneIds).toEqual([3]);
    expect(state().zoneGroupEditDraft?.zoneIds).toEqual([3]);
  });

  it("closing the panel ends group editing", () => {
    state().addZoneGroup();
    state().setZoneGroupsPanelOpen(true);
    state().setZoneGroupsPanelOpen(false);
    expect(state().zoneGroupEditId).toBeNull();
  });
});

describe("ZoneGroupsPanel", () => {
  beforeEach(() => useMazeStore.setState({
    ...zonesInitialState,
    zones,
    nextZoneId: 4,
    zoneGroups: [{ id: 1, name: "Pair", zoneIds: [1, 2] }, { id: 2, name: "", zoneIds: [3] }],
    nextZoneGroupId: 3,
  }));

  it("shows the name and the zone count of each group", () => {
    render(<ZoneGroupsPanel onClose={() => {}} />);
    const cells = screen.getAllByTestId("zone-group-cell");
    expect(within(cells[0]).getByText("Pair")).toBeInTheDocument();
    expect(within(cells[0]).getByText(m["zone_groups.zones_info"]({ count: 2 }))).toBeInTheDocument();
    expect(within(cells[1]).getByText(m["zone_groups.default_name"]({ id: 2 }))).toBeInTheDocument();
    expect(within(cells[1]).getByText(m["zone_groups.zones_info"]({ count: 1 }))).toBeInTheDocument();
  });

  it("pencil opens the group", () => {
    render(<ZoneGroupsPanel onClose={() => {}} />);
    fireEvent.click(within(screen.getAllByTestId("zone-group-cell")[0]).getByRole("button", { name: m["zone_groups.edit"]() }));
    expect(state().zoneGroupEditId).toBe(1);
  });

  it("trash deletes the group after confirmation", () => {
    render(<ZoneGroupsPanel onClose={() => {}} />);
    fireEvent.click(within(screen.getAllByTestId("zone-group-cell")[0]).getByRole("button", { name: m["zone_groups.delete"]() }));
    expect(state().zoneGroups).toHaveLength(2);
    fireEvent.click(screen.getByText(m["common.ok"]()));
    expect(state().zoneGroups.map((g) => g.id)).toEqual([2]);
  });

  it("Add group opens a new group as a draft: the list keeps its groups until Done", () => {
    render(<ZoneGroupsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByText(m["zone_groups.add"]()));
    expect(state().zoneGroups).toHaveLength(2);
    expect(state().zoneGroupEditDraft?.id).toBe(3);
    expect(screen.getAllByTestId("zone-group-cell")).toHaveLength(2);
  });
});

describe("ZoneGroupsPanel cards: floors, zone bubbles and hover", () => {
  const multi: Zone[] = [
    { id: 1, name: "Alpha", kind: "auto", cells: [[0, 0, 0], [2, 1, 0]] },
    { id: 2, name: "Beta", kind: "manual", cells: [[1, 1, 0]] },
    { id: 3, name: "Gamma", kind: "manual", cells: [[0, 5, 5]] },
  ];
  const floors = [{ id: "f0", title: "F1" }, { id: "f1", title: "F2" }, { id: "f2", title: "F3" }];
  beforeEach(() => {
    useMazeStore.setState({
      ...zonesInitialState, floors, activeFloorId: "f0", zones: multi, nextZoneId: 4,
      zoneGroups: [{ id: 1, name: "Pair", zoneIds: [1, 2] }], nextZoneGroupId: 2,
    });
    render(<ZoneGroupsPanel onClose={() => {}} />);
  });

  it("shows the floors of all the group's zones", () => {
    const cell = screen.getByTestId("zone-group-cell");
    expect(within(cell).getAllByRole("button").map((b) => b.textContent)).toEqual(expect.arrayContaining(["L1", "L2", "L3"]));
  });

  it("shows one bubble per zone in the zone's own colours", () => {
    const bubbles = screen.getAllByTestId("zone-group-bubble");
    expect(bubbles.map((b) => b.textContent)).toEqual(["Alpha", "Beta"]);
    const chip = zoneChipColors(zoneColors(multi)[0]);
    expect(bubbles[0]).toHaveStyle({ color: cssColor(brightColor(zoneColors(multi)[0])), background: cssColor(chip.bg) });
  });

  it("hovering the card highlights every zone of the group, a bubble only its zone", () => {
    const cell = screen.getByTestId("zone-group-cell");
    fireEvent.mouseEnter(cell);
    expect(state().hoveredZoneIds).toEqual([1, 2]);
    fireEvent.mouseEnter(screen.getAllByTestId("zone-group-bubble")[1]);
    expect(state().hoveredZoneId).toBe(2);
    // The pointer moves from the bubble back onto the card, not out of it.
    fireEvent.mouseLeave(screen.getAllByTestId("zone-group-bubble")[1], { relatedTarget: cell });
    expect(state().hoveredZoneId).toBeNull();
    expect(state().hoveredZoneIds).toEqual([1, 2]);
    fireEvent.mouseLeave(cell);
    expect(state().hoveredZoneIds).toEqual([]);
  });
});

describe("zone group edit draft", () => {
  beforeEach(() => useMazeStore.setState({
    ...zonesInitialState,
    zones,
    nextZoneId: 4,
    zoneGroups: [{ id: 1, name: "Pair", zoneIds: [1] }],
    nextZoneGroupId: 2,
  }));

  it("edits stay in the draft until Done and never reach the list before", () => {
    state().setZoneGroupEditId(1);
    state().setZoneGroupName(1, "Changed");
    state().addZonesToGroup(1, [2]);
    expect(state().zoneGroups).toEqual([{ id: 1, name: "Pair", zoneIds: [1] }]);
    state().setZoneGroupEditId(null);
    expect(state().zoneGroups).toEqual([{ id: 1, name: "Changed", zoneIds: [1, 2] }]);
    expect(state().zoneGroupEditId).toBeNull();
  });

  it("cancel drops the draft of an existing group", () => {
    state().setZoneGroupEditId(1);
    state().setZoneGroupName(1, "Changed");
    state().cancelZoneGroupEdit();
    expect(state().zoneGroups).toEqual([{ id: 1, name: "Pair", zoneIds: [1] }]);
    expect(state().zoneGroupEditId).toBeNull();
    expect(state().zoneGroupEditDraft).toBeNull();
  });

  it("cancel drops a group created in this session", () => {
    state().addZoneGroup();
    state().addZonesToGroup(2, [2]);
    state().cancelZoneGroupEdit();
    expect(state().zoneGroups.map((g) => g.id)).toEqual([1]);
  });

  it("opening another group drops the unconfirmed draft", () => {
    state().addZoneGroup();
    state().commitZoneGroupEdit();
    state().setZoneGroupEditId(1);
    state().setZoneGroupName(1, "Lost");
    state().setZoneGroupEditId(2);
    expect(state().zoneGroups[0].name).toBe("Pair");
    expect(state().zoneGroupEditId).toBe(2);
  });

  it("closing the groups panel cancels an unconfirmed edit", () => {
    state().setZoneGroupsPanelOpen(true);
    state().setZoneGroupEditId(1);
    state().addZonesToGroup(1, [3]);
    state().setZoneGroupsPanelOpen(false);
    expect(state().zoneGroups[0].zoneIds).toEqual([1]);
    state().setZoneGroupsPanelOpen(true);
    state().addZoneGroup();
    state().setZoneGroupsPanelOpen(false);
    expect(state().zoneGroups.map((g) => g.id)).toEqual([1]);
  });
});

describe("ZoneGroupEditPanel", () => {
  const noop = () => {};
  function open(group: { id: number; name: string; zoneIds: number[] }, isNew = false, zs: Zone[] = zones) {
    useMazeStore.setState({
      ...zonesInitialState, zones: zs, nextZoneId: 4, zoneGroups: [group], nextZoneGroupId: 2,
      zoneGroupEditId: group.id, zoneGroupEditIsNew: isNew, zoneGroupEditDraft: group,
    });
    return render(<ZoneGroupEditPanel groupId={group.id} onDone={noop} onCancel={noop} />);
  }

  it("shows counts in the section headers; Zones is open and Candidates closed for an existing group", () => {
    open({ id: 1, name: "Pair", zoneIds: [1] });
    expect(screen.getByText(m["zone_groups.zones_section"]({ count: 1 }))).toBeInTheDocument();
    expect(screen.getByText(m["zone_groups.candidates_section"]({ count: 2 }))).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("a new group opens with Candidates expanded and Zones collapsed", () => {
    open({ id: 1, name: "", zoneIds: [] }, true);
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.queryByText(m["zone_groups.no_zones"]())).toBeNull();
  });

  it("the trash removes a zone from the group", () => {
    open({ id: 1, name: "Pair", zoneIds: [1] });
    fireEvent.click(screen.getByRole("button", { name: m["zone_groups.remove_zone"]() }));
    expect(state().zoneGroupEditDraft?.zoneIds).toEqual([]);
    expect(screen.getByText(m["zone_groups.no_zones"]())).toBeInTheDocument();
  });

  it("the plus adds a candidate to the group", () => {
    open({ id: 1, name: "", zoneIds: [] }, true);
    fireEvent.click(within(screen.getAllByTestId("zone-cell")[0]).getByRole("button", { name: m["zone_groups.add_zone"]() }));
    expect(state().zoneGroupEditDraft?.zoneIds).toEqual([1]);
  });

  it("shows the all-added placeholder when no candidate is left", () => {
    open({ id: 1, name: "G", zoneIds: [1, 2, 3] });
    fireEvent.click(screen.getByText(m["zone_groups.candidates_section"]({ count: 0 })));
    expect(screen.getByText(m["zone_groups.all_added"]())).toBeInTheDocument();
  });

  it("shows the no-zones-exist placeholder when there are no zones at all", () => {
    open({ id: 1, name: "", zoneIds: [] }, true, []);
    expect(screen.getByText(m["zone_groups.no_zones_exist"]())).toBeInTheDocument();
  });

  it("Done is disabled while the group has no zones, and enabled after adding one", () => {
    open({ id: 1, name: "", zoneIds: [] }, true);
    const done = screen.getByRole("button", { name: m["zones.edit_done"]() });
    expect(done).toBeDisabled();
    fireEvent.click(within(screen.getAllByTestId("zone-cell")[0]).getByRole("button", { name: m["zone_groups.add_zone"]() }));
    expect(done).not.toBeDisabled();
  });
});

describe("zone group cards: counts, floor navigation", () => {
  const multi: Zone[] = [
    { id: 1, name: "Alpha", kind: "manual", cells: [[0, 0, 0], [0, 1, 0]] },
    { id: 2, name: "Beta", kind: "manual", cells: [[1, 0, 0]] },
  ];
  const floors = [{ id: "f0", title: "F1" }, { id: "f1", title: "F2" }];
  beforeEach(() => useMazeStore.setState({
    ...zonesInitialState, floors, activeFloorId: "f0", zones: multi, nextZoneId: 3,
    zoneGroups: [{ id: 1, name: "Pair", zoneIds: [1, 2] }], nextZoneGroupId: 2,
  }));

  it("shows zone and distinct cell counts", () => {
    render(<ZoneGroupsPanel onClose={() => {}} />);
    const cell = screen.getByTestId("zone-group-cell");
    expect(within(cell).getByText(m["zone_groups.zones_info"]({ count: 2 }))).toBeInTheDocument();
    expect(within(cell).getByText(m["zone_groups.cells_info"]({ count: 3 }))).toBeInTheDocument();
  });

  it("a bubble of a zone absent from the active floor goes to its floor; a present one stays", () => {
    render(<ZoneGroupsPanel onClose={() => {}} />);
    const [alpha, beta] = screen.getAllByTestId("zone-group-bubble");
    fireEvent.click(alpha);
    expect(state().activeFloorId).toBe("f0");
    fireEvent.click(beta);
    expect(state().activeFloorId).toBe("f1");
  });
});

describe("zones list groups line", () => {
  it("lists the groups of a zone or the placeholder", () => {
    useMazeStore.setState({
      ...zonesInitialState, zones: [{ id: 1, name: "A", kind: "manual", cells: [] }, { id: 2, name: "B", kind: "manual", cells: [] }],
      zoneGroups: [{ id: 1, name: "G1", zoneIds: [1] }, { id: 2, name: "", zoneIds: [1] }], zonesListMode: "manual",
    });
    render(<ZonesPanel onClose={() => {}} />);
    const lines = screen.getAllByTestId("zone-groups-line").map((l) => l.textContent);
    expect(lines).toEqual([m["zones.groups_info"]({ names: `G1, ${m["zone_groups.default_name"]({ id: 2 })}` }), m["zones.no_groups"]()]);
  });
});

describe("automatic group card (GitHub issue #1037)", () => {
  it("shows the localized name and has neither the edit pencil nor the delete trash", () => {
    useMazeStore.setState({
      ...zonesInitialState, zones, nextZoneId: 4,
      zoneGroups: [{ id: autoGroupIdOf("edge"), name: "", zoneIds: [1] }, { id: 1, name: "Own", zoneIds: [2] }], nextZoneGroupId: 2,
    });
    render(<ZoneGroupsPanel onClose={() => {}} />);
    const [auto, own] = screen.getAllByTestId("zone-group-cell");
    expect(within(auto).getByText(m["zone_groups.auto_edge"]())).toBeInTheDocument();
    expect(within(auto).queryByRole("button", { name: m["zone_groups.edit"]() })).toBeNull();
    expect(within(auto).queryByRole("button", { name: m["zone_groups.delete"]() })).toBeNull();
    expect(within(own).getByRole("button", { name: m["zone_groups.edit"]() })).toBeInTheDocument();
  });
});

describe("zone group dialogs", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesInitialState, zones, nextZoneId: 4, zoneGroups: [], nextZoneGroupId: 1 }));

  it("the picker shows a placeholder without groups, and New group hands over", () => {
    let handed = false;
    render(<ZoneGroupPickerDialog excludeIds={[]} onPick={() => {}} onClose={() => {}} onNew={() => { handed = true; }} />);
    expect(screen.getByText(m["zone_groups.none"]())).toBeInTheDocument();
    fireEvent.click(screen.getByText(m["zone_groups.new"]()));
    expect(handed).toBe(true);
  });

  it("the picker offers groups outside excludeIds and hands the picked one over", () => {
    useMazeStore.setState({ zoneGroups: [{ id: 1, name: "Has", zoneIds: [] }, { id: 2, name: "Free", zoneIds: [] }] });
    const picked: number[] = [];
    let closed = 0;
    render(<ZoneGroupPickerDialog excludeIds={[1]} onPick={(id) => picked.push(id)} onClose={() => { closed += 1; }} onNew={() => {}} />);
    const cells = screen.getAllByTestId("zone-group-cell");
    expect(cells).toHaveLength(1);
    fireEvent.click(within(cells[0]).getByText("Free"));
    expect(picked).toEqual([2]);
    expect(closed).toBe(1);
  });

  it("the picker leaves automatic groups out (a manual zone cannot join one)", () => {
    useMazeStore.setState({ zoneGroups: [{ id: autoGroupIdOf("edge"), name: "", zoneIds: [] }] });
    render(<ZoneGroupPickerDialog excludeIds={[]} onPick={() => {}} onClose={() => {}} onNew={() => {}} />);
    expect(screen.queryAllByTestId("zone-group-cell")).toHaveLength(0);
    expect(screen.getByText(m["zone_groups.none"]())).toBeInTheDocument();
  });

  it("the name dialog hands the trimmed name over, and cancel hands nothing", () => {
    const names: string[] = [];
    let closed = 0;
    render(<ZoneGroupNameDialog onConfirm={(name) => names.push(name)} onClose={() => { closed += 1; }} />);
    const ok = screen.getByText(m["common.ok"]());
    expect(ok).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: " Team " } });
    fireEvent.click(ok);
    expect(names).toEqual(["Team"]);
    expect(closed).toBe(1);
    fireEvent.click(screen.getByText(m["common.cancel"]()));
    expect(names).toHaveLength(1);
    expect(state().zoneGroups).toEqual([]);
  });
});
