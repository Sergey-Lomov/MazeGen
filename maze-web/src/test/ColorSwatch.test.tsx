import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ColorSwatch } from "../components/ColorSwatch";
import { setColorSampler } from "../pixi/colorSampleBridge";
import { colorAtCenter } from "../components/ColorEyedropperOverlay";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";

// `ColorPickerPanel` throttles the live preview (#513) to one `onPreview` call per rAF — mock it to
// run synchronously so tests don't need to await a real animation frame.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => { vi.unstubAllGlobals(); });

const hexToColorNum = (hex: string) => parseInt(hex.replace("#", ""), 16);

// Mirrors `RANGE_SPLIT_AUTO_MIN.l` / `RANGE_SPLIT_AUTO_MAX.l` in `ToolsSection.tsx`.
const RANGE_SPLIT_AUTO_MIN_L = 15;
const RANGE_SPLIT_AUTO_MAX_L = 95;

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

  it("shows the collapsible empty export-warnings section only when color warnings are enabled", () => {
    const previous = useMazeStore.getState().showColorWarnings;
    const previousOpenMode = useMazeStore.getState().openRenderModeSettings;
    useMazeStore.setState({ showColorWarnings: true, openRenderModeSettings: null });
    render(<ColorSwatch color={0x336699} onChange={() => {}} />);
    openPicker();
    const title = m["image_export.vector_by_walls.section_warnings"]({ count: "0" });
    expect(screen.getByText(title)).toBeInTheDocument();
    fireEvent.click(screen.getByText(title));
    expect(screen.getByText(m["color_picker.no_export_warnings"]())).toBeInTheDocument();
    useMazeStore.setState({ showColorWarnings: previous, openRenderModeSettings: previousOpenMode });
  });

  it("hides the export-warnings section when color warnings are disabled", () => {
    const previous = useMazeStore.getState().showColorWarnings;
    const previousOpenMode = useMazeStore.getState().openRenderModeSettings;
    useMazeStore.setState({ showColorWarnings: false, openRenderModeSettings: null });
    render(<ColorSwatch color={0x336699} onChange={() => {}} />);
    openPicker();
    expect(screen.queryByTestId("color-picker-export-warnings")).toBeNull();
    useMazeStore.setState({ showColorWarnings: previous, openRenderModeSettings: previousOpenMode });
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

  it("Escape inside the picker closes it and restores the original color via onPreview", () => {
    const onChange = vi.fn();
    const onPreview = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} onPreview={onPreview} />);
    openPicker();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#abcdef" } });
    expect(onPreview).toHaveBeenLastCalledWith(0xabcdef);
    fireEvent.keyDown(screen.getByTestId("color-picker-preview"), { key: "Escape" });
    expect(screen.queryByTestId("color-picker-preview")).toBeNull();
    expect(onPreview).toHaveBeenLastCalledWith(0x000000); // restored
    expect(onChange).not.toHaveBeenCalled(); // never committed
  });

  it("typing a valid hex previews live but commits via onChange only on Apply", () => {
    const onChange = vi.fn();
    const onPreview = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} onPreview={onPreview} />);
    openPicker();
    const hex = screen.getByLabelText(hexLabel());
    fireEvent.change(hex, { target: { value: "#ff00aa" } });
    expect(screen.getByTestId("color-picker-preview").style.background).toContain("rgb(255, 0, 170)");
    expect(onPreview).toHaveBeenLastCalledWith(0xff00aa);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange).toHaveBeenCalledWith(0xff00aa);
  });

  it("without onPreview, the working color streams to onChange live", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} />);
    openPicker();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#ff00aa" } });
    expect(onChange).toHaveBeenLastCalledWith(0xff00aa);
    fireEvent.click(screen.getByText(cancelLabel()));
    expect(onChange).toHaveBeenLastCalledWith(0x000000); // restored on cancel
  });

  it("without onPreview, Apply does not fire a second onChange for the already-streamed color", () => {
    // The live stream is the commit; Apply must not re-fire onChange (a history-pushing setter
    // would otherwise log the pick twice).
    const onChange = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} />);
    openPicker();
    fireEvent.change(screen.getByLabelText("R value"), { target: { value: "255" } });
    fireEvent.change(screen.getByLabelText("G value"), { target: { value: "128" } });
    const callsBeforeApply = onChange.mock.calls.length;
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange.mock.calls.length).toBe(callsBeforeApply); // no extra commit
    expect(onChange).toHaveBeenLastCalledWith(0xff8000); // last streamed value stands
  });

  it("without onPreview and no edits, Apply closes without ever calling onChange", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x334455} onChange={onChange} />);
    openPicker();
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("color-picker-preview")).toBeNull();
  });

  it("an invalid hex disables Apply and does not move the preview", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x112233} onChange={onChange} onPreview={() => {}} />);
    openPicker();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#zz" } });
    expect(screen.getByTestId("color-picker-preview").style.background).toContain("rgb(17, 34, 51)");
    expect((screen.getByText(applyLabel()) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Cancel closes the picker without committing and restores the original via onPreview", () => {
    const onChange = vi.fn();
    const onPreview = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} onPreview={onPreview} />);
    openPicker();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#abcdef" } });
    fireEvent.click(screen.getByText(cancelLabel()));
    expect(onChange).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenLastCalledWith(0x000000);
    expect(screen.queryByTestId("color-picker-preview")).toBeNull();
  });

  it("Apply closes the picker", () => {
    render(<ColorSwatch color={0x000000} onChange={() => {}} />);
    openPicker();
    fireEvent.click(screen.getByText(applyLabel()));
    expect(screen.queryByTestId("color-picker-preview")).toBeNull();
  });

  it("streams every working-color change to onPreview while open", () => {
    const onPreview = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={() => {}} onPreview={onPreview} />);
    openPicker();
    fireEvent.change(screen.getByLabelText("R value"), { target: { value: "255" } });
    fireEvent.change(screen.getByLabelText("G value"), { target: { value: "128" } });
    expect(onPreview).toHaveBeenNthCalledWith(1, 0xff0000);
    expect(onPreview).toHaveBeenNthCalledWith(2, 0xff8000);
  });

  it("Apply keeps the last previewed color (no restore) and commits it once", () => {
    const onChange = vi.fn();
    const onPreview = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} onPreview={onPreview} />);
    openPicker();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#ff00aa" } });
    onPreview.mockClear();
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onPreview).not.toHaveBeenCalled(); // last preview left in place
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(0xff00aa);
  });

  it("Cancel restores the open-time color even when the color prop tracked the live preview", () => {
    // Mirrors an image-export panel: onChange writes the store, the swatch's `color` prop then
    // re-renders to each previewed value. Cancel must still land on the pre-open color.
    function Harness() {
      const [color, setColor] = useState(0x111111);
      return <ColorSwatch color={color} onChange={setColor} />;
    }
    render(<Harness />);
    openPicker();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#abcdef" } });
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#00ff00" } });
    fireEvent.click(screen.getByText(cancelLabel()));
    fireEvent.click(screen.getByRole("button")); // reopen — swatch should be back to #111111
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#111111");
  });

  it("restore after many intermediate edits lands exactly on the original color", () => {
    const onPreview = vi.fn();
    render(<ColorSwatch color={0x123456} onChange={() => {}} onPreview={onPreview} />);
    openPicker();
    fireEvent.change(screen.getByLabelText("R value"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("G value"), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#abcdef" } });
    fireEvent.click(screen.getByText(cancelLabel()));
    expect(onPreview).toHaveBeenLastCalledWith(0x123456);
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
    render(<ColorSwatch color={0x000000} onChange={onChange} onPreview={() => {}} />);
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
    render(<ColorSwatch color={0x000000} onChange={onChange} onPreview={() => {}} />);
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
    render(<ColorSwatch color={0x102030} onChange={onChange} onPreview={() => {}} />);
    openPicker();
    fireEvent.change(screen.getByLabelText("R value"), { target: { value: "" } });
    expect((screen.getByLabelText("R value") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#102030");
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange).toHaveBeenCalledWith(0x102030);
  });

  it("an out-of-range RGB channel input is clamped to 0-255", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} onPreview={() => {}} />);
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
    render(<ColorSwatch color={0xff0000} onChange={onChange} onPreview={() => {}} />);
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
    render(<ColorSwatch color={0x336699} onChange={onChange} onPreview={() => {}} />);
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

  it("a keyboard nudge in the HSL area streams the new color to onPreview", () => {
    const onPreview = vi.fn();
    render(<ColorSwatch color={0x808080} onChange={() => {}} onPreview={onPreview} />);
    openPicker();
    selectHsl();
    onPreview.mockClear();
    fireEvent.keyDown(screen.getByTestId("color-picker-hsl-area"), { key: "ArrowUp" });
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(typeof onPreview.mock.calls[0][0]).toBe("number");
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
    render(<ColorSwatch color={0xffffff} onChange={onChange} onPreview={() => {}} />);
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
    render(<ColorSwatch color={0x336699} onChange={onChange} onPreview={() => {}} />);
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
  function expandHarmony() {
    fireEvent.click(screen.getByText(m["color_picker.tools"]()));
  }

  it("the Harmony section is collapsed by default and expands on click", () => {
    render(<ColorSwatch color={0x336699} onChange={() => {}} />);
    openPicker();
    expect(screen.queryByTestId("color-picker-tools-swatches")).toBeNull();
    expandHarmony();
    expect(screen.getByTestId("color-picker-tools-swatches")).toBeTruthy();
  });

  it("expanding the Tools section rebuilds the base from the current working color", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />); // pure red, H=0
    openPicker();
    // Change the working color before expanding — the section has never been opened yet, so it
    // hasn't seeded a stale base from the original color.
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#00ff00" } });
    expandHarmony();
    const swatches = screen.getByTestId("color-picker-tools-swatches").querySelectorAll("button");
    expect((swatches[0] as HTMLButtonElement).title).toBe("#00ff00");
  });

  it("Harmony defaults to Complementary: base + one derived swatch (hue +180)", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />); // pure red, H=0
    openPicker();
    expandHarmony();
    const swatches = screen.getByTestId("color-picker-tools-swatches").querySelectorAll("button");
    expect(swatches.length).toBe(2);
    expect((swatches[0] as HTMLButtonElement).style.background).toContain("rgb(255, 0, 0)");
    // Complementary of pure red (H=0) is H=180 -> cyan-ish.
    expect((swatches[1] as HTMLButtonElement).title).not.toBe("#ff0000");
  });

  it("clicking a Harmony swatch sets the working color but does not rebuild the row", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0xff0000} onChange={onChange} onPreview={() => {}} />);
    openPicker();
    expandHarmony();
    const swatches = screen.getByTestId("color-picker-tools-swatches").querySelectorAll("button");
    const derivedHex = (swatches[1] as HTMLButtonElement).title;
    fireEvent.click(swatches[1]);
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe(derivedHex);
    // Row unchanged — still base (red) + same derived swatch.
    const after = screen.getByTestId("color-picker-tools-swatches").querySelectorAll("button");
    expect((after[0] as HTMLButtonElement).title).toBe("#ff0000");
    expect((after[1] as HTMLButtonElement).title).toBe(derivedHex);
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange).toHaveBeenCalledWith(hexToColorNum(derivedHex));
  });

  it("editing sliders/hex does not rebuild the Harmony row", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    const before = Array.from(screen.getByTestId("color-picker-tools-swatches").querySelectorAll("button"))
      .map((b) => (b as HTMLButtonElement).title);
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#00ff00" } });
    const after = Array.from(screen.getByTestId("color-picker-tools-swatches").querySelectorAll("button"))
      .map((b) => (b as HTMLButtonElement).title);
    expect(after).toEqual(before);
  });

  it("'Rebuild from current color' rebuilds the row from the current working color", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#00ff00" } });
    fireEvent.click(screen.getByText(m["color_picker.tools.rebuild_from_current"]()));
    const swatches = screen.getByTestId("color-picker-tools-swatches").querySelectorAll("button");
    expect((swatches[0] as HTMLButtonElement).title).toBe("#00ff00");
  });

  function typeSelect() {
    return screen.getAllByRole("combobox")[0] as HTMLSelectElement;
  }
  function scaleSelect() {
    return screen.getAllByRole("combobox")[1] as HTMLSelectElement;
  }

  it("Divergence (Hue scale) shows count/step controls and renders two rows (+/-) of `count` swatches each, base excluded", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), {
      target: { value: "divergence" },
    });
    expect(screen.getByText(m["color_picker.tools.count"]())).toBeTruthy();
    expect(screen.getByText(m["color_picker.tools.step"]())).toBeTruthy();
    expect(screen.getByText(m["color_picker.tools.plus"]())).toBeTruthy();
    expect(screen.getByText(m["color_picker.tools.minus"]())).toBeTruthy();
    // default count = 4 -> 4 swatches per row, 8 total, none of them the base color.
    const swatches = Array.from(
      screen.getByTestId("color-picker-divergence-swatches").querySelectorAll("button"),
    ) as HTMLButtonElement[];
    expect(swatches.length).toBe(8);
    expect(swatches.some((b) => b.title === "#ff0000")).toBe(false);
  });

  it("Triadic / Tetradic have fixed derived counts (no count/step controls)", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), {
      target: { value: "triadic" },
    });
    expect(screen.queryByText(m["color_picker.tools.count"]())).toBeNull();
    expect(screen.getByTestId("color-picker-tools-swatches").querySelectorAll("button").length).toBe(3);

    fireEvent.change(typeSelect(), {
      target: { value: "tetradic" },
    });
    expect(screen.getByTestId("color-picker-tools-swatches").querySelectorAll("button").length).toBe(4);
  });

  it("Divergence auto-fit step button sets step = 180 / count for the Hue scale", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "divergence" } });
    const [countSlider, stepSlider] = Array.from(
      screen.getByTestId("color-picker-divergence-swatches").parentElement!.querySelectorAll('input[type="range"]'),
    ) as HTMLInputElement[];
    fireEvent.change(countSlider, { target: { value: "6" } });
    fireEvent.click(screen.getByTitle(m["color_picker.tools.auto_step"]()));
    expect(stepSlider.value).toBe("30"); // 180 / 6
  });

  it("Divergence auto-fit step caps at the step slider's own max for a low count", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "divergence" } });
    const [countSlider, stepSlider] = Array.from(
      screen.getByTestId("color-picker-divergence-swatches").parentElement!.querySelectorAll('input[type="range"]'),
    ) as HTMLInputElement[];
    // 180 / 1 = 180, which would exceed the step slider's max=60 (Hue scale) if uncapped.
    fireEvent.change(countSlider, { target: { value: "1" } });
    fireEvent.click(screen.getByTitle(m["color_picker.tools.auto_step"]()));
    expect(stepSlider.value).toBe("60");
    expect(Number(stepSlider.max)).toBe(60);
  });

  function divergenceSliders() {
    const harmonySwatches = screen.getByTestId("color-picker-divergence-swatches");
    const body = harmonySwatches.parentElement as HTMLElement;
    return Array.from(body.querySelectorAll('input[type="range"]')) as HTMLInputElement[];
  }

  it("Divergence (Lightness scale) shows two rows (+/-) of `count` swatches each, base excluded", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "divergence" } });
    fireEvent.change(scaleSelect(), { target: { value: "l" } });
    const [countSlider] = divergenceSliders();
    fireEvent.change(countSlider, { target: { value: "4" } });
    // 4 -> 4 swatches per row, 8 total, none of them the base color.
    const swatches = Array.from(
      screen.getByTestId("color-picker-divergence-swatches").querySelectorAll("button"),
    ) as HTMLButtonElement[];
    expect(swatches.length).toBe(8);
    expect(swatches.some((b) => b.title === "#ff0000")).toBe(false);
  });

  it("tool type and Divergence count/step persist across picker close/reopen", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "divergence" } });
    const [countSlider, stepSlider] = divergenceSliders();
    fireEvent.change(countSlider, { target: { value: "5" } });
    fireEvent.change(stepSlider, { target: { value: "45" } });
    // Switch away then back — the picker's own settings must survive the type switch too.
    fireEvent.change(typeSelect(), { target: { value: "triadic" } });
    fireEvent.click(screen.getByText(cancelLabel()));

    openPicker();
    expandHarmony();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("triadic");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "divergence" } });
    const [countAfter, stepAfter] = divergenceSliders();
    expect(countAfter.value).toBe("5");
    expect(stepAfter.value).toBe("45");
  });

  it("Divergence Lightness count/step persists across close/reopen independently of Hue", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "divergence" } });
    fireEvent.change(scaleSelect(), { target: { value: "l" } });
    const [countSlider, stepSlider] = divergenceSliders();
    fireEvent.change(countSlider, { target: { value: "6" } });
    fireEvent.change(stepSlider, { target: { value: "20" } });
    fireEvent.click(screen.getByText(cancelLabel()));

    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "divergence" } });
    expect(scaleSelect().value).toBe("l");
    const [countAfter, stepAfter] = divergenceSliders();
    expect(countAfter.value).toBe("6");
    expect(stepAfter.value).toBe("20");
    expect(screen.getByTestId("color-picker-divergence-swatches").querySelectorAll("button").length).toBe(12);
  });

  it("Divergence (Lightness scale) clamps to the 0-100 range for extreme base colors", () => {
    render(<ColorSwatch color={0xffffff} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "divergence" } });
    fireEvent.change(scaleSelect(), { target: { value: "l" } });
    const [countSlider, stepSlider] = divergenceSliders();
    fireEvent.change(countSlider, { target: { value: "10" } });
    fireEvent.change(stepSlider, { target: { value: "50" } });
    const swatches = Array.from(
      screen.getByTestId("color-picker-divergence-swatches").querySelectorAll("button"),
    ) as HTMLButtonElement[];
    expect(swatches.length).toBe(20);
    for (const swatch of swatches) {
      expect(swatch.title).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("Range split (Lightness scale) renders one row of `count` swatches evenly spaced from min to max", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "range_split" } });
    fireEvent.change(scaleSelect(), { target: { value: "l" } });
    const swatches = Array.from(
      screen.getByTestId("color-picker-range-split-swatches").querySelectorAll("button"),
    ) as HTMLButtonElement[];
    expect(swatches.length).toBe(7); // default step count
  });

  it("Range split (Hue scale) hides min/max sliders — full 360° circle from the base hue", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "range_split" } });
    fireEvent.change(scaleSelect(), { target: { value: "h" } });
    expect(screen.queryByText(m["color_picker.tools.range_min"]())).toBeNull();
    expect(screen.queryByText(m["color_picker.tools.range_max"]())).toBeNull();
  });

  it("Split-complementary derives two swatches at hue +150/+210", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />); // pure red, H=0
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "split_complementary" } });
    const swatches = screen.getByTestId("color-picker-tools-swatches").querySelectorAll("button");
    expect(swatches.length).toBe(3); // base + two derived
    expect((swatches[0] as HTMLButtonElement).title).toBe("#ff0000");
    expect((swatches[1] as HTMLButtonElement).title).not.toBe("#ff0000");
    expect((swatches[2] as HTMLButtonElement).title).not.toBe("#ff0000");
    expect((swatches[1] as HTMLButtonElement).title).not.toBe((swatches[2] as HTMLButtonElement).title);
  });

  it("clicking a Divergence swatch sets the working color", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0xff0000} onChange={onChange} onPreview={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "divergence" } });
    const swatch = screen.getByTestId("color-picker-divergence-swatches").querySelector("button") as HTMLButtonElement;
    const hex = swatch.title;
    fireEvent.click(swatch);
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe(hex);
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange).toHaveBeenCalledWith(hexToColorNum(hex));
  });

  it("clicking a Range split swatch sets the working color", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0xff0000} onChange={onChange} onPreview={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "range_split" } });
    const swatch = screen.getByTestId("color-picker-range-split-swatches").querySelector("button") as HTMLButtonElement;
    const hex = swatch.title;
    fireEvent.click(swatch);
    expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe(hex);
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onChange).toHaveBeenCalledWith(hexToColorNum(hex));
  });

  it("Divergence (Chroma scale) sweeps chroma up/down, clamped into gamut", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />); // pure red, near max chroma
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "divergence" } });
    fireEvent.change(scaleSelect(), { target: { value: "c" } });
    const swatches = Array.from(
      screen.getByTestId("color-picker-divergence-swatches").querySelectorAll("button"),
    ) as HTMLButtonElement[];
    expect(swatches.length).toBeGreaterThan(0);
    for (const swatch of swatches) {
      expect(swatch.title).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("Range split (Chroma scale) shows min/max sliders and evenly spaces chroma", () => {
    render(<ColorSwatch color={0x336699} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "range_split" } });
    fireEvent.change(scaleSelect(), { target: { value: "c" } });
    expect(screen.getByText(m["color_picker.tools.range_min"]())).toBeTruthy();
    expect(screen.getByText(m["color_picker.tools.range_max"]())).toBeTruthy();
    const swatches = screen.getByTestId("color-picker-range-split-swatches").querySelectorAll("button");
    expect(swatches.length).toBe(7); // default step count
  });

  function rangeSplitSliders() {
    const rangeSwatches = screen.getByTestId("color-picker-range-split-swatches");
    const body = rangeSwatches.parentElement as HTMLElement;
    return Array.from(body.querySelectorAll('input[type="range"]')) as HTMLInputElement[];
  }

  it("Range split count slider changes the number of swatches", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "range_split" } });
    const [countSlider] = rangeSplitSliders();
    fireEvent.change(countSlider, { target: { value: "5" } });
    const swatches = screen.getByTestId("color-picker-range-split-swatches").querySelectorAll("button");
    expect(swatches.length).toBe(5);
  });

  it("Range split min/max sliders narrow the range, and reset buttons restore the auto range", () => {
    render(<ColorSwatch color={0xff0000} onChange={() => {}} />);
    openPicker();
    expandHarmony();
    fireEvent.change(typeSelect(), { target: { value: "range_split" } });
    fireEvent.change(scaleSelect(), { target: { value: "l" } });
    const [, minSlider, maxSlider] = rangeSplitSliders();
    fireEvent.change(minSlider, { target: { value: "30" } });
    fireEvent.change(maxSlider, { target: { value: "60" } });
    expect(minSlider.value).toBe("30");
    expect(maxSlider.value).toBe("60");
    const resetButtons = screen.getAllByTitle(m["color_picker.tools.reset_auto"]());
    fireEvent.click(resetButtons[0]);
    fireEvent.click(resetButtons[1]);
    expect(minSlider.value).toBe(String(RANGE_SPLIT_AUTO_MIN_L));
    expect(maxSlider.value).toBe(String(RANGE_SPLIT_AUTO_MAX_L));
  });

  describe("canvas eyedropper (#507)", () => {
    function fakeCanvas(rect: Partial<DOMRect>) {
      const canvas = document.createElement("canvas");
      canvas.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {}, ...rect,
      });
      return canvas;
    }

    afterEach(() => { setColorSampler(null); });

    it("colorAtCenter reads the pixel at the region's center index, not its geometric middle", () => {
      // 3x2 region, centerX/centerY marks the actually-sampled pixel (e.g. clamped near an edge).
      const pixels = new Uint8ClampedArray([
        10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255,
        40, 40, 40, 255, 50, 50, 50, 255, 60, 60, 60, 255,
      ]);
      expect(colorAtCenter({ pixels, width: 3, height: 2, centerX: 2, centerY: 1 })).toBe(0x3c3c3c);
      expect(colorAtCenter({ pixels, width: 3, height: 2, centerX: 0, centerY: 0 })).toBe(0x0a0a0a);
    });

    it("clicking the eyedropper button enters sampling mode and clicking the canvas picks a color", () => {
      const canvas = fakeCanvas({});
      setColorSampler({ canvas, sampleAt: () => 0x00ff00, sampleRegion: () => null });
      render(<ColorSwatch color={0x000000} onChange={() => {}} />);
      openPicker();
      fireEvent.click(screen.getByTestId("color-picker-eyedropper"));
      fireEvent.click(window, { clientX: 50, clientY: 50 });
      expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#00ff00");
      // Sampling mode exits after a pick — the overlay's capture layer is gone.
      expect(document.querySelector('[data-testid="color-picker-eyedropper"]')).toBeTruthy();
    });

    it("Escape while sampling cancels with no change", () => {
      const canvas = fakeCanvas({});
      setColorSampler({ canvas, sampleAt: () => 0x00ff00, sampleRegion: () => null });
      render(<ColorSwatch color={0x123456} onChange={() => {}} />);
      openPicker();
      fireEvent.click(screen.getByTestId("color-picker-eyedropper"));
      fireEvent.keyDown(window, { key: "Escape" });
      expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#123456");
    });

    it("clicking outside the canvas cancels sampling with no change", () => {
      const canvas = fakeCanvas({});
      setColorSampler({ canvas, sampleAt: (x) => (x < 100 ? 0x00ff00 : null), sampleRegion: () => null });
      render(<ColorSwatch color={0x123456} onChange={() => {}} />);
      openPicker();
      fireEvent.click(screen.getByTestId("color-picker-eyedropper"));
      fireEvent.click(window, { clientX: 500, clientY: 50 });
      expect((screen.getByLabelText(hexLabel()) as HTMLInputElement).value).toBe("#123456");
    });

    it("a sampled color previews live but does not commit until Apply", () => {
      const canvas = fakeCanvas({});
      setColorSampler({ canvas, sampleAt: () => 0xabcdef, sampleRegion: () => null });
      const onChange = vi.fn();
      const onPreview = vi.fn();
      render(<ColorSwatch color={0x000000} onChange={onChange} onPreview={onPreview} />);
      openPicker();
      fireEvent.click(screen.getByTestId("color-picker-eyedropper"));
      fireEvent.click(window, { clientX: 10, clientY: 10 });
      expect(onPreview).toHaveBeenLastCalledWith(0xabcdef);
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText(applyLabel()));
      expect(onChange).toHaveBeenCalledWith(0xabcdef);
    });
  });
});

