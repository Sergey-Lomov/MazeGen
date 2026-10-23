import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ParamFields, isEntityVisible } from "../components/features/ParamFields";
import type { ParamDescriptor } from "../wasm/types";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";

// ParamFields is intentionally uncontrolled -- it re-renders off whatever `values` prop it's
// given, same as its real callers (useParamEditor's local `values` state). A bare static
// `values={{...}}` prop across a change+blur sequence would make the DOM's own value snap back
// on every re-render, since React reconciles the controlled <input> against the same stale prop
// -- this wrapper stands in for the real caller's state round-trip.
function StatefulParamFields({ params, initial, onCommit }: {
  params: ParamDescriptor[];
  initial: Record<string, string>;
  onCommit?: (paramId: string, value: string) => void;
}) {
  const [values, setValues] = useState(initial);
  return (
    <ParamFields
      params={params}
      values={values}
      onChange={(paramId, value) => {
        setValues((prev) => ({ ...prev, [paramId]: value }));
        onCommit?.(paramId, value);
      }}
    />
  );
}

function StatefulAddSplitWeights() {
  const [values, setValues] = useState({ split_config: "[1]" });
  return (
    <ParamFields
      params={[addSplitConfigParam]}
      values={values}
      addSplitPatternsOverride={[{ shape: "regular:4", node_count: 1, faces: [[]], weight: 1 }]}
      onChange={(paramId, value) => setValues((previous) => ({ ...previous, [paramId]: value }))}
    />
  );
}

const intervalParam: ParamDescriptor = {
  id: "desired_length",
  label: "Desired graph length",
  kind: { type: "interval", default_min: 0, default_max: 1000, min: 0, max: 100_000 },
};

const percentSliderParam: ParamDescriptor = {
  id: "one_way_chance",
  label: "One-way teleport chance",
  kind: { type: "float", default: 1, min: 0, max: 100 },
};

const plainFloatParam: ParamDescriptor = {
  id: "reserve_percent",
  label: "Reserve percent",
  kind: { type: "float", default: 50, min: 0, max: 500 },
};

const plainIntegerParam: ParamDescriptor = {
  id: "max_attempts",
  label: "Max attempts",
  kind: { type: "integer", default: 5, min: 0, max: 100 },
};

const boolParam: ParamDescriptor = {
  id: "protect_route",
  label: "Protect route",
  kind: { type: "bool", default: true },
};

const enumParam: ParamDescriptor = {
  id: "region_class",
  label: "Region class",
  kind: { type: "enum", default: "trap", options: ["trap", "alternative"] },
};

const addSplitConfigParam: ParamDescriptor = {
  id: "split_config",
  label: "Split node count",
  kind: { type: "add_split_config", max_split_nodes_default: 3 },
};

const multiFloorOnlyParam: ParamDescriptor = {
  id: "cross_floor_weight",
  label: "Cross-floor weight",
  kind: { type: "float", default: 1, min: 0, max: 100 },
  visibility: { type: "multi_floor_only" },
};

describe("isEntityVisible", () => {
  it("is always visible when there is no visibility tag", () => {
    expect(isEntityVisible(undefined, 1)).toBe(true);
    expect(isEntityVisible(undefined, 5)).toBe(true);
  });

  it("multi_floor_only is hidden below 2 floors", () => {
    expect(isEntityVisible({ type: "multi_floor_only" }, 1)).toBe(false);
  });

  it("multi_floor_only is visible at 2 or more floors", () => {
    expect(isEntityVisible({ type: "multi_floor_only" }, 2)).toBe(true);
    expect(isEntityVisible({ type: "multi_floor_only" }, 3)).toBe(true);
  });
});

