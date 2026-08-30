import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NumberInput } from "../components/NumberInput";

// NumberInput reports the value to commit upward and expects the committed value to flow back in
// via the `value` prop -- this wrapper stands in for that round-trip (same pattern as
// StatefulParamFields).
function Stateful({ initial, min, max, integer, onCommit }: {
  initial: string;
  min?: number;
  max?: number;
  integer?: boolean;
  onCommit?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <NumberInput
      value={value}
      min={min}
      max={max}
      integer={integer}
      onChange={(v) => { setValue(v); onCommit?.(v); }}
    />
  );
}

describe("NumberInput", () => {
  it("renders the initial value", () => {
    render(<NumberInput value="7" onChange={vi.fn()} />);
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("7");
  });

  it("commits every keystroke while the value is valid", () => {
    const onCommit = vi.fn();
    render(<Stateful initial="7" onCommit={onCommit} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "12" } });
    expect(onCommit).toHaveBeenCalledWith("12");
  });

  describe("empty field (GitHub issue #452)", () => {
    it("commits the last valid value, not the empty string, while the field is empty", () => {
      const onCommit = vi.fn();
      render(<Stateful initial="42" onCommit={onCommit} />);
      fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
      expect(onCommit).toHaveBeenLastCalledWith("42");
      expect(onCommit).not.toHaveBeenCalledWith("");
    });

    it("keeps the field visually empty while the user is mid-edit", () => {
      render(<Stateful initial="42" />);
      const input = screen.getByRole("spinbutton") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "" } });
      expect(input.value).toBe("");
    });

    it("restores the last valid value into the field on blur", () => {
      const onCommit = vi.fn();
      render(<Stateful initial="42" onCommit={onCommit} />);
      const input = screen.getByRole("spinbutton") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);
      expect(input.value).toBe("42");
      expect(onCommit).toHaveBeenLastCalledWith("42");
    });

    it("tracks the most recent valid value, not just the initial one", () => {
      const onCommit = vi.fn();
      render(<Stateful initial="42" onCommit={onCommit} />);
      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "9" } });
      fireEvent.change(input, { target: { value: "" } });
      expect(onCommit).toHaveBeenLastCalledWith("9");
    });

    it("commits the last valid value (not the raw junk) for a non-empty unparseable keystroke", () => {
      const onCommit = vi.fn();
      render(<Stateful initial="42" onCommit={onCommit} />);
      const input = screen.getByRole("spinbutton") as HTMLInputElement;
      // A number field lets "-" and "1e" sit in it mid-edit. Downstream must never see them --
      // core would parse them as the (large) default and fire a false analytics error (#452).
      fireEvent.change(input, { target: { value: "-" } });
      expect(onCommit).toHaveBeenLastCalledWith("42");
      expect(onCommit).not.toHaveBeenCalledWith("-");
    });

    it("restores the last valid value on blur when an unparseable string is still in the field", () => {
      const onCommit = vi.fn();
      render(<Stateful initial="42" onCommit={onCommit} />);
      const input = screen.getByRole("spinbutton") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "1e" } });
      fireEvent.blur(input);
      expect(input.value).toBe("42");
      expect(onCommit).toHaveBeenLastCalledWith("42");
    });
  });

  describe("blur normalization", () => {
    it("rounds a fractional value on an integer field", () => {
      const onCommit = vi.fn();
      render(<Stateful initial="5" integer onCommit={onCommit} />);
      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "7.6" } });
      fireEvent.blur(input);
      expect(onCommit).toHaveBeenLastCalledWith("8");
    });

    it("does not round a float field", () => {
      const onCommit = vi.fn();
      render(<Stateful initial="5" min={0} max={100} onCommit={onCommit} />);
      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "7.6" } });
      fireEvent.blur(input);
      expect(onCommit).toHaveBeenLastCalledWith("7.6");
    });

    it("clamps above max on blur", () => {
      const onCommit = vi.fn();
      render(<Stateful initial="5" min={0} max={100} onCommit={onCommit} />);
      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "500" } });
      fireEvent.blur(input);
      expect(onCommit).toHaveBeenLastCalledWith("100");
    });

    it("clamps below min on blur", () => {
      const onCommit = vi.fn();
      render(<Stateful initial="5" min={0} max={100} onCommit={onCommit} />);
      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "-20" } });
      fireEvent.blur(input);
      expect(onCommit).toHaveBeenLastCalledWith("0");
    });
  });

  describe("decimal separator guard on integer fields", () => {
    it("blocks typing a decimal point", () => {
      render(<NumberInput value="5" integer onChange={vi.fn()} />);
      const input = screen.getByRole("spinbutton");
      const event = new KeyboardEvent("keydown", { key: ".", bubbles: true, cancelable: true });
      expect(input.dispatchEvent(event)).toBe(false);
    });

    it("blocks pasting text with a decimal separator", () => {
      render(<NumberInput value="5" integer onChange={vi.fn()} />);
      const input = screen.getByRole("spinbutton");
      const event = new Event("paste", { bubbles: true, cancelable: true }) as unknown as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", { value: { getData: () => "7.5" } });
      expect(input.dispatchEvent(event)).toBe(false);
    });

    it("allows a decimal point on a float field", () => {
      render(<NumberInput value="5" onChange={vi.fn()} />);
      const input = screen.getByRole("spinbutton");
      const event = new KeyboardEvent("keydown", { key: ".", bubbles: true, cancelable: true });
      expect(input.dispatchEvent(event)).toBe(true);
    });
  });

  describe("onBlurCommit", () => {
    it("fires on blur with the normalized value", () => {
      const onBlurCommit = vi.fn();
      render(
        <NumberInput value="5" min={0} max={100} integer onChange={vi.fn()} onBlurCommit={onBlurCommit} />
      );
      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "7.6" } });
      fireEvent.blur(input);
      expect(onBlurCommit).toHaveBeenCalledWith("8");
    });

    it("fires with the restored last valid value when the field was emptied", () => {
      const onBlurCommit = vi.fn();
      function Wrap() {
        const [value, setValue] = useState("42");
        return <NumberInput value={value} onChange={setValue} onBlurCommit={onBlurCommit} />;
      }
      render(<Wrap />);
      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);
      expect(onBlurCommit).toHaveBeenCalledWith("42");
    });
  });

  it("mirrors an external value change into the field when not focused", () => {
    const { rerender } = render(<NumberInput value="1" onChange={vi.fn()} />);
    rerender(<NumberInput value="99" onChange={vi.fn()} />);
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("99");
  });

  it("does not let an external value change overwrite the field mid-edit", () => {
    const { rerender } = render(<NumberInput value="1" onChange={vi.fn()} />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "23" } });
    rerender(<NumberInput value="7" onChange={vi.fn()} />);
    expect(input.value).toBe("23");
  });
});
