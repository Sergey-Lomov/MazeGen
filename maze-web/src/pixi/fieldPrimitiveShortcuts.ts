import type { FieldOperation, FieldPrimitive } from "../store/tessellationTypes";

const ORDERED_PRIMITIVES: readonly FieldPrimitive[] = [
  "point",
  "rectangle",
  "circle",
  "triangle",
  "equilateral_triangle",
  "hexagon",
  "parallelogram",
  "polygon",
  "magic_wand",
  "symmetry",
];

export function fieldPrimitiveShortcut(primitive: FieldPrimitive): string {
  if (primitive === "magic_wand") return "A";
  if (primitive === "symmetry") return "S";
  return String(ORDERED_PRIMITIVES.indexOf(primitive) + 1);
}

export function fieldPrimitiveForShortcut(code: string): FieldPrimitive | undefined {
  const match = /^(?:Digit|Numpad)([1-8])$/.exec(code);
  if (match) return ORDERED_PRIMITIVES[Number(match[1]) - 1];
  if (code === "KeyA") return "magic_wand";
  if (code === "KeyS") return "symmetry";
  return undefined;
}

export function canActivateFieldPrimitive(
  primitive: FieldPrimitive,
  operation: FieldOperation,
  fieldEditLocked: boolean,
): boolean {
  return !fieldEditLocked
    && !(primitive === "symmetry" && operation === "select");
}