describe("ParamFields", () => {
  beforeEach(() => {
    useMazeStore.setState({ floors: [{ id: "a", title: "Floor 1" }] });
  });

  describe("conditional visibility (floor count)", () => {
    it("hides a multi_floor_only param's whole row on a single-floor maze", () => {
      render(<ParamFields params={[multiFloorOnlyParam]} values={{ cross_floor_weight: "37" }} onChange={vi.fn()} />);
      expect(screen.queryByRole("slider")).not.toBeInTheDocument();
      expect(screen.queryByText("Cross-floor weight")).not.toBeInTheDocument();
    });

    it("renders nothing when every param is hidden by visibility", () => {
      const { container } = render(<ParamFields params={[multiFloorOnlyParam]} values={{ cross_floor_weight: "37" }} onChange={vi.fn()} />);
      expect(container.firstChild).toBeNull();
    });

    it("shows the param once the maze has 2 or more floors, without altering its stored value", () => {
      useMazeStore.setState({ floors: [{ id: "a", title: "Floor 1" }, { id: "b", title: "Floor 2" }] });
      const onChange = vi.fn();
      render(<ParamFields params={[multiFloorOnlyParam]} values={{ cross_floor_weight: "37" }} onChange={onChange} />);
      expect(screen.getByText("Cross-floor weight")).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });
  });
  describe("interval param", () => {
    it("renders the min/max halves of a \"min,max\" value in two separate number inputs", () => {
      render(<ParamFields params={[intervalParam]} values={{ desired_length: "3,10" }} onChange={vi.fn()} />);
      const inputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
      expect(inputs).toHaveLength(2);
      expect(inputs[0].value).toBe("3");
      expect(inputs[1].value).toBe("10");
    });

    it("associates the parameter label with the interval's first field", () => {
      render(<ParamFields params={[intervalParam]} values={{ desired_length: "3,10" }} onChange={vi.fn()} />);
      const label = screen.getByText("Desired graph length");
      const [minInput] = screen.getAllByRole("spinbutton") as HTMLInputElement[];
      expect(label).toHaveAttribute("for", minInput.id);
    });

    it("onChange fires immediately on keystroke without clamping against the other half", () => {
      const onChange = vi.fn();
      render(<ParamFields params={[intervalParam]} values={{ desired_length: "3,10" }} onChange={onChange} />);
      const [minInput] = screen.getAllByRole("spinbutton");
      // Raising min above the current max (10) must not be capped mid-edit -- this is the
      // regression this session's fix addresses (see ParamFields.tsx's onBlur comment).
      fireEvent.change(minInput, { target: { value: "30" } });
      expect(onChange).toHaveBeenCalledWith("desired_length", "30,10");
    });

    it("onBlur collapses an inverted range (min > max) to a single point at the other endpoint", () => {
      const onCommit = vi.fn();
      render(<StatefulParamFields params={[intervalParam]} initial={{ desired_length: "3,10" }} onCommit={onCommit} />);
      const [minInput] = screen.getAllByRole("spinbutton");
      fireEvent.change(minInput, { target: { value: "30" } });
      fireEvent.blur(minInput);
      expect(onCommit).toHaveBeenLastCalledWith("desired_length", "10,10");
    });

    it("onBlur leaves an in-order range at its final value", () => {
      const onCommit = vi.fn();
      render(<StatefulParamFields params={[intervalParam]} initial={{ desired_length: "3,10" }} onCommit={onCommit} />);
      const [minInput] = screen.getAllByRole("spinbutton");
      fireEvent.change(minInput, { target: { value: "5" } });
      fireEvent.blur(minInput);
      // No inversion clamp -- 5 <= 10, so the range stays as typed.
      expect(onCommit).toHaveBeenLastCalledWith("desired_length", "5,10");
    });

    it("onBlur on an emptied min field restores the last valid min instead of the param bound", () => {
      const onCommit = vi.fn();
      render(<StatefulParamFields params={[intervalParam]} initial={{ desired_length: "3,10" }} onCommit={onCommit} />);
      const [minInput] = screen.getAllByRole("spinbutton") as HTMLInputElement[];
      fireEvent.change(minInput, { target: { value: "" } });
      // Never commits a "" half -- it commits the last valid min (GitHub issue #452).
      expect(onCommit).toHaveBeenLastCalledWith("desired_length", "3,10");
      fireEvent.blur(minInput);
      expect(onCommit).toHaveBeenLastCalledWith("desired_length", "3,10");
      expect(minInput.value).toBe("3");
    });

    it("onBlur on an emptied max field restores the last valid max", () => {
      const onCommit = vi.fn();
      render(<StatefulParamFields params={[intervalParam]} initial={{ desired_length: "3,10" }} onCommit={onCommit} />);
      const [, maxInput] = screen.getAllByRole("spinbutton") as HTMLInputElement[];
      fireEvent.change(maxInput, { target: { value: "" } });
      expect(onCommit).toHaveBeenLastCalledWith("desired_length", "3,10");
      fireEvent.blur(maxInput);
      expect(maxInput.value).toBe("10");
    });

    it("onBlur restores the last valid half even after it was edited to a new value first", () => {
      const onCommit = vi.fn();
      render(<StatefulParamFields params={[intervalParam]} initial={{ desired_length: "3,10" }} onCommit={onCommit} />);
      const [minInput] = screen.getAllByRole("spinbutton") as HTMLInputElement[];
      fireEvent.change(minInput, { target: { value: "7" } });
      fireEvent.change(minInput, { target: { value: "" } });
      fireEvent.blur(minInput);
      expect(minInput.value).toBe("7");
      expect(onCommit).toHaveBeenLastCalledWith("desired_length", "7,10");
    });
  });

  // ParamFields renders float/integer params through the shared `NumberInput` (see
  // NumberInput.test.tsx for its round/clamp/last-valid/decimal-guard contract). These tests only
  // pin what ParamFields itself is responsible for: wiring the right props into it and forwarding
  // its commits under the param's own id.
  describe("float / integer param wiring", () => {
    it("forwards an integer param's committed value under its own id", () => {
      const onCommit = vi.fn();
      render(<StatefulParamFields params={[plainIntegerParam]} initial={{ max_attempts: "5" }} onCommit={onCommit} />);
      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "9" } });
      expect(onCommit).toHaveBeenLastCalledWith("max_attempts", "9");
    });

    it("passes integer=true for an integer param and explains rejected decimal input", () => {
      render(<ParamFields params={[plainIntegerParam]} values={{ max_attempts: "5" }} onChange={vi.fn()} />);
      const input = screen.getByRole("spinbutton");
      fireEvent.keyDown(input, { key: "." });
      expect(screen.getByTestId("field-hint")).toHaveTextContent(m["input_hint.decimal_separator_rejected"]());
    });

    it("does not pass integer=true for a float param (decimal point allowed)", () => {
      render(<ParamFields params={[plainFloatParam]} values={{ reserve_percent: "50" }} onChange={vi.fn()} />);
      const input = screen.getByRole("spinbutton");
      const event = new KeyboardEvent("keydown", { key: ".", bubbles: true, cancelable: true });
      expect(input.dispatchEvent(event)).toBe(true);
    });

    it("passes the param's own min/max so blur clamps to them", () => {
      const onCommit = vi.fn();
      render(<StatefulParamFields params={[plainIntegerParam]} initial={{ max_attempts: "5" }} onCommit={onCommit} />);
      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "500" } });
      fireEvent.blur(input);
      // plainIntegerParam's max is 100.
      expect(onCommit).toHaveBeenLastCalledWith("max_attempts", "100");
    });

    it("an emptied field commits the last valid value, never \"\" (GitHub issue #452)", () => {
      const onCommit = vi.fn();
      render(<StatefulParamFields params={[plainIntegerParam]} initial={{ max_attempts: "42" }} onCommit={onCommit} />);
      const input = screen.getByRole("spinbutton") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);
      expect(onCommit).not.toHaveBeenCalledWith("max_attempts", "");
      expect(onCommit).toHaveBeenLastCalledWith("max_attempts", "42");
      expect(input.value).toBe("42");
    });
  });

  describe("percent-slider param", () => {
    it("renders an allowlisted float param as a range input with a rounded percent label", () => {
      render(<ParamFields params={[percentSliderParam]} values={{ one_way_chance: "37.4" }} onChange={vi.fn()} />);
      const slider = screen.getByRole("slider") as HTMLInputElement;
      expect(slider.min).toBe("0");
      expect(slider.max).toBe("100");
      expect(slider.value).toBe("37.4");
      expect(screen.getByText("37%")).toBeInTheDocument();
    });

    it("a non-allowlisted float param renders as a plain number input, not a slider", () => {
      render(<ParamFields params={[plainFloatParam]} values={{ reserve_percent: "50" }} onChange={vi.fn()} />);
      expect(screen.queryByRole("slider")).not.toBeInTheDocument();
      expect(screen.getByRole("spinbutton")).toBeInTheDocument();
    });

    it("moving the slider fires onChange with the raw string value", () => {
      const onChange = vi.fn();
      render(<ParamFields params={[percentSliderParam]} values={{ one_way_chance: "1" }} onChange={onChange} />);
      fireEvent.change(screen.getByRole("slider"), { target: { value: "80" } });
      expect(onChange).toHaveBeenCalledWith("one_way_chance", "80");
    });
  });

  it("renders nothing for an empty params list", () => {
    const { container } = render(<ParamFields params={[]} values={{}} onChange={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  describe("disabled prop", () => {
    it("leaves every control enabled when disabled is unset (default)", () => {
      render(<ParamFields params={[plainFloatParam, boolParam, enumParam]} values={{ reserve_percent: "50", protect_route: "true", region_class: "trap" }} onChange={vi.fn()} />);
      expect(screen.getByRole("spinbutton")).not.toBeDisabled();
      expect(screen.getByRole("checkbox")).not.toBeDisabled();
      expect(screen.getByRole("combobox")).not.toBeDisabled();
    });

    it("disables the plain number input for a float/integer param", () => {
      render(<ParamFields params={[plainFloatParam]} values={{ reserve_percent: "50" }} onChange={vi.fn()} disabled />);
      expect(screen.getByRole("spinbutton")).toBeDisabled();
    });

    it("disables both halves of an interval param", () => {
      render(<ParamFields params={[intervalParam]} values={{ desired_length: "3,10" }} onChange={vi.fn()} disabled />);
      const inputs = screen.getAllByRole("spinbutton");
      expect(inputs[0]).toBeDisabled();
      expect(inputs[1]).toBeDisabled();
    });

    it("disables the percent-slider range input", () => {
      render(<ParamFields params={[percentSliderParam]} values={{ one_way_chance: "37" }} onChange={vi.fn()} disabled />);
      expect(screen.getByRole("slider")).toBeDisabled();
    });

    it("disables the Switch control for a bool param", () => {
      render(<ParamFields params={[boolParam]} values={{ protect_route: "true" }} onChange={vi.fn()} disabled />);
      expect(screen.getByRole("checkbox")).toBeDisabled();
    });

    it("disables the select control for an enum param", () => {
      render(<ParamFields params={[enumParam]} values={{ region_class: "trap" }} onChange={vi.fn()} disabled />);
      expect(screen.getByRole("combobox")).toBeDisabled();
    });

    it("a disabled control still shows its current value, just not editable", () => {
      render(<ParamFields params={[plainFloatParam]} values={{ reserve_percent: "50" }} onChange={vi.fn()} disabled />);
      expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("50");
    });
  });

  describe("add_split_config param (non-pattern mode)", () => {
    it("shows the stored integer value as-is", () => {
      render(<ParamFields params={[addSplitConfigParam]} values={{ split_config: "5" }} onChange={vi.fn()} />);
      expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("5");
    });

    it("falls back to the kind's own default when the stored value is leftover pattern-mode JSON weights", () => {
      render(<ParamFields params={[addSplitConfigParam]} values={{ split_config: "[1,2]" }} onChange={vi.fn()} />);
      expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("3");
    });

    it("falls back to the kind's own default when the stored value is empty", () => {
      render(<ParamFields params={[addSplitConfigParam]} values={{ split_config: "" }} onChange={vi.fn()} />);
      expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("3");
    });
  });

  describe("add_split_config pattern weights", () => {
    it("keeps an empty weight draft until blur, then restores it with the shared input hint", () => {
      render(<StatefulAddSplitWeights />);
      fireEvent.click(screen.getByText("Weight settings"));
      const input = document.querySelector('input[name="split-pattern-0-weight"]') as HTMLInputElement;
      fireEvent.change(input, { target: { value: "" } });
      expect(input).toHaveValue("");
      fireEvent.blur(input);
      expect(input).toHaveValue("1");
      expect(screen.getByTestId("field-hint")).toHaveTextContent(m["input_hint.restored"]());
    });
  });

  describe("param selection (onSelectParam/selectedParamId, GitHub issue #375)", () => {
    it("shows no row click handler when onSelectParam is not passed", () => {
      render(<ParamFields params={[plainFloatParam]} values={{ reserve_percent: "50" }} onChange={vi.fn()} />);
      expect(screen.queryByRole("button", { name: "Reserve percent" })).not.toBeInTheDocument();
    });

    it("pressing Enter on the row calls onSelectParam", () => {
      const onSelectParam = vi.fn();
      render(<ParamFields params={[plainFloatParam]} values={{ reserve_percent: "50" }} onChange={vi.fn()} onSelectParam={onSelectParam} />);
      fireEvent.keyDown(screen.getByText("Reserve percent").closest('[role="button"]')!, { key: "Enter" });
      expect(onSelectParam).toHaveBeenCalledWith("reserve_percent");
    });

    it("clicking anywhere else in the row also calls onSelectParam with that param's id", () => {
      const onSelectParam = vi.fn();
      render(<ParamFields params={[plainFloatParam]} values={{ reserve_percent: "50" }} onChange={vi.fn()} onSelectParam={onSelectParam} />);
      fireEvent.click(screen.getByText("Reserve percent"));
      expect(onSelectParam).toHaveBeenCalledWith("reserve_percent");
    });

    it("clicking the value control itself does not call onSelectParam (stops propagation)", () => {
      const onSelectParam = vi.fn();
      render(<ParamFields params={[boolParam]} values={{ protect_route: "true" }} onChange={vi.fn()} onSelectParam={onSelectParam} />);
      fireEvent.click(screen.getByRole("checkbox"));
      expect(onSelectParam).not.toHaveBeenCalled();
    });

    it("only the row matching selectedParamId gets a highlight background", () => {
      render(
        <ParamFields
          params={[plainFloatParam, plainIntegerParam]}
          values={{ reserve_percent: "50", max_attempts: "5" }}
          onChange={vi.fn()}
          onSelectParam={vi.fn()}
          selectedParamId="max_attempts"
        />
      );
      const selectedRow = screen.getByText("Max attempts").closest("label")!.closest("span")!.parentElement!.parentElement as HTMLElement;
      const unselectedRow = screen.getByText("Reserve percent").closest("label")!.closest("span")!.parentElement!.parentElement as HTMLElement;
      expect(selectedRow.style.background).not.toBe("");
      expect(unselectedRow.style.background).toBe("");
    });
  });
});
