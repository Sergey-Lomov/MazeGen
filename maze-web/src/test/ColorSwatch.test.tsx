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

  it("shows the RGB model with a selected switcher button and channel controls", () => {
    render(<ColorSwatch color={0x336699} onChange={() => {}} />);
    openPicker();
    expect(screen.getByTestId("color-picker-rgb")).toBeTruthy();
    const rgbBtn = screen.getByText("RGB") as HTMLButtonElement;
    expect(rgbBtn.className).toContain("btn-toggle-selected");
    const rSlider = screen.getByLabelText("R") as HTMLInputElement;
    expect(rSlider.value).toBe("51");
    expect((screen.getByLabelText("R value") as HTMLInputElement).value).toBe("51");
  });

  it("editing an RGB channel input updates preview and hex live, commits on Apply", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} />);
    openPicker();
    fireEvent.change(screen.getByLabelText("R value"), { target: { value: "255" } });
    expect(screen.getByTestId("color-picker-preview").style.background).toContain("rgb(255, 0, 0)");
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#ff0000");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange).toHaveBeenCalledWith(0xff0000);
  });

  it("editing an RGB slider updates the working color", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} />);
    openPicker();
    fireEvent.change(screen.getByLabelText("G"), { target: { value: "128" } });
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#008000");
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange).toHaveBeenCalledWith(0x008000);
  });

  it("typing a hex keeps the RGB channel controls in sync", () => {
    render(<ColorSwatch color={0x000000} onChange={() => {}} />);
    openPicker();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#0a141e" } });
    expect((screen.getByLabelText("R value") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("G value") as HTMLInputElement).value).toBe("20");
    expect((screen.getByLabelText("B value") as HTMLInputElement).value).toBe("30");
  });

  it("clearing an RGB channel input leaves the working color untouched", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x102030} onChange={onChange} />);
    openPicker();
    fireEvent.change(screen.getByLabelText("R value"), { target: { value: "" } });
    expect((screen.getByLabelText("R value") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#102030");
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange).toHaveBeenCalledWith(0x102030);
  });

  it("an out-of-range RGB channel input is clamped to 0-255", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} />);
    openPicker();
    fireEvent.change(screen.getByLabelText("R value"), { target: { value: "999" } });
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#ff0000");
    fireEvent.change(screen.getByLabelText("G value"), { target: { value: "-5" } });
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#ff0000");
  });

  it("blurring an empty RGB channel input restores the actual value", () => {
    render(<ColorSwatch color={0x0a0a0a} onChange={() => {}} />);
    openPicker();
    const r = screen.getByLabelText("R value") as HTMLInputElement;
    fireEvent.change(r, { target: { value: "" } });
    expect(r.value).toBe("");
    fireEvent.blur(r);
    expect(r.value).toBe("10");
  });

  it("editing the hex field drops a stale (empty) RGB channel input buffer", () => {
    render(<ColorSwatch color={0x0a0a0a} onChange={() => {}} />);
    openPicker();
    const r = screen.getByLabelText("R value") as HTMLInputElement;
    // Clear the R input — the color stays put, the buffer holds "".
    fireEvent.change(r, { target: { value: "" } });
    expect(r.value).toBe("");
    // A change from outside the RGB editor must re-sync the channel input, not leave it blank.
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#804020" } });
    expect(r.value).toBe("128");
  });
});
