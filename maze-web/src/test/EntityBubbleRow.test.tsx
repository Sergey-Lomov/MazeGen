import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EntityBubbleRow } from "../components/features/EntityBubbleRow";
import { useMazeStore } from "../store/mazeStore";
import { getTooltipAnchor } from "./tooltipTestUtils";
import * as m from "~/paraglide/messages";

describe("EntityBubbleRow", () => {
  beforeEach(() => {
    useMazeStore.setState({
      floors: [{ id: "floor_0", title: "Floor 1" }, { id: "floor_1", title: "Floor 2" }],
      activeFloorId: "floor_0",
    });
  });

  it("offers floor navigation only for a point on another floor", () => {
    render(
      <EntityBubbleRow
        bubbles={[
          { text: "L1 1:1", highlight: { kind: "point", point: [1, 1], level: 0 } },
          { text: "L2 1:1", highlight: { kind: "point", point: [1, 1], level: 1 } },
        ]}
        onBubbleEnter={vi.fn()}
        onBubbleClick={vi.fn()}
      />,
    );

    expect(getTooltipAnchor(m["common.go_to_floor"]()).textContent).toContain("L2 1:1");
    expect(screen.getByText("L1 1:1").closest("[data-testid='tooltip-anchor']")?.hasAttribute("aria-describedby")).toBe(false);
  });
});
