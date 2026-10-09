import { describe, it, expect } from "vitest";
import { allLeavesDisabled, allLeavesInactive, type PickerNode } from "../components/features/ParameterLinksDialog";

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

// GitHub issue #721 — group rows dim like their leaves once every descendant is unpickable.
describe("allLeavesDisabled", () => {
  it("is false when no disabled set is given", () => {
    expect(allLeavesDisabled(leaf("a"), undefined)).toBe(false);
  });

  it("matches a leaf by membership", () => {
    expect(allLeavesDisabled(leaf("a"), new Set<P>(["a"]))).toBe(true);
    expect(allLeavesDisabled(leaf("a"), new Set<P>(["b"]))).toBe(false);
  });

  it("is true for a nested group only when every descendant leaf is disabled", () => {
    const node = group("g", [group("g/sub", [leaf("a"), leaf("b")])]);
    expect(allLeavesDisabled(node, new Set<P>(["a", "b"]))).toBe(true);
    expect(allLeavesDisabled(node, new Set<P>(["a"]))).toBe(false);
  });

  it("is false for an empty group", () => {
    expect(allLeavesDisabled(group("empty", []), new Set<P>(["a"]))).toBe(false);
  });
});
