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

  function selectHsl() {
    fireEvent.click(screen.getByText("HSL"));
  }

  it("switching to the HSL model swaps in the HSL editor and marks its button selected", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    selectHsl();
    expect(screen.queryByTestId("color-picker-rgb")).toBeNull();
    expect(screen.getByTestId("color-picker-hsl")).toBeTruthy();
    expect((screen.getByText("HSL") as HTMLButtonElement).className).toContain("btn-toggle-selected");
    expect(screen.getByTestId("color-picker-hsl-area")).toBeTruthy();
    expect(screen.getByTestId("color-picker-hsl-hue")).toBeTruthy();
  });

  it("HSL controls reflect the working color reconstructed from RGB", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    selectHsl();
    expect((screen.getByLabelText("H value") as HTMLInputElement).value).toBe("0");
    expect((screen.getByLabelText("S value") as HTMLInputElement).value).toBe("100");
    expect((screen.getByLabelText("L value") as HTMLInputElement).value).toBe("50");
  });

  it("editing an HSL channel input updates preview and hex live, commits on Apply", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0xff0000} onChange={onChange} />);
    openPicker();
    selectHsl();
    fireEvent.change(screen.getByLabelText("H value"), { target: { value: "120" } });
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#00ff00");
    expect(screen.getByTestId("color-picker-preview").style.background).toContain("rgb(0, 255, 0)");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange).toHaveBeenCalledWith(0x00ff00);
  });

  it("editing an HSL slider updates the working color", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    selectHsl();
    fireEvent.change(screen.getByLabelText("L"), { target: { value: "0" } });
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#000000");
  });

  it("typing a hex keeps the HSL controls in sync", () => {
    render(<ColorSwatch color={0x000000} onChange={() => {}} />);
    openPicker();
    selectHsl();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#0000ff" } });
    expect((screen.getByLabelText("H value") as HTMLInputElement).value).toBe("240");
    expect((screen.getByLabelText("S value") as HTMLInputElement).value).toBe("100");
    expect((screen.getByLabelText("L value") as HTMLInputElement).value).toBe("50");
  });

  it("clearing an HSL channel input leaves the working color untouched", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x336699} onChange={onChange} />);
    openPicker();
    selectHsl();
    fireEvent.change(screen.getByLabelText("H value"), { target: { value: "" } });
    expect((screen.getByLabelText("H value") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#336699");
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange).toHaveBeenCalledWith(0x336699);
  });

  it("an out-of-range HSL channel input is clamped to its range", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    selectHsl();
    fireEvent.change(screen.getByLabelText("S value"), { target: { value: "999" } });
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#ff0000");
    fireEvent.change(screen.getByLabelText("L value"), { target: { value: "-5" } });
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#000000");
  });

  it("moving the S slider leaves H and L untouched", () => {
    render(<ColorSwatch color={0x3a6ea5} onChange={() => {}} />);
    openPicker();
    selectHsl();
    const h0 = (screen.getByLabelText("H value") as HTMLInputElement).value;
    const l0 = (screen.getByLabelText("L value") as HTMLInputElement).value;
    fireEvent.change(screen.getByLabelText("S"), { target: { value: "20" } });
    expect((screen.getByLabelText("S value") as HTMLInputElement).value).toBe("20");
    expect((screen.getByLabelText("H value") as HTMLInputElement).value).toBe(h0);
    expect((screen.getByLabelText("L value") as HTMLInputElement).value).toBe(l0);
  });

  it("driving L to 0 keeps H and S in the controls (not reset to 0)", () => {
    render(<ColorSwatch color={0x3a6ea5} onChange={() => {}} />);
    openPicker();
    selectHsl();
    const h0 = (screen.getByLabelText("H value") as HTMLInputElement).value;
    const s0 = (screen.getByLabelText("S value") as HTMLInputElement).value;
    fireEvent.change(screen.getByLabelText("L"), { target: { value: "0" } });
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#000000");
    expect((screen.getByLabelText("H value") as HTMLInputElement).value).toBe(h0);
    expect((screen.getByLabelText("S value") as HTMLInputElement).value).toBe(s0);
  });

  it("the H slider holds 360 instead of snapping to 0", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    selectHsl();
    fireEvent.change(screen.getByLabelText("H"), { target: { value: "360" } });
    expect((screen.getByLabelText("H value") as HTMLInputElement).value).toBe("360");
    expect((screen.getByLabelText("H") as HTMLInputElement).value).toBe("360");
  });

  it("switching RGB -> HSL -> RGB preserves the working color", () => {
    render(<ColorSwatch color={0x7f3d1c} onChange={() => {}} />);
    openPicker();
    selectHsl();
    fireEvent.click(screen.getByText("RGB"));
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#7f3d1c");
  });

  it("arrow keys on the 2D area nudge S and L (Shift = bigger step), clamped to range", () => {
    render(<ColorSwatch color={0x808080} onChange={() => {}} />); // H 0, S 0, L ~50
    openPicker();
    selectHsl();
    const area = screen.getByTestId("color-picker-hsl-area");
    fireEvent.keyDown(area, { key: "ArrowRight" });
    expect((screen.getByLabelText("S value") as HTMLInputElement).value).toBe("1");
    fireEvent.keyDown(area, { key: "ArrowRight", shiftKey: true });
    expect((screen.getByLabelText("S value") as HTMLInputElement).value).toBe("11");
    fireEvent.keyDown(area, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(area, { key: "ArrowLeft", shiftKey: true });
    expect((screen.getByLabelText("S value") as HTMLInputElement).value).toBe("0"); // clamped, not -9
    const l0 = Number((screen.getByLabelText("L value") as HTMLInputElement).value);
    fireEvent.keyDown(area, { key: "ArrowUp" });
    expect(Number((screen.getByLabelText("L value") as HTMLInputElement).value)).toBe(l0 + 1);
    fireEvent.keyDown(area, { key: "ArrowDown" });
    expect(Number((screen.getByLabelText("L value") as HTMLInputElement).value)).toBe(l0);
  });

  it("a non-arrow key on the 2D area does nothing", () => {
    render(<ColorSwatch color={0x336699} onChange={() => {}} />);
    openPicker();
    selectHsl();
    const hex0 = (screen.getByLabelText(hexLabel()) as HTMLInputElement).value;
    fireEvent.keyDown(screen.getByTestId("color-picker-hsl-area"), { key: "a" });
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe(hex0);
  });

  it("up / down on the hue strip nudge H (Shift = bigger step), clamped to 0-360", () => {
    render(<ColorSwatch color={0x00ff00} onChange={() => {}} />); // H 120
    openPicker();
    selectHsl();
    const strip = screen.getByTestId("color-picker-hsl-hue");
    fireEvent.keyDown(strip, { key: "ArrowUp" });
    expect((screen.getByLabelText("H value") as HTMLInputElement).value).toBe("119");
    fireEvent.keyDown(strip, { key: "ArrowDown", shiftKey: true });
    expect((screen.getByLabelText("H value") as HTMLInputElement).value).toBe("129");
    fireEvent.keyDown(strip, { key: "x" }); // ignored
    expect((screen.getByLabelText("H value") as HTMLInputElement).value).toBe("129");
  });

  // Pointer-drag on the 2D area / hue strip (`setFromArea` / `setFromHue`) isn't unit-tested:
  // jsdom's synthetic PointerEvent drops clientX/clientY and has no layout, so a `fireEvent`
  // drag can't reproduce a real cursor position. Covered by the keyboard-nudge tests above and
  // by manual / visual checks.

  function selectOklch() {
    fireEvent.click(screen.getByText("OKLCH"));
  }

  it("switching to the OKLCH model swaps in the OKLCH editor and marks its button selected", () => {
    render(<ColorSwatch color={0x336699} onChange={() => {}} />);
    openPicker();
    selectOklch();
    expect(screen.queryByTestId("color-picker-rgb")).toBeNull();
    expect(screen.getByTestId("color-picker-oklch")).toBeTruthy();
    expect((screen.getByText("OKLCH") as HTMLButtonElement).className).toContain("btn-toggle-selected");
  });

  it("OKLCH controls reflect the working color, three channels L / C / H", () => {
    render(<ColorSwatch color={0xffffff} onChange={() => {}} />);
    openPicker();
    selectOklch();
    expect((screen.getByLabelText("L value") as HTMLInputElement).value).toBe("100");
    expect((screen.getByLabelText("C value") as HTMLInputElement).value).toBe("0.0000");
    expect((screen.getByLabelText("H value") as HTMLInputElement).value).toBe("0");
  });

  it("editing an OKLCH channel input updates preview and hex live, commits on Apply", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0xffffff} onChange={onChange} />);
    openPicker();
    selectOklch();
    fireEvent.change(screen.getByLabelText("L value"), { target: { value: "0" } });
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#000000");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange).toHaveBeenCalledWith(0x000000);
  });

  it("editing an OKLCH slider updates the working color", () => {
    render(<ColorSwatch color={0xffffff} onChange={() => {}} />);
    openPicker();
    selectOklch();
    fireEvent.change(screen.getByLabelText("L"), { target: { value: "0" } });
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#000000");
  });

  it("typing a hex keeps the OKLCH controls in sync", () => {
    render(<ColorSwatch color={0x000000} onChange={() => {}} />);
    openPicker();
    selectOklch();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#ffffff" } });
    expect((screen.getByLabelText("L value") as HTMLInputElement).value).toBe("100");
    expect((screen.getByLabelText("C value") as HTMLInputElement).value).toBe("0.0000");
  });

  it("clearing an OKLCH channel input leaves the working color untouched", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x336699} onChange={onChange} />);
    openPicker();
    selectOklch();
    fireEvent.change(screen.getByLabelText("C value"), { target: { value: "" } });
    expect((screen.getByLabelText("C value") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#336699");
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange).toHaveBeenCalledWith(0x336699);
  });

  it("blurring an OKLCH channel input drops its text buffer", () => {
    render(<ColorSwatch color={0x336699} onChange={() => {}} />);
    openPicker();
    selectOklch();
    const input = screen.getByLabelText("C value") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.blur(input);
    // Buffer gone -> the field falls back to the current channel value.
    expect(input.value).not.toBe("");
  });

  it("an out-of-range OKLCH channel input is clamped to its range", () => {
    render(<ColorSwatch color={0xffffff} onChange={() => {}} />);
    openPicker();
    selectOklch();
    fireEvent.change(screen.getByLabelText("L value"), { target: { value: "999" } });
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#ffffff");
    fireEvent.change(screen.getByLabelText("L value"), { target: { value: "-5" } });
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#000000");
  });

  it("moving the OKLCH C slider leaves L and H untouched", () => {
    render(<ColorSwatch color={0x3a6ea5} onChange={() => {}} />);
    openPicker();
    selectOklch();
    const l0 = (screen.getByLabelText("L value") as HTMLInputElement).value;
    const h0 = (screen.getByLabelText("H value") as HTMLInputElement).value;
    fireEvent.change(screen.getByLabelText("C"), { target: { value: "0.05" } });
    expect((screen.getByLabelText("L value") as HTMLInputElement).value).toBe(l0);
    expect((screen.getByLabelText("H value") as HTMLInputElement).value).toBe(h0);
  });

  it("the gamut badge stays mounted and only swaps its text between in- and out-of-sRGB", () => {
    render(<ColorSwatch color={0x00ff00} onChange={() => {}} />);
    openPicker();
    selectOklch();
    const badge = screen.getByTestId("color-picker-oklch-gamut-badge");
    expect(badge.dataset.outOfGamut).toBe("false");
    // Push chroma far past what green at this L can hold in sRGB.
    fireEvent.change(screen.getByLabelText("C value"), { target: { value: "0.4" } });
    expect(screen.getByTestId("color-picker-oklch-gamut-badge").dataset.outOfGamut).toBe("true");
    fireEvent.change(screen.getByLabelText("C value"), { target: { value: "0" } });
    expect(screen.getByTestId("color-picker-oklch-gamut-badge").dataset.outOfGamut).toBe("false");
  });

  it("switching RGB -> OKLCH -> RGB preserves the working color", () => {
    render(<ColorSwatch color={0x7f3d1c} onChange={() => {}} />);
    openPicker();
    selectOklch();
    fireEvent.click(screen.getByText("RGB"));
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#7f3d1c");
  });

  it("the OKLCH model shows the 2D area and the hue strip", () => {
    render(<ColorSwatch color={0x336699} onChange={() => {}} />);
    openPicker();
    selectOklch();
    expect(screen.getByTestId("color-picker-oklch-area")).toBeTruthy();
    expect(screen.getByTestId("color-picker-oklch-hue")).toBeTruthy();
  });

  it("arrow keys on the OKLCH area nudge C and L (Shift = bigger step), clamped", () => {
    render(<ColorSwatch color={0x808080} onChange={() => {}} />);
    openPicker();
    selectOklch();
    const area = screen.getByTestId("color-picker-oklch-area");
    const l0 = Number((screen.getByLabelText("L value") as HTMLInputElement).value);
    fireEvent.keyDown(area, { key: "ArrowUp" });
    expect(Number((screen.getByLabelText("L value") as HTMLInputElement).value)).toBe(l0 + 1);
    fireEvent.keyDown(area, { key: "ArrowDown" });
    expect(Number((screen.getByLabelText("L value") as HTMLInputElement).value)).toBe(l0);
    fireEvent.keyDown(area, { key: "ArrowRight" });
    expect(Number((screen.getByLabelText("C value") as HTMLInputElement).value)).toBeGreaterThan(0);
    fireEvent.keyDown(area, { key: "ArrowLeft", shiftKey: true });
    expect((screen.getByLabelText("C value") as HTMLInputElement).value).toBe("0.0000"); // clamped, not negative
  });

  it("a non-arrow key on the OKLCH area does nothing", () => {
    render(<ColorSwatch color={0x336699} onChange={() => {}} />);
    openPicker();
    selectOklch();
    const hex0 = (screen.getByLabelText(hexLabel()) as HTMLInputElement).value;
    fireEvent.keyDown(screen.getByTestId("color-picker-oklch-area"), { key: "a" });
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe(hex0);
  });

  it("up / down on the OKLCH hue strip nudge H (Shift = bigger step), clamped to 0-360", () => {
    render(<ColorSwatch color={0x00ff00} onChange={() => {}} />);
    openPicker();
    selectOklch();
    const strip = screen.getByTestId("color-picker-oklch-hue");
    const h0 = Number((screen.getByLabelText("H value") as HTMLInputElement).value);
    fireEvent.keyDown(strip, { key: "ArrowUp" });
    expect(Number((screen.getByLabelText("H value") as HTMLInputElement).value)).toBe(h0 - 1);
    fireEvent.keyDown(strip, { key: "ArrowDown", shiftKey: true });
    expect(Number((screen.getByLabelText("H value") as HTMLInputElement).value)).toBe(h0 + 9);
    fireEvent.keyDown(strip, { key: "x" }); // ignored
    expect(Number((screen.getByLabelText("H value") as HTMLInputElement).value)).toBe(h0 + 9);
  });

  // Pointer-drag on the OKLCH area / hue strip (`setFromArea` / `setFromHue`) isn't unit-tested
  // for the same reason as HSL: jsdom's synthetic PointerEvent has no clientX/clientY or layout.
  // The 2D area's per-pixel canvas paint (`paintLcPlane`) also no-ops under jsdom (no 2d context);
  // covered by the keyboard-nudge tests above and by manual / visual checks.
});
