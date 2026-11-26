import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { useState } from "react";
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
        gate: () => true,
        activePaths: new Set<VectorByWallsParamPath>(Object.keys(VECTOR_BY_WALLS_PARAM_REGISTRY) as VectorByWallsParamPath[]),
      }}
    >
      <SharedStyleSection<VectorByWallsParamPath> settings={{ ...DEFAULT_SHARED_STYLE_SOURCE, markerLayout: "radial", markerScale: 0.6 }} onChange={onChange} onLayoutChange={vi.fn()} onScaleChange={vi.fn()} isExpanded={() => true} onToggle={vi.fn()} />
    </LinkContextProvider>,
  );
  return { ...result, onChange };
}

function CollapsibleSection() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  return (
    <LinkContextProvider
      value={{
        links: DEFAULT_VECTOR_BY_WALLS_LINKS,
        registry: VECTOR_BY_WALLS_PARAM_REGISTRY,
        onSetLinkEnabled: vi.fn(),
        onAddLink: vi.fn(),
        gate: () => true,
        activePaths: new Set<VectorByWallsParamPath>(Object.keys(VECTOR_BY_WALLS_PARAM_REGISTRY) as VectorByWallsParamPath[]),
      }}
    >
      <SharedStyleSection<VectorByWallsParamPath>
        settings={{ ...DEFAULT_SHARED_STYLE_SOURCE, markerLayout: "radial", markerScale: 0.6 }}
        onChange={vi.fn()}
        onLayoutChange={vi.fn()}
        onScaleChange={vi.fn()}
        isExpanded={(id) => expanded.has(id)}
        onToggle={(id) => setExpanded((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        })}
      />
    </LinkContextProvider>
  );
}

describe("SharedStyleSection", () => {
  it("renders the shared floor label immediately after corner style", () => {
    const { container } = renderSection();
    const selects = Array.from(container.querySelectorAll("select"));
    expect(selects[0]).toHaveValue("round");
    expect(selects[1]).toHaveValue("letters");
    expect(selects[2]).toHaveValue("circle");
  });

  it("maps a shape edit onto markerShape", () => {
    const { container, onChange } = renderSection();
    const [, , shapeSelect] = Array.from(container.querySelectorAll("select"));
    fireEvent.change(shapeSelect, { target: { value: "star" } });
    expect(onChange).toHaveBeenCalledWith({ markerShape: "star" });
  });

  it("maps a corner-style edit onto cornerStyle", () => {
    const { container, onChange } = renderSection();
    const selects = Array.from(container.querySelectorAll("select"));
    fireEvent.change(selects[0], { target: { value: "miter" } });
    expect(onChange).toHaveBeenCalledWith({ cornerStyle: "miter" });
  });

  it("collapses Shared style subsections independently", () => {
    render(<CollapsibleSection />);
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_shape"]())).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.shared_style_subsection_markers"]()));
    expect(screen.getByText(m["image_export.vector_by_walls.marker_shape"]())).toBeInTheDocument();
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_text_margin"]())).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.shared_style_subsection_text"]()));
    expect(screen.getByText(m["image_export.vector_by_walls.marker_text_margin"]())).toBeInTheDocument();
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_text_size"]())).not.toBeInTheDocument();
  });
});