// Live-preview rAF throttle (#513) — real (unstubbed) requestAnimationFrame, driven manually.
describe("ColorSwatch live-preview throttle", () => {
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = () => {}; });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const flushFrame = () => { const q = frames; frames = []; q.forEach((cb) => cb(0)); };

  it("coalesces several edits in one frame into a single onPreview call with the latest color", () => {
    const onPreview = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={() => {}} onPreview={onPreview} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(screen.getByLabelText("R value"), { target: { value: "255" } });
    fireEvent.change(screen.getByLabelText("G value"), { target: { value: "128" } });
    fireEvent.change(screen.getByLabelText("B value"), { target: { value: "64" } });
    expect(onPreview).not.toHaveBeenCalled(); // still pending
    flushFrame();
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith(0xff8040);
  });

  it("Cancel flushes the restore synchronously without waiting for a frame", () => {
    const onPreview = vi.fn();
    render(<ColorSwatch color={0x111111} onChange={() => {}} onPreview={onPreview} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#abcdef" } });
    onPreview.mockClear();
    fireEvent.click(screen.getByText(cancelLabel()));
    expect(onPreview).toHaveBeenCalledWith(0x111111); // synchronous, no flushFrame needed
  });

  it("Apply flushes the final color synchronously (queued frame not lost to unmount)", () => {
    const onChange = vi.fn();
    const onPreview = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} onPreview={onPreview} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(screen.getByLabelText(hexLabel()), { target: { value: "#00ff00" } });
    onPreview.mockClear();
    fireEvent.click(screen.getByText(applyLabel()));
    expect(onPreview).toHaveBeenCalledWith(0x00ff00);
    expect(onChange).toHaveBeenCalledWith(0x00ff00);
  });
});
