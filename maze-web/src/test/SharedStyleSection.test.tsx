import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { SharedStyleSection } from "../components/features/SharedStyleSection";
import { LinkContextProvider } from "../components/features/LinkContext";
import { DEFAULT_SHARED_STYLE_SOURCE } from "../store/slices/imageExportSlice";
import { VECTOR_BY_WALLS_PARAM_REGISTRY, type VectorByWallsParamPath } from "../store/parameterLinksRegistry";
import { DEFAULT_VECTOR_BY_WALLS_LINKS } from "../store/slices/parameterLinksDefaults";
import * as m from "~/paraglide/messages";

// GitHub issue #701: "Shared style" is one "Markers" sub-section rendering the same
// `MarkerAppearanceRows` as every other marker, mapping edits back onto the `SharedStyleSourceFields`.
function renderSection(onChange = vi.fn()) {
  const result = render(
    <LinkContextProvider
      value={{
        links: DEFAULT_VECTOR_BY_WALLS_LINKS,
        registry: VECTOR_BY_WALLS_PARAM_REGISTRY,
        onSetLinkEnabled: vi.fn(),
        onAddLink: vi.fn(),
        activePaths: new Set<VectorByWallsParamPath>(Object.keys(VECTOR_BY_WALLS_PARAM_REGISTRY) as VectorByWallsParamPath[]),
      }}
    >
      <SharedStyleSection<VectorByWallsParamPath> settings={DEFAULT_SHARED_STYLE_SOURCE} onChange={onChange} />
    </LinkContextProvider>,
  );
  return { ...result, onChange };
}

describe("SharedStyleSection", () => {
  it("renders the Markers heading and the marker rows in the standard order", () => {
    const { container } = renderSection();
    const text = container.textContent ?? "";
    const labels = [
      m["image_export.vector_by_walls.shared_style_subsection_markers"](),
      m["image_export.vector_by_walls.marker_shape"](),
      m["image_export.vector_by_walls.marker_corner_style"](),
      m["image_export.vector_by_walls.marker_size"](),
      m["image_export.vector_by_walls.marker_fill_color"](),
      m["image_export.vector_by_walls.marker_border_color"](),
      m["image_export.vector_by_walls.marker_border_width"](),
      m["image_export.vector_by_walls.marker_gap_width"](),
    ];
    const positions = labels.map((l) => text.indexOf(l));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("maps a shape edit onto markerShape", () => {
    const { container, onChange } = renderSection();
    const [shapeSelect] = Array.from(container.querySelectorAll("select"));
    fireEvent.change(shapeSelect, { target: { value: "star" } });
    expect(onChange).toHaveBeenCalledWith({ markerShape: "star" });
  });

  it("maps a corner-style edit onto cornerStyle", () => {
    const { container, onChange } = renderSection();
    const selects = Array.from(container.querySelectorAll("select"));
    fireEvent.change(selects[1], { target: { value: "miter" } });
    expect(onChange).toHaveBeenCalledWith({ cornerStyle: "miter" });
  });
});
