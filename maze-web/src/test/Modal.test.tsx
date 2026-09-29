import { render, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "../components/Modal";

describe("Modal Escape-to-close", () => {
  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<Modal title="Dialog" onClose={onClose}>content</Modal>);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes only the topmost modal when several are stacked", () => {
    const onCloseFirst = vi.fn();
    const onCloseSecond = vi.fn();
    render(
      <>
        <Modal title="First" onClose={onCloseFirst}>first</Modal>
        <Modal title="Second" onClose={onCloseSecond}>second</Modal>
      </>,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onCloseSecond).toHaveBeenCalledTimes(1);
    expect(onCloseFirst).not.toHaveBeenCalled();
  });
});

// GitHub issue #638: Enter/Space confirm a dialog that has a confirmation action.
describe("Modal Enter/Space confirmation shortcut", () => {
  it("does nothing on Enter/Space when onConfirm is omitted", () => {
    const onClose = vi.fn();
    render(<Modal title="Info" onClose={onClose}>content</Modal>);

    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: " " });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("confirms on Enter", () => {
    const onConfirm = vi.fn();
    render(<Modal title="Dialog" onClose={vi.fn()} onConfirm={onConfirm}>content</Modal>);

    fireEvent.keyDown(window, { key: "Enter" });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("confirms on Space", () => {
    const onConfirm = vi.fn();
    render(<Modal title="Dialog" onClose={vi.fn()} onConfirm={onConfirm}>content</Modal>);

    fireEvent.keyDown(window, { key: " " });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("confirms on Enter/Space even while a button inside the dialog holds focus (GitHub issue #638 follow-up)", () => {
    const onConfirm = vi.fn();
    const onRowPick = vi.fn();
    render(
      <Modal title="Dialog" onClose={vi.fn()} onConfirm={onConfirm}>
        <button onClick={onRowPick}>Row</button>
      </Modal>,
    );

    const row = screen.getByText("Row");
    row.focus();
    fireEvent.keyDown(row, { key: " " });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    // The focused button's own native Space-activation must not also fire.
    expect(onRowPick).not.toHaveBeenCalled();
  });

  it("only the topmost modal's onConfirm fires when several are stacked", () => {
    const onConfirmFirst = vi.fn();
    const onConfirmSecond = vi.fn();
    render(
      <>
        <Modal title="First" onClose={vi.fn()} onConfirm={onConfirmFirst}>first</Modal>
        <Modal title="Second" onClose={vi.fn()} onConfirm={onConfirmSecond}>second</Modal>
      </>,
    );

    fireEvent.keyDown(window, { key: "Enter" });

    expect(onConfirmSecond).toHaveBeenCalledTimes(1);
    expect(onConfirmFirst).not.toHaveBeenCalled();
  });

  it("lets Space type a literal space in a text input instead of confirming", () => {
    const onConfirm = vi.fn();
    render(
      <Modal title="Dialog" onClose={vi.fn()} onConfirm={onConfirm}>
        <input type="text" />
      </Modal>,
    );

    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: " " });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("still confirms on Enter inside a single-line text input", () => {
    const onConfirm = vi.fn();
    render(
      <Modal title="Dialog" onClose={vi.fn()} onConfirm={onConfirm}>
        <input type="text" />
      </Modal>,
    );

    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("lets Enter insert a newline in a textarea instead of confirming", () => {
    const onConfirm = vi.fn();
    render(
      <Modal title="Dialog" onClose={vi.fn()} onConfirm={onConfirm}>
        <textarea />
      </Modal>,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: " " });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms on Space over a non-text input like a range slider", () => {
    const onConfirm = vi.fn();
    render(
      <Modal title="Dialog" onClose={vi.fn()} onConfirm={onConfirm}>
        <input type="range" />
      </Modal>,
    );

    const slider = screen.getByRole("slider");
    fireEvent.keyDown(slider, { key: " " });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
