import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ZonesFeature } from "../components/features/ZonesFeature";
import { useMazeStore } from "../store/mazeStore";
import { zonesTransientUi } from "../store/slices/zonesSlice";
import * as m from "~/paraglide/messages";

describe("ZonesFeature", () => {
  beforeEach(() => useMazeStore.setState({ ...zonesTransientUi, openCard: "zones" }));

  it("adds a zone from the card: manual list and the zone editor open together", () => {
    render(<ZonesFeature />);
    fireEvent.click(screen.getByText(m["zones.add"]()));
    const state = useMazeStore.getState();
    expect(state.zonesListMode).toBe("manual");
    expect(state.zones).toHaveLength(1);
    expect(state.zoneEditId).toBe(state.zones[0].id);
    const titles = [...document.querySelectorAll("[data-side-panel-title]")].map((el) => el.getAttribute("data-side-panel-title"));
    expect(titles).toEqual([m["zones.list_title"](), m["zones.edit"]()]);
  });
});
