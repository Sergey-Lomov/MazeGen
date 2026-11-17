import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SliderRow } from "../components/SliderRow";
import * as m from "~/paraglide/messages";

describe("SliderRow", () => {
  it("replaces the displayed value with an exact unbounded numeric input", () => {
    const onChange = vi.fn();
    render(<SliderRow label="Size" value={40} min={0} max={40} onChange={onChange} format={String} />);

    const value = screen.getByRole("button", { name: m["common.exact_input"]() });
    expect(value).toHaveTextContent("40");
    expect(value).toHaveStyle({ height: "22px" });
    fireEvent.click(value);

    const input = screen.getByRole("spinbutton", { name: "Size value" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("min", "0");
    expect(input).toHaveStyle({ height: "22px" });
    fireEvent.change(input, { target: { value: "72.5" } });
    expect(onChange).toHaveBeenLastCalledWith(72.5);
  });

  it("maps probability controls to a 0.0% through 100.0% UI range", () => {
    const onChange = vi.fn();
    render(<SliderRow label="Chance" value={0.123} onChange={onChange} percent />);

    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "100");
    expect(slider).toHaveAttribute("step", "0.1");
    expect(slider).toHaveValue("12.3");
    const value = screen.getByRole("button", { name: m["common.exact_input"]() });
    expect(value).toHaveTextContent("12.3%");
    expect(value).toHaveStyle({ width: "48px" });

    fireEvent.change(slider, { target: { value: "45.6" } });
    expect(onChange).toHaveBeenLastCalledWith(0.456);

    fireEvent.click(value);
    const input = screen.getByRole("spinbutton", { name: "Chance value" });
    expect(input).toHaveAttribute("min", "0");
    expect(input).toHaveAttribute("max", "100");
    fireEvent.change(input, { target: { value: "150" } });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it("maps a probability exact-input maximum from the stored scale", () => {
    render(<SliderRow label="Chance" value={0.1} onChange={() => {}} percent preciseMax={0.5} />);

    fireEvent.click(screen.getByRole("button", { name: m["common.exact_input"]() }));
    expect(screen.getByRole("spinbutton", { name: "Chance value" })).toHaveAttribute("max", "50");
  });
});
