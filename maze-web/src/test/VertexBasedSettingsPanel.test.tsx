import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VertexBasedSettingsPanel } from "../components/features/VertexBasedSettingsPanel";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";

beforeEach(() => {
  useMazeStore.setState({
    initialConfig: { method: "custom_vertex_based", depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0, cyclicity: 0.0 },
    elementsConfig: { one_way_chance: 0.04, teleport_chance: 0, teleport_one_way_chance: 0, split_chance: 0 },
    floors: [{ id: 1, title: "Floor 1" }] as never,
    setGenerationParam: vi.fn(),
    setElementsParam: vi.fn(),
    setElementsBoolParam: vi.fn(),
  });
});

describe("VertexBasedSettingsPanel", () => {
  it("renders Growth/One-way/Teleport/Split categories but not Vertical on a single floor", () => {
    render(<VertexBasedSettingsPanel onClose={vi.fn()} />);

    expect(screen.getByText(m["generation.category.growth"]())).toBeInTheDocument();
    expect(screen.getByText(m["generation.category.one_way"]())).toBeInTheDocument();
    expect(screen.getByText(m["generation.category.teleport"]())).toBeInTheDocument();
    expect(screen.getByText(m["generation.category.split"]())).toBeInTheDocument();
    expect(screen.queryByText(m["generation.category.vertical"]())).not.toBeInTheDocument();
  });

  it("renders the Vertical / Elevator category on a multi-floor field", () => {
    useMazeStore.setState({ floors: [{ id: 1, title: "Floor 1" }, { id: 2, title: "Floor 2" }] as never });
    render(<VertexBasedSettingsPanel onClose={vi.fn()} />);

    expect(screen.getByText(m["generation.category.vertical"]())).toBeInTheDocument();
  });

  it("calls setGenerationParam when a growth slider changes", () => {
    const setGenerationParam = vi.fn();
    useMazeStore.setState({ setGenerationParam });
    render(<VertexBasedSettingsPanel onClose={vi.fn()} />);

    const slider = screen.getByText(m["generation.depth_first"]()).closest("div")!.parentElement!.querySelector("input[type=range]") as HTMLInputElement;
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "100");
    expect(slider).toHaveAttribute("step", "0.1");
    fireEvent.change(slider, { target: { value: "30" } });

    expect(setGenerationParam).toHaveBeenCalledWith("depth_first", 0.3);
  });

  it("calls setElementsParam when the one-way slider changes", () => {
    const setElementsParam = vi.fn();
    useMazeStore.setState({ setElementsParam });
    render(<VertexBasedSettingsPanel onClose={vi.fn()} />);

    const oneWayHeader = screen.getByText(m["generation.category.one_way"]()).closest("div")!;
    const category = oneWayHeader.parentElement!;
    const slider = category.querySelector("input[type=range]") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "50" } });

    expect(setElementsParam).toHaveBeenCalledWith("one_way_chance", 0.5);
  });

  it("renders every single-floor chance control on the 0-100% scale", () => {
    render(<VertexBasedSettingsPanel onClose={vi.fn()} />);

    const sliders = screen.getAllByRole("slider");
    expect(sliders).toHaveLength(9);
    for (const slider of sliders) {
      expect(slider).toHaveAttribute("min", "0");
      expect(slider).toHaveAttribute("max", "100");
      expect(slider).toHaveAttribute("step", "0.1");
    }
  });

  it("uses the percentage scale for multi-floor controls", () => {
    useMazeStore.setState({ floors: [{ id: 1, title: "Floor 1" }, { id: 2, title: "Floor 2" }] as never });
    render(<VertexBasedSettingsPanel onClose={vi.fn()} />);

    const sliders = screen.getAllByRole("slider");
    expect(sliders).toHaveLength(15);
    for (const slider of sliders) {
      expect(slider).toHaveAttribute("min", "0");
      expect(slider).toHaveAttribute("max", "100");
    }
  });

  it("opens a CategoryInfoModal listing the category's params when the info icon is clicked", () => {
    render(<VertexBasedSettingsPanel onClose={vi.fn()} />);

    const oneWayHeader = screen.getByText(m["generation.category.one_way"]()).closest("div")!;
    fireEvent.click(oneWayHeader.querySelector('[role="button"]')!);

    expect(screen.getByText(m["generation.desc.one_way_chance"]())).toBeInTheDocument();
  });

  it("calls onClose when the panel's header close button is clicked", () => {
    const onClose = vi.fn();
    render(<VertexBasedSettingsPanel onClose={onClose} />);

    const title = screen.getByText(m["generation.vertex_settings_title"]());
    const header = title.closest("div")!.parentElement!;
    fireEvent.click(header.querySelector("button")!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
