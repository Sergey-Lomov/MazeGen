import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import * as m from "~/paraglide/messages";
import { ui } from "../styles/theme";

const warningsMock = vi.hoisted(() => ({ list: [] as { id: string; key: string; nodes: number[]; edges: never[] }[] }));
vi.mock("../components/features/useExportPanelModel", () => ({
  useModeWarnings: () => ({ modeWarnings: warningsMock.list, rawEffectiveEndpoints: { start: null, finish: null } }),
}));

const { TeleportConnectorEditorPanel } = await import("../components/features/TeleportConnectorEditorPanel");
const { useMazeStore } = await import("../store/mazeStore");
const { baseStoreState } = await import("./storeTestHelpers");

beforeEach(() => {
  warningsMock.list = [];
  useMazeStore.setState({ ...baseStoreState(), vectorByWallsSectionsExpanded: {} });
});

describe("TeleportConnectorEditorPanel", () => {
  it("shows every pointer and modifier editing hint", () => {
    render(<TeleportConnectorEditorPanel onClose={() => {}} onFocusPath={() => {}} />);

    expect(screen.getByText(m["image_export.teleport_connector_editor.hint_left_click"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.teleport_connector_editor.hint_right_click"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.teleport_connector_editor.hint_snap"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.teleport_connector_editor.hint_independent_handles"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.teleport_connector_editor.hint_symmetric_handles"]())).toBeInTheDocument();
  });

  it("always shows the warnings section with its count and collapses it on click", () => {
    render(<TeleportConnectorEditorPanel onClose={() => {}} onFocusPath={() => {}} />);

    const header = screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "0" }));
    expect(header).toBeInTheDocument();
    fireEvent.click(header);
    expect(useMazeStore.getState().vectorByWallsSectionsExpanded["teleportConnectorEditorWarnings"]).toBe(false);
  });

  it("labels endpoints with the short L<n> floor prefix, not the floor title, on a multi-floor maze", () => {
    const state = useMazeStore.getState();
    useMazeStore.setState({
      floors: [{ id: "f1", title: "Ground" }, { id: "f2", title: "Attic" }],
      nodes: [{ id: 1, x: 3, y: 4, level: 0 }, { id: 2, x: 5, y: 6, level: 1 }] as unknown as typeof state.nodes,
      vectorByWallsSettings: {
        ...state.vectorByWallsSettings,
        manualTeleportConnectorPaths: { "1:2": { mode: "polyline", nodes: [[0, 0], [1, 1]] } },
      } as typeof state.vectorByWallsSettings,
    });
    render(<TeleportConnectorEditorPanel onClose={() => {}} onFocusPath={() => {}} />);

    expect(screen.getByText("L1 3:4")).toBeInTheDocument();
    expect(screen.getByText("L2 5:6")).toBeInTheDocument();
    expect(screen.queryByText(/Ground|Attic/)).toBeNull();
  });

  it("lists a one-way cross-floor piece as its teleport end -> its floor badge, one row per floor (GitHub issue #989)", () => {
    const state = useMazeStore.getState();
    useMazeStore.setState({
      floors: [{ id: "f1", title: "Ground" }, { id: "f2", title: "Attic" }],
      nodes: [{ id: 1, x: 3, y: 4, level: 0 }, { id: 2, x: 5, y: 6, level: 1 }] as unknown as typeof state.nodes,
      edges: [{ from: 1, to: 2, kind: "teleport" }] as unknown as typeof state.edges,
      vectorByWallsSettings: {
        ...state.vectorByWallsSettings,
        manualTeleportConnectorPaths: { "1:2@1": { mode: "polyline", nodes: [[0, 0], [1, 1]] }, "1:2@2": { mode: "polyline", nodes: [[0, 0], [1, 1]] } },
      } as typeof state.vectorByWallsSettings,
    });
    render(<TeleportConnectorEditorPanel onClose={() => {}} onFocusPath={() => {}} />);

    // The far teleport node is not named; each row shows the node on its own floor and the badge.
    expect(screen.getAllByText("->")).toHaveLength(2);
    expect(screen.queryByText("<->")).toBeNull();
    expect(screen.getAllByText("L1 3:4")).toHaveLength(1);
    expect(screen.getAllByText("L2 5:6")).toHaveLength(1);
  });

  it("lists the pieces of one cross-floor connector together, wherever the second one was authored", () => {
    const state = useMazeStore.getState();
    const path = { mode: "polyline" as const, nodes: [[0, 0], [1, 1]] as [number, number][] };
    useMazeStore.setState({
      floors: [{ id: "f1", title: "Ground" }, { id: "f2", title: "Attic" }],
      nodes: [{ id: 1, x: 3, y: 4, level: 0 }, { id: 2, x: 5, y: 6, level: 1 }, { id: 3, x: 0, y: 0, level: 0 }, { id: 4, x: 1, y: 1, level: 0 }] as unknown as typeof state.nodes,
      edges: [{ from: 1, to: 2, kind: "teleport" }, { from: 3, to: 4, kind: "teleport" }] as unknown as typeof state.edges,
      vectorByWallsSettings: {
        ...state.vectorByWallsSettings,
        manualTeleportConnectorPaths: { "1:2@1": path, "3:4": path, "1:2@2": path },
      } as typeof state.vectorByWallsSettings,
    });
    const onFocusPath = vi.fn();
    render(<TeleportConnectorEditorPanel onClose={() => {}} onFocusPath={onFocusPath} />);

    const labels = screen.getAllByText(/^L\d \d+:\d+$/).map((element) => element.textContent);
    expect(labels.indexOf("L2 5:6")).toBeLessThan(labels.indexOf("L1 0:0"));
    // One mark on the divider between the two pieces, none for the unrelated same-floor row.
    const marks = screen.queryAllByTestId("teleport-connector-link-mark");
    expect(marks).toHaveLength(1);
    // The mark is not part of the row: it has the default cursor and a click on it does not focus the path.
    expect(marks[0].style.cursor).toBe("default");
    fireEvent.click(marks[0]);
    expect(onFocusPath).not.toHaveBeenCalled();
  });

  it("hovering a node bubble highlights that node, a badge bubble the badge cell, the row both, and unmount clears them", () => {
    const state = useMazeStore.getState();
    const path = { mode: "polyline" as const, nodes: [[0, 0], [1, 1]] as [number, number][] };
    useMazeStore.setState({
      floors: [{ id: "f1", title: "Ground" }, { id: "f2", title: "Attic" }],
      nodes: [{ id: 1, x: 3, y: 4, level: 0 }, { id: 2, x: 5, y: 6, level: 1 }] as unknown as typeof state.nodes,
      edges: [{ from: 1, to: 2, kind: "teleport" }] as unknown as typeof state.edges,
      vectorByWallsSettings: {
        ...state.vectorByWallsSettings,
        manualTeleportConnectorPaths: { "1:2@1": path },
      } as typeof state.vectorByWallsSettings,
    });
    const { unmount } = render(<TeleportConnectorEditorPanel onClose={() => {}} onFocusPath={() => {}} />);
    const [nodeBubble, badgeBubble] = screen.getAllByText(/^L\d \d+:\d+$/);
    expect(nodeBubble.textContent).toBe("L1 3:4");

    fireEvent.mouseEnter(nodeBubble);
    expect(useMazeStore.getState().hoveredTeleportNodeIds).toEqual([1]);
    expect(useMazeStore.getState().hoveredTeleportCells).toBeNull();

    fireEvent.mouseEnter(badgeBubble);
    expect(useMazeStore.getState().hoveredTeleportNodeIds).toBeNull();
    expect(useMazeStore.getState().hoveredTeleportCells).toEqual([expect.objectContaining({ floorIndex: 0 })]);

    fireEvent.mouseEnter(screen.getByText("->"));
    expect(useMazeStore.getState().hoveredTeleportNodeIds).toEqual([1]);
    expect(useMazeStore.getState().hoveredTeleportCells).toHaveLength(1);

    unmount();
    expect(useMazeStore.getState().hoveredTeleportNodeIds).toBeNull();
    expect(useMazeStore.getState().hoveredTeleportCells).toBeNull();
  });

  it("highlights and scrolls to the row of the connector hovered on the canvas (GitHub issue #1005)", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const state = useMazeStore.getState();
    useMazeStore.setState({
      nodes: [{ id: 1, x: 3, y: 4 }, { id: 2, x: 5, y: 6 }] as unknown as typeof state.nodes,
      vectorByWallsSettings: {
        ...state.vectorByWallsSettings,
        manualTeleportConnectorPaths: { "1:2": { mode: "polyline", nodes: [[0, 0], [1, 1]] } },
      } as typeof state.vectorByWallsSettings,
      teleportConnectorEdit: { renderMode: "vector_by_walls", selected: null, hoveredKey: "1:2" },
    });

    render(<TeleportConnectorEditorPanel onClose={() => {}} onFocusPath={() => {}} />);

    expect(screen.getByTestId("teleport-connector-row-1:2")).toHaveStyle({ background: ui.bg.hover });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("does not mirror a canvas point selection into the connector list", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const state = useMazeStore.getState();
    useMazeStore.setState({
      nodes: [{ id: 1, x: 3, y: 4 }, { id: 2, x: 5, y: 6 }] as unknown as typeof state.nodes,
      vectorByWallsSettings: {
        ...state.vectorByWallsSettings,
        manualTeleportConnectorPaths: { "1:2": { mode: "polyline", nodes: [[0, 0], [1, 1]] } },
      } as typeof state.vectorByWallsSettings,
      teleportConnectorEdit: { renderMode: "vector_by_walls", selected: { key: "1:2", index: 0 }, hoveredKey: null },
    });

    render(<TeleportConnectorEditorPanel onClose={() => {}} onFocusPath={() => {}} />);

    expect(screen.getByTestId("teleport-connector-row-1:2")).not.toHaveStyle({ background: ui.bg.hover });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("lists the connector warnings, counted in the header, open by default", () => {
    warningsMock.list = [{ id: "teleport_connector_degenerate", key: "teleport_connector_degenerate", nodes: [], edges: [] }];
    render(<TeleportConnectorEditorPanel onClose={() => {}} onFocusPath={() => {}} />);

    const bubble = m["image_export.warning.teleport_connector_degenerate"]();
    expect(screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "1" }))).toBeInTheDocument();
    expect(screen.getByText(bubble)).toBeInTheDocument();
    expect(screen.getAllByText("ℹ")).toHaveLength(1);
  });
});
