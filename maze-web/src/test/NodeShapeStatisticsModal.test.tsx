import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../components/features/nodeShapeVocabulary", () => ({
  nodeShapesOf: vi.fn(() => [
    { cellType: "regular:4", exampleCell: [0, 0], faceRanks: [0, 1, 2, 3], shapes: ["dead_end"] },
    { cellType: "regular:8", exampleCell: [1, 0], faceRanks: [0, 1, 2, 3, 4, 5, 6, 7], shapes: ["straight"] },
  ]),
}));

vi.mock("../components/dialogs/NodeShapeIcon", () => ({
  NodeShapeIcon: ({ shape }: { shape: string }) => <div data-testid={`shape-icon-${shape}`} />,
}));

import { NodeShapeStatisticsModal } from "../components/features/AnalyticsModals";

const cfg = {} as never;

describe("NodeShapeStatisticsModal", () => {
  it("uses cell-type tabs and one aligned count column", () => {
    render(
      <NodeShapeStatisticsModal
        cfg={cfg}
        counts={[
          { cell_type: "regular:4", shape: "dead_end", count: 3 },
          { cell_type: "regular:8", shape: "straight", count: 7 },
        ]}
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Square" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Octagon" })).toBeInTheDocument();
    expect(screen.getByTestId("shape-icon-dead_end")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Octagon" }));
    expect(screen.getByTestId("shape-icon-straight")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.queryByTestId("shape-icon-dead_end")).not.toBeInTheDocument();
  });

  it("keeps an untemplated type visible without a redundant heading", () => {
    render(
      <NodeShapeStatisticsModal
        cfg={cfg}
        counts={[{ cell_type: "cell", shape: "dead_end", count: 2 }]}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "Cell" })).not.toBeInTheDocument();
    expect(screen.getByText("Dead end")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
