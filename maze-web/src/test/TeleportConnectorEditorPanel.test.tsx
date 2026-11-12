import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import * as m from "~/paraglide/messages";

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

  it("lists the connector warnings, counted in the header, open by default", () => {
    warningsMock.list = [{ id: "teleport_connector_degenerate", key: "teleport_connector_degenerate", nodes: [], edges: [] }];
    render(<TeleportConnectorEditorPanel onClose={() => {}} onFocusPath={() => {}} />);

    const bubble = m["image_export.warning.teleport_connector_degenerate"]();
    expect(screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "1" }))).toBeInTheDocument();
    expect(screen.getByText(bubble)).toBeInTheDocument();
    expect(screen.getAllByText("ℹ")).toHaveLength(1);
  });
});
