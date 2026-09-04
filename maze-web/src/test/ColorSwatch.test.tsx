import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ColorSwatch } from "../components/ColorSwatch";
import * as m from "~/paraglide/messages";

const hexLabel = () => m["color_picker.hex_label"]();
const applyLabel = () => m["common.apply"]();
const cancelLabel = () => m["common.cancel"]();

function openPicker() {
  fireEvent.click(screen.getByRole("button"));
}

describe("ColorSwatch", () => {
  it("renders the color as its background", () => {
    render(<ColorSwatch color={0x336699} onChange={() => {}} />);
    const swatch = screen.getByRole("button");
    expect(swatch.style.background).toContain("rgb(51, 102, 153)");
  });

  it("clicking the swatch opens the color picker panel seeded with the current color", () => {
    render(<ColorSwatch color={0x336699} onChange={() => {}} />);
    expect(screen.queryByTestId("color-picker-preview")).toBeNull();
    openPicker();
    const hex = screen.getByLabelText(hexLabel()) as HTMLInputElement;
    expect(hex.value).toBe("#336699");
    expect(screen.getByTestId("color-picker-preview").style.background).toContain("rgb(51, 102, 153)");
  });

  it("Enter on a focused swatch opens the picker (keyboard accessible)", () => {
    render(<ColorSwatch color={0x000000} onChange={() => {}} />);
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    expect(screen.getByTestId("color-picker-preview")).toBeTruthy();
  });

  it("Space on a focused swatch also opens the picker", () => {
    render(<ColorSwatch color={0x000000} onChange={() => {}} />);
    fireEvent.keyDown(screen.getByRole("button"), { key: " " });
    expect(screen.getByTestId("color-picker-preview")).toBeTruthy();
  });

  it("Escape inside the picker closes it without committing", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} />);
    openPicker();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#abcdef" } });
    fireEvent.keyDown(screen.getByTestId("color-picker-preview"), { key: "Escape" });
    expect(screen.queryByTestId("color-picker-preview")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("typing a valid hex updates the preview live but does not call onChange until Apply", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} />);
    openPicker();
    const hex = screen.getByLabelText(hexLabel());
    fireEvent.change(hex, { target: { value: "#ff00aa" } });
    expect(screen.getByTestId("color-picker-preview").style.background).toContain("rgb(255, 0, 170)");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange).toHaveBeenCalledWith(0xff00aa);
  });

  it("an invalid hex disables Apply and does not move the preview", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x112233} onChange={onChange} />);
    openPicker();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#zz" } });
    expect(screen.getByTestId("color-picker-preview").style.background).toContain("rgb(17, 34, 51)");
    expect((screen.getByText(applyLabel()) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Cancel closes the picker without touching the swatch", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} />);
    openPicker();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#abcdef" } });
    fireEvent.click(screen.getByText(cancelLabel()));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("color-picker-preview")).toBeNull();
  });

  it("Apply closes the picker", () => {
    render(<ColorSwatch color={0x000000} onChange={() => {}} />);
    openPicker();
    fireEvent.click(screen.getByText(applyLabel()));
    expect(screen.queryByTestId("color-picker-preview")).toBeNull();
  });

  it("disabled swatch is not focusable and clicking/keydown do not open the picker", () => {
    render(<ColorSwatch color={0x000000} onChange={() => {}} disabled />);
    const swatch = screen.getByRole("button");
    expect(swatch).toHaveAttribute("tabIndex", "-1");
    expect(swatch).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(swatch);
    fireEvent.keyDown(swatch, { key: "Enter" });
    expect(screen.queryByTestId("color-picker-preview")).toBeNull();
  });

  it("no hidden native color input remains", () => {
    render(<ColorSwatch color={0x000000} onChange={() => {}} />);
    openPicker();
    expect(document.querySelector('input[type="color"]')).toBeNull();
  });
});
