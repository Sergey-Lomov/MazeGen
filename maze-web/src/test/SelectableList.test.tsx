import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SelectableList, SelectableRow, type SelectableAppearance } from "../components/SelectableList";

const ALL = ["a", "b", "c"];

function Harness({ initial = null, values = ALL, walkable = true, disabled = [], onSelect, appearance, footer, autoFocus }: {
  initial?: string | null;
  values?: string[];
  /** `false` leaves `values` out, like a pick-and-close list. */
  walkable?: boolean;
  disabled?: string[];
  onSelect?: (value: string, source: string) => void;
  appearance?: SelectableAppearance;
  footer?: React.ReactNode;
  autoFocus?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(initial);
  return (
    <SelectableList
      selected={selected}
      values={walkable ? values : undefined}
      appearance={appearance}
      footer={footer}
      autoFocus={autoFocus}
      onSelect={(value, source) => { setSelected(value); onSelect?.(value, source); }}
    >
      {ALL.map((value) => (
        <SelectableRow key={value} value={value} selected={value === selected} disabled={disabled.includes(value)}>{value.toUpperCase()}</SelectableRow>
      ))}
    </SelectableList>
  );
}

const selectedName = () => screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")?.textContent;

describe("SelectableList", () => {
  it("renders a listbox of options and marks the selected one", () => {
    render(<Harness initial="b" />);

    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["A", "B", "C"]);
    expect(selectedName()).toBe("B");
  });

  it("selects a clicked row and reports a pointer selection", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("option", { name: "C" }));
    expect(onSelect).toHaveBeenCalledWith("c", "pointer");
    expect(selectedName()).toBe("C");
  });

  it("ignores a click on a disabled row and marks it aria-disabled", () => {
    const onSelect = vi.fn();
    render(<Harness disabled={["b"]} onSelect={onSelect} />);

    const row = screen.getByRole("option", { name: "B" });
    fireEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("option", { name: "A" }).hasAttribute("aria-disabled")).toBe(false);
  });

  describe("arrow keys", () => {
    it("land on the first value with Down and the last with Up when nothing is selected", () => {
      const { unmount } = render(<Harness />);
      fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
      expect(selectedName()).toBe("A");
      unmount();

      render(<Harness />);
      fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowUp" });
      expect(selectedName()).toBe("C");
    });

    it("move one step and stop at both ends", () => {
      render(<Harness initial="b" />);
      const list = screen.getByRole("listbox");

      fireEvent.keyDown(list, { key: "ArrowDown" });
      expect(selectedName()).toBe("C");
      fireEvent.keyDown(list, { key: "ArrowDown" });
      expect(selectedName()).toBe("C");
      fireEvent.keyDown(list, { key: "ArrowUp" });
      fireEvent.keyDown(list, { key: "ArrowUp" });
      fireEvent.keyDown(list, { key: "ArrowUp" });
      expect(selectedName()).toBe("A");
    });

    it("report a keyboard selection and prevent the default scroll", () => {
      const onSelect = vi.fn();
      render(<Harness initial="a" onSelect={onSelect} />);

      const notPrevented = fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
      expect(onSelect).toHaveBeenCalledWith("b", "keyboard");
      expect(notPrevented).toBe(false);
    });

    it("walk only the given values, skipping a disabled row", () => {
      render(<Harness initial="a" values={["a", "c"]} disabled={["b"]} />);

      fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
      expect(selectedName()).toBe("C");
    });

    it("do nothing, and keep their default, without values", () => {
      const onSelect = vi.fn();
      render(<Harness initial="a" walkable={false} onSelect={onSelect} />);

      const notPrevented = fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
      expect(onSelect).not.toHaveBeenCalled();
      expect(notPrevented).toBe(true);
    });

    it("ignore other keys", () => {
      const onSelect = vi.fn();
      render(<Harness initial="a" onSelect={onSelect} />);

      fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  it("points aria-activedescendant at the selected option and clears it without a selection", () => {
    const { unmount } = render(<Harness initial="b" />);
    const list = screen.getByRole("listbox");
    expect(document.getElementById(list.getAttribute("aria-activedescendant")!)?.textContent).toBe("B");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(document.getElementById(list.getAttribute("aria-activedescendant")!)?.textContent).toBe("C");
    unmount();

    render(<Harness />);
    expect(screen.getByRole("listbox").hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("gives a row whose value has spaces an id usable as an active descendant", () => {
    render(
      <SelectableList selected="Comic Sans MS" values={["Comic Sans MS"]} onSelect={vi.fn()}>
        <SelectableRow value="Comic Sans MS" selected>Comic Sans MS</SelectableRow>
      </SelectableList>,
    );

    const id = screen.getByRole("listbox").getAttribute("aria-activedescendant")!;
    expect(id).not.toMatch(/\s/);
    expect(document.getElementById(id)?.textContent).toBe("Comic Sans MS");
  });

  it("scrolls the selected row into view when the selection moves, not on a re-render with new values", () => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const { rerender } = render(<Harness initial="a" values={["a", "b", "c"]} />);
      expect(scroll).toHaveBeenCalledTimes(1);

      // Same length, new array identity: callers rebuild `values` every render.
      rerender(<Harness initial="a" values={["a", "b", "c"]} />);
      expect(scroll).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
      expect(scroll).toHaveBeenCalledTimes(2);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("takes focus on mount only when asked", () => {
    const { unmount } = render(<Harness autoFocus />);
    expect(document.activeElement).toBe(screen.getByRole("listbox"));
    unmount();

    render(<Harness />);
    expect(document.activeElement).not.toBe(screen.getByRole("listbox"));
  });

  it("renders the footer inside the list but not as an option", () => {
    render(<Harness footer={<span>note</span>} />);

    expect(screen.getByRole("listbox").contains(screen.getByText("note"))).toBe(true);
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("keeps the same behavior for the dialog appearance", () => {
    const onSelect = vi.fn();
    render(<Harness appearance="dialog" initial="a" onSelect={onSelect} />);

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(selectedName()).toBe("B");
    fireEvent.click(screen.getByRole("option", { name: "C" }));
    expect(onSelect).toHaveBeenLastCalledWith("c", "pointer");
  });

  it("indents a dialog row under a section and tightens it when compact", () => {
    render(
      <SelectableList appearance="dialog" compact selected="a" onSelect={vi.fn()}>
        <SelectableRow value="a" selected>flat</SelectableRow>
        <SelectableRow value="b" selected={false} indented>nested</SelectableRow>
      </SelectableList>,
    );

    const padding = (name: string) => screen.getByRole("option", { name }).style.paddingLeft;
    expect(parseInt(padding("nested"))).toBeGreaterThan(parseInt(padding("flat")));
    expect(screen.getByRole("option", { name: "flat" }).style.paddingTop).toBe("3px");
  });

  it("shows a row's trailing content after its label", () => {
    render(
      <SelectableList appearance="dialog" selected={null} onSelect={vi.fn()}>
        <SelectableRow value="a" selected={false} trailing={<i data-testid="warn" />}>label</SelectableRow>
      </SelectableList>,
    );

    expect(screen.getByRole("option").contains(screen.getByTestId("warn"))).toBe(true);
  });

  it("fails loudly for a row outside a list", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => render(<SelectableRow value="a" selected={false}>x</SelectableRow>)).toThrow(/SelectableList/);
    error.mockRestore();
  });
});
