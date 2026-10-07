import { describe, it, expect } from "vitest";
import { allLeavesInactive, type PickerNode } from "../components/features/ParameterLinksDialog";

type P = "a" | "b" | "c";

function leaf(path: P): PickerNode<P> {
  return { kind: "leaf", path, label: path };
}

function group(groupKey: string, children: PickerNode<P>[]): PickerNode<P> {
  return { kind: "group", label: groupKey, groupKey, children };
}

describe("allLeavesInactive", () => {
  it("is false for an active leaf", () => {
    expect(allLeavesInactive(leaf("a"), new Set<P>(["a"]))).toBe(false);
  });

  it("is true for an inactive leaf", () => {
    expect(allLeavesInactive(leaf("a"), new Set<P>())).toBe(true);
  });

  it("is false for a group with at least one active descendant", () => {
    const node = group("g", [leaf("a"), leaf("b")]);
    expect(allLeavesInactive(node, new Set<P>(["b"]))).toBe(false);
  });

  it("is true for a group whose every leaf is inactive", () => {
    const node = group("g", [leaf("a"), leaf("b")]);
    expect(allLeavesInactive(node, new Set<P>(["c"]))).toBe(true);
  });

  it("is true for a nested group whose every descendant leaf is inactive", () => {
    const node = group("g", [group("g/sub", [leaf("a"), leaf("b")])]);
    expect(allLeavesInactive(node, new Set<P>())).toBe(true);
  });

  it("is false for a nested group with one active descendant leaf, deep down", () => {
    const node = group("g", [group("g/sub", [leaf("a"), leaf("b")])]);
    expect(allLeavesInactive(node, new Set<P>(["b"]))).toBe(false);
  });

  it("is false for a group with no children at all", () => {
    expect(allLeavesInactive(group("empty", []), new Set<P>())).toBe(false);
  });
});
