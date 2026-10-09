import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LinkEditor } from "../components/features/ParameterLinksDialog";
import type { ColorModifier, ParamDescriptor, ParamLink, ParamModifier } from "../store/parameterLinks";

type P = "a" | "b" | "c";

const registry: Record<P, ParamDescriptor> = {
  a: { type: "number", equals: Object.is, label: "Alpha", group: [], format: String },
  b: { type: "number", equals: Object.is, label: "Beta", group: [], format: String },
  c: { type: "number", equals: Object.is, label: "Gamma", group: [], format: String },
};

const existing: ParamLink<P>[] = [{ id: "l1", source: "a", target: "b", enabled: true }];

function renderEditor(initialSource: P | null, initialTarget: P | null, links: ParamLink<P>[], initialModifiers?: ParamModifier[]) {
  const onSave = vi.fn();
  render(
    <LinkEditor<P>
      registry={registry}
      activePaths={new Set<P>(["a", "b", "c"])}
      existingLinks={links}
      initialSource={initialSource}
      initialTarget={initialTarget}
      initialModifiers={initialModifiers}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  );
  return onSave;
}

// GitHub issue #721 — Source candidates that would close a cycle stay listed but disabled.
describe("LinkEditor cycle filtering", () => {
  it("lists a cyclic source as disabled with an explanatory tooltip, and ignores clicks on it", () => {
    // a -> b exists; target "a" with source b would give b -> a (cycle), c is fine.
    const onSave = renderEditor(null, "a", existing);
    const disabledRow = document.querySelector('[aria-disabled="true"]') as HTMLElement;
    expect(disabledRow.textContent).toBe("Beta");
    expect(disabledRow.title).toMatch(/cyclic/i);
    fireEvent.click(disabledRow);
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[aria-disabled="true"]')).toHaveLength(1);
  });

  it("drops an already-picked source when a new target makes it cyclic", () => {
    const onSave = renderEditor("b", "c", existing);
    fireEvent.click(screen.getAllByText("Alpha")[0]);
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });
});

// GitHub issue #720 — saving onto a target that already has a control link asks for confirmation
// (naming the source it currently depends on) before the engine's `addLink` silently replaces it.
describe("LinkEditor replace confirmation", () => {
  it("asks for confirmation and does not save until confirmed when the target already has a link", () => {
    const onSave = renderEditor("c", "b", existing);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/already depends on "Alpha"/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(onSave).toHaveBeenCalledWith("c", "b", undefined, undefined);
  });

  it("names the existing link's modifiers in the confirmation", () => {
    const withMods: ParamLink<P>[] = [{ id: "l1", source: "a", target: "b", enabled: true, modifiers: [{ op: "mul", value: 2 }] }];
    renderEditor("c", "b", withMods);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/already depends on "Alpha" × 2/)).toBeTruthy();
  });

  it("saves without confirmation when source and modifiers match the existing link", () => {
    const withMods: ParamLink<P>[] = [{ id: "l1", source: "a", target: "b", enabled: true, modifiers: [{ op: "mul", value: 2 }] }];
    const onSave = renderEditor("a", "b", withMods, [{ op: "mul", value: 2 }]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByText(/already depends on/)).toBeNull();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("asks for confirmation when only the modifiers differ", () => {
    const onSave = renderEditor("a", "b", existing, [{ op: "add", value: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/already depends on "Alpha"/)).toBeTruthy();
  });

  it("returns to the editor without saving when the confirmation is cancelled", () => {
    const onSave = renderEditor("c", "b", existing);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const cancels = screen.getAllByRole("button", { name: "Cancel" });
    fireEvent.click(cancels[cancels.length - 1]);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByText(/already depends on/)).toBeNull();
  });

  it("saves immediately when the target has no existing link", () => {
    const onSave = renderEditor("a", "c", existing);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByText(/already depends on/)).toBeNull();
    expect(onSave).toHaveBeenCalledWith("a", "c", undefined, undefined);
  });

  it("compares color chains too: identical saves silently, different asks", () => {
    const colorRegistry: Record<P, ParamDescriptor> = {
      a: { type: "color", equals: Object.is, label: "Alpha", group: [], format: String },
      b: { type: "color", equals: Object.is, label: "Beta", group: [], format: String },
      c: { type: "color", equals: Object.is, label: "Gamma", group: [], format: String },
    };
    const chain: ColorModifier[] = [{ model: "hsl", channel: "l", op: "add", value: 10 }];
    const links: ParamLink<P>[] = [{ id: "l1", source: "a", target: "b", enabled: true, colorModifiers: chain }];
    const renderColor = (initialColorModifiers: ColorModifier[]) => {
      const onSave = vi.fn();
      render(
        <LinkEditor<P>
          registry={colorRegistry}
          activePaths={new Set<P>(["a", "b", "c"])}
          existingLinks={links}
          initialSource="a"
          initialTarget="b"
          initialColorModifiers={initialColorModifiers}
          onSave={onSave}
          onClose={vi.fn()}
        />,
      );
      return onSave;
    };

    const same = renderColor([{ ...chain[0] }]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(same).toHaveBeenCalledTimes(1);
    cleanup();

    const different = renderColor([{ ...chain[0], value: 20 }]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(different).not.toHaveBeenCalled();
    expect(screen.getByText(/already depends on "Alpha"/)).toBeTruthy();
  });
});
