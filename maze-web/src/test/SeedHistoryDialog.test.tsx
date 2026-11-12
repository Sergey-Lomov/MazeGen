import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SeedHistoryDialog } from "../components/dialogs/SeedHistoryDialog";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";

const selectedRows = () => screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true").map((o) => o.textContent);

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  useMazeStore.setState({ seedHistory: [10, 20, 30], seedHistoryIndex: 1, seed: 20 });
});

describe("SeedHistoryDialog", () => {
  it("lists the seeds newest first", () => {
    render(<SeedHistoryDialog onClose={vi.fn()} />);

    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["30", "20", "10"]);
  });

  it("highlights the history entry the seed field shows", () => {
    render(<SeedHistoryDialog onClose={vi.fn()} />);

    expect(selectedRows()).toEqual(["20"]);
  });

  it("highlights nothing when the seed in the field is not in the history", () => {
    useMazeStore.setState({ seed: 99 });
    render(<SeedHistoryDialog onClose={vi.fn()} />);

    expect(selectedRows()).toEqual([]);
  });

  it("highlights the entry matching the field even when it is not the current index", () => {
    useMazeStore.setState({ seed: 30 });
    render(<SeedHistoryDialog onClose={vi.fn()} />);

    expect(selectedRows()).toEqual(["30"]);
  });

  it("keeps the hover highlight on the selected row too", () => {
    render(<SeedHistoryDialog onClose={vi.fn()} />);

    expect(screen.getByRole("option", { name: "20" }).className).toBe("hoverable-tint");
    expect(screen.getByRole("option", { name: "30" }).className).toBe("hoverable");
  });

  it("focuses the list, moves the highlight with the arrows and jumps to it on Enter", () => {
    const onClose = vi.fn();
    render(<SeedHistoryDialog onClose={onClose} />);
    expect(document.activeElement).toBe(screen.getByRole("listbox"));

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(selectedRows()).toEqual(["10"]);
    expect(useMazeStore.getState().seed).toBe(20);

    fireEvent.keyDown(window, { key: "Enter" });
    expect(useMazeStore.getState().seed).toBe(10);
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores Enter until the arrows picked a row", () => {
    const onClose = vi.fn();
    render(<SeedHistoryDialog onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("jumps to the clicked seed and closes", () => {
    const onClose = vi.fn();
    render(<SeedHistoryDialog onClose={onClose} />);

    fireEvent.click(screen.getByRole("option", { name: "10" }));
    expect(useMazeStore.getState().seed).toBe(10);
    expect(useMazeStore.getState().seedHistoryIndex).toBe(0);
    expect(onClose).toHaveBeenCalled();
  });
});
