import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MarkerIndexSection } from "../components/features/MarkerIndexSection";
import { LinkContextProvider } from "../components/features/LinkContext";
import { DEFAULT_MARKER_INDEX_SETTINGS } from "../store/slices/imageExportSlice";
import * as m from "~/paraglide/messages";

const nullTargets = {
  enabled: null, coverageSingleFloorTeleport: null, coverageCrossFloorTeleport: null,
  coverageVerticalPassage: null, coverageElevator: null, labelStyle: null, textFontWeight: null,
  width: null, textSize: null, textMargin: null, height: null, offset: null, cornerRadius: null,
  gap: null, borderWidthFromMarker: null, borderWidth: null, fillColor: null, textColor: null,
  borderColorFromMarker: null, borderColor: null,
};

function renderSection(expanded: Set<string>, onToggle = vi.fn(), enabled = true) {
  render(
    <LinkContextProvider value={{ links: [], registry: {}, onSetLinkEnabled: vi.fn(), onAddLink: vi.fn(), activePaths: new Set<string>() }}>
    <MarkerIndexSection
      settings={{ ...DEFAULT_MARKER_INDEX_SETTINGS, enabled }}
      onChange={vi.fn()}
      linkTargets={nullTargets}
      fillColorField={"x" as never}
      textColorField={"x" as never}
      borderColorField={"x" as never}
      isExpanded={(id) => expanded.has(id)}
      onToggle={onToggle}
    />
    </LinkContextProvider>,
  );
  return onToggle;
}

describe("MarkerIndexSection sub-groups", () => {
  it("hides every sub-group's rows while collapsed and toggles by id", () => {
    const onToggle = renderSection(new Set());
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_index_coverage_elevator"]())).not.toBeInTheDocument();
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_index_width"]())).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.marker_index_subsection_coverage"]()));
    expect(onToggle).toHaveBeenCalledWith("marker_index_coverage");
    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.marker_index_subsection_caption"]()));
    expect(onToggle).toHaveBeenCalledWith("marker_index_caption");
    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.marker_index_subsection_backplate"]()));
    expect(onToggle).toHaveBeenCalledWith("marker_index_backplate");
  });

  it("shows only the expanded sub-group's rows", () => {
    renderSection(new Set(["marker_index_coverage"]));
    expect(screen.getByText(m["image_export.vector_by_walls.marker_index_coverage_elevator"]())).toBeInTheDocument();
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_index_width"]())).not.toBeInTheDocument();
  });

  it("expanding the caption/backplate sub-group shows only its own rows", () => {
    renderSection(new Set(["marker_index_caption"]));
    expect(screen.getByText(m["image_export.vector_by_walls.marker_index_label_style"]())).toBeInTheDocument();
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_index_coverage_elevator"]())).not.toBeInTheDocument();
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_index_width"]())).not.toBeInTheDocument();
  });

  it("shows the backplate rows when only that sub-group is expanded", () => {
    renderSection(new Set(["marker_index_backplate"]));
    expect(screen.getByText(m["image_export.vector_by_walls.marker_index_width"]())).toBeInTheDocument();
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_index_label_style"]())).not.toBeInTheDocument();
  });

  it("renders no sub-group headers while marker indices are disabled", () => {
    renderSection(new Set(["marker_index_coverage"]), vi.fn(), false);
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_index_subsection_coverage"]())).not.toBeInTheDocument();
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_index_coverage_elevator"]())).not.toBeInTheDocument();
  });
});
