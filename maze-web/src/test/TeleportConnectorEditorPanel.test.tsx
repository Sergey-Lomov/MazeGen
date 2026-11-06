import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import * as m from "~/paraglide/messages";

const { TeleportConnectorEditorPanel } = await import("../components/features/TeleportConnectorEditorPanel");
const { useMazeStore } = await import("../store/mazeStore");
const { baseStoreState } = await import("./storeTestHelpers");

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
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
});
