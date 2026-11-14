import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ListCell, ListCellAction } from "../components/ListCell";
import { IdBubble } from "../components/Bubble";
import { ui } from "../styles/theme";

describe("ListCell", () => {
  it("renders the title row, details and actions", () => {
    render(
      <ListCell
        title="Teleport"
        badge={<IdBubble id="t1" />}
        details={<span>1:1</span>}
        actions={<ListCellAction title="Delete" onAction={vi.fn()}>x</ListCellAction>}
      >
        <span>body</span>
      </ListCell>,
    );

    expect(screen.getByText("Teleport")).toBeTruthy();
    expect(screen.getByText("id: t1")).toBeTruthy();
    expect(screen.getByText("1:1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("keeps the actions in the details row by default and in the title row on request", () => {
    const { container, rerender } = render(
      <ListCell title="Glue" details={<span>details</span>} actions={<ListCellAction title="Act" onAction={vi.fn()}>x</ListCellAction>} />,
    );
    const rowOf = (text: string) => screen.getByText(text).closest("div")!;
    expect(rowOf("details").contains(screen.getByRole("button", { name: "Act" }))).toBe(true);
    expect(rowOf("Glue").contains(screen.getByRole("button", { name: "Act" }))).toBe(false);

    rerender(
      <ListCell title="Glue" actionsPlacement="title" actions={<ListCellAction title="Act" onAction={vi.fn()}>x</ListCellAction>} />,
    );
    expect(rowOf("Glue").contains(screen.getByRole("button", { name: "Act" }))).toBe(true);
    expect(container.children).toHaveLength(1);
  });

  it("draws no title row for a cell that is only a details row", () => {
    const { container } = render(<ListCell details={<span>only</span>} />);

    expect(container.querySelectorAll("div")).toHaveLength(2);
  });

  it("passes cell handlers and attributes through and merges style last", () => {
    const onMouseEnter = vi.fn();
    render(<ListCell title="Row" data-testid="cell" onMouseEnter={onMouseEnter} style={{ cursor: "pointer" }} />);

    const cell = screen.getByTestId("cell");
    fireEvent.mouseEnter(cell);
    expect(onMouseEnter).toHaveBeenCalledTimes(1);
    expect(cell.style.cursor).toBe("pointer");
  });

  it("truncates a long title only when asked", () => {
    render(
      <>
        <ListCell title="wrapping" />
        <ListCell title="truncated" truncateTitle />
      </>,
    );

    expect(screen.getByText("wrapping").style.textOverflow).toBe("");
    expect(screen.getByText("truncated").style.textOverflow).toBe("ellipsis");
  });
});

describe("ListCellAction", () => {
  it("runs the action on click and names the button by its title", () => {
    const onAction = vi.fn();
    render(<ListCellAction title="Reset" onAction={onAction}>x</ListCellAction>);

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("does not click the cell it sits in", () => {
    const onCellClick = vi.fn();
    const onAction = vi.fn();
    render(<ListCell onClick={onCellClick} actions={<ListCellAction title="Delete" onAction={onAction}>x</ListCellAction>} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onCellClick).not.toHaveBeenCalled();
  });

  it("is a toggle for assistive technology only when it is given a selected flag", () => {
    render(
      <>
        <ListCellAction title="On" selected onAction={vi.fn()}>x</ListCellAction>
        <ListCellAction title="Off" selected={false} onAction={vi.fn()}>x</ListCellAction>
        <ListCellAction title="Plain" onAction={vi.fn()}>x</ListCellAction>
      </>,
    );

    expect(screen.getByRole("button", { name: "On" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Off" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Plain" }).hasAttribute("aria-pressed")).toBe(false);
    expect(screen.getByRole("button", { name: "On" })).toHaveStyle({ background: ui.state.selected, color: ui.text.primary });
  });

  it("ignores a click while disabled", () => {
    const onAction = vi.fn();
    render(<ListCellAction title="Edit" disabled onAction={onAction}>x</ListCellAction>);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onAction).not.toHaveBeenCalled();
  });

  describe("activateOnPress (GitHub issue #679)", () => {
    it("runs the action on pointer down and not again on the click that follows it", () => {
      const onAction = vi.fn();
      render(<ListCellAction title="Delete" activateOnPress onAction={onAction}>x</ListCellAction>);
      const button = screen.getByRole("button", { name: "Delete" });

      fireEvent.pointerDown(button);
      fireEvent.click(button, { detail: 1 });
      expect(onAction).toHaveBeenCalledTimes(1);
    });

    it("keeps keyboard activation on click", () => {
      const onAction = vi.fn();
      render(<ListCellAction title="Delete" activateOnPress onAction={onAction}>x</ListCellAction>);

      fireEvent.click(screen.getByRole("button", { name: "Delete" }), { detail: 0 });
      expect(onAction).toHaveBeenCalledTimes(1);
    });

    it("keeps the press away from the cell and its parents", () => {
      const onParentPointerDown = vi.fn();
      render(
        <div onPointerDown={onParentPointerDown}>
          <ListCellAction title="Delete" activateOnPress onAction={vi.fn()}>x</ListCellAction>
        </div>,
      );

      fireEvent.pointerDown(screen.getByRole("button", { name: "Delete" }));
      expect(onParentPointerDown).not.toHaveBeenCalled();
    });

    it("does not run on pointer down without the flag", () => {
      const onAction = vi.fn();
      render(<ListCellAction title="Delete" onAction={onAction}>x</ListCellAction>);

      fireEvent.pointerDown(screen.getByRole("button", { name: "Delete" }));
      expect(onAction).not.toHaveBeenCalled();
    });
  });
});
