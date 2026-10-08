import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TextInput } from "../components/TextInput";

function Controlled({ initial, normalize, isValid, onChange }: {
  initial: string;
  normalize?: (raw: string) => string;
  isValid?: (raw: string) => boolean;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <TextInput
      aria-label="field"
      value={value}
      onChange={(v) => { setValue(v); onChange?.(v); }}
      normalize={normalize}
      isValid={isValid}
    />
  );
}

describe("TextInput", () => {
  it("commits every keystroke when isValid is unset (any text is valid)", () => {
    const onChange = vi.fn();
    render(<Controlled initial="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("field"), { target: { value: "hello" } });
    expect(onChange).toHaveBeenLastCalledWith("hello");
    expect(screen.getByLabelText("field")).toHaveValue("hello");
  });

  it("shows an invalid draft on screen but never commits it", () => {
    const onChange = vi.fn();
    render(<Controlled initial="A" isValid={(raw) => raw === "" || raw === "A" || raw === "B"} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("field"), { target: { value: "Z" } });
    expect(screen.getByLabelText("field")).toHaveValue("Z");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits once the draft becomes valid again", () => {
    const onChange = vi.fn();
    render(<Controlled initial="A" isValid={(raw) => raw === "" || raw === "A" || raw === "B"} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("field"), { target: { value: "Z" } });
    fireEvent.change(screen.getByLabelText("field"), { target: { value: "B" } });
    expect(onChange).toHaveBeenLastCalledWith("B");
  });

  it("applies normalize silently before the invalid-check (no flash of the raw draft)", () => {
    const onChange = vi.fn();
    render(<Controlled initial="" normalize={(raw) => raw.toUpperCase()} isValid={(raw) => raw.length <= 1} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("field"), { target: { value: "a" } });
    expect(screen.getByLabelText("field")).toHaveValue("A");
    expect(onChange).toHaveBeenLastCalledWith("A");
  });

  it("restores the last valid value on blur when left invalid", () => {
    render(<Controlled initial="A" isValid={(raw) => raw === "" || raw === "A" || raw === "B"} />);
    const input = screen.getByLabelText("field");
    fireEvent.change(input, { target: { value: "Z" } });
    expect(input).toHaveValue("Z");
    fireEvent.blur(input);
    expect(input).toHaveValue("A");
  });

  it("Enter blurs the field", () => {
    render(<Controlled initial="A" isValid={(raw) => raw === "" || raw === "A" || raw === "B"} />);
    const input = screen.getByLabelText("field");
    input.focus();
    fireEvent.change(input, { target: { value: "Z" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("A");
  });
});
