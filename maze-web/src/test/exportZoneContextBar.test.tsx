import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExportZoneContextBar } from "../components/features/ExportZoneOverrides";
import { useMazeStore } from "../store/mazeStore";
import type { ExportZoneOverride } from "../store/zonesTypes";
import type { Zone } from "../wasm/mazeService";
import * as m from "~/paraglide/messages";

const zone = (id: number): Zone => ({ id, name: `Z${id}`, kind: "manual", cells: [[0, id, 0]] });
const override: ExportZoneOverride = { id: 1, mode: "walls", zoneIds: [1], groupIds: [], params: { wallColor: 1 } };
const state = () => useMazeStore.getState();

describe("export zone context bar (GitHub issue #1040)", () => {
  beforeEach(() => {
    useMazeStore.setState({ zones: [zone(1), zone(2)], zoneGroups: [], showZoneOverrideButtons: true, exportOverrideContext: null, exportZoneOverrides: [override] });
  });

  it("shows the global context as a bubble that opens the context picker", () => {
    render(<ExportZoneContextBar mode="walls" />);
    fireEvent.click(screen.getByTestId("export-zone-context-target"));
    expect(screen.getByText(m["image_export.zone_context.leave"]())).toBeTruthy();
  });

  it("leaves the zone context with the picker's global context button, which stays enabled in the global context", () => {
    state().setExportOverrideContext({ kind: "zone", id: 1 });
    render(<ExportZoneContextBar mode="walls" />);
    fireEvent.click(screen.getByTestId("export-zone-context-target"));
    fireEvent.click(screen.getByText(m["image_export.zone_context.leave"]()));
    expect(state().exportOverrideContext).toBeNull();
    fireEvent.click(screen.getByTestId("export-zone-context-target"));
    expect((screen.getByText(m["image_export.zone_context.leave"]()) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers deleting the zone's values only inside a zone that has some, after a confirmation", () => {
    const { rerender } = render(<ExportZoneContextBar mode="walls" />);
    expect(screen.queryByLabelText(m["image_export.zone_context.delete_all_params"]())).toBeNull();
    state().setExportOverrideContext({ kind: "zone", id: 1 });
    rerender(<ExportZoneContextBar mode="walls" />);
    fireEvent.click(screen.getByLabelText(m["image_export.zone_context.delete_all_params"]()));
    expect(screen.getByText(m["image_export.zone_context.delete_all_confirm"]())).toBeTruthy();
    expect(state().exportZoneOverrides).toHaveLength(1);
  });

  it("renders nothing while the zone switch is off", () => {
    useMazeStore.setState({ showZoneOverrideButtons: false });
    const { container } = render(<ExportZoneContextBar mode="walls" />);
    expect(container.firstChild).toBeNull();
  });
});
