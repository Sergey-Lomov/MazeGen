import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ParamFields } from "../components/features/ParamFields";
import type { ParamDescriptor } from "../wasm/types";

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

const intervalParam: ParamDescriptor = {
  id: "desired_length",
  label: "Desired graph length",
  kind: { type: "interval", default_min: 0, default_max: 1000, min: 0, max: 100_000 },
};

const percentSliderParam: ParamDescriptor = {
  id: "unreachable_priority",
  label: "Unreachable area priority",
  kind: { type: "float", default: 1, min: 0, max: 100 },
};

const plainFloatParam: ParamDescriptor = {
  id: "reserve_percent",
  label: "Reserve percent",
  kind: { type: "float", default: 50, min: 0, max: 500 },
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

describe("ParamFields", () => {
  describe("interval param", () => {
    it("renders the min/max halves of a \"min,max\" value in two separate number inputs", () => {
      render(<ParamFields params={[intervalParam]} values={{ desired_length: "3,10" }} onChange={vi.fn()} />);
      const inputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
      expect(inputs).toHaveLength(2);
      expect(inputs[0].value).toBe("3");
      expect(inputs[1].value).toBe("10");
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

    it("onBlur leaves an in-order range untouched", () => {
      const onCommit = vi.fn();
      render(<StatefulParamFields params={[intervalParam]} initial={{ desired_length: "3,10" }} onCommit={onCommit} />);
      const [minInput] = screen.getAllByRole("spinbutton");
      fireEvent.change(minInput, { target: { value: "5" } });
      onCommit.mockClear();
      fireEvent.blur(minInput);
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("onBlur on an emptied min field falls back to the param's own min bound instead of leaving an invalid string", () => {
      const onCommit = vi.fn();
      render(<StatefulParamFields params={[intervalParam]} initial={{ desired_length: "3,10" }} onCommit={onCommit} />);
      const [minInput] = screen.getAllByRole("spinbutton");
      fireEvent.change(minInput, { target: { value: "" } });
      onCommit.mockClear();
      fireEvent.blur(minInput);
      expect(onCommit).toHaveBeenCalledWith("desired_length", "0,10");
    });

    it("onBlur on an emptied max field falls back to the param's own max bound", () => {
      const onCommit = vi.fn();
      render(<StatefulParamFields params={[intervalParam]} initial={{ desired_length: "3,10" }} onCommit={onCommit} />);
      const [, maxInput] = screen.getAllByRole("spinbutton");
      fireEvent.change(maxInput, { target: { value: "" } });
      onCommit.mockClear();
      fireEvent.blur(maxInput);
      expect(onCommit).toHaveBeenCalledWith("desired_length", "3,100000");
    });
  });

  describe("percent-slider param", () => {
    it("renders an allowlisted float param as a range input with a rounded percent label", () => {
      render(<ParamFields params={[percentSliderParam]} values={{ unreachable_priority: "37.4" }} onChange={vi.fn()} />);
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
      render(<ParamFields params={[percentSliderParam]} values={{ unreachable_priority: "1" }} onChange={onChange} />);
      fireEvent.change(screen.getByRole("slider"), { target: { value: "80" } });
      expect(onChange).toHaveBeenCalledWith("unreachable_priority", "80");
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
      render(<ParamFields params={[percentSliderParam]} values={{ unreachable_priority: "37" }} onChange={vi.fn()} disabled />);
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
});
