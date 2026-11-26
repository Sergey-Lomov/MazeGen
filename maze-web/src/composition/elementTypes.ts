import * as m from "~/paraglide/messages";
import type { CompositionState } from "./compositionTypes";
import { assertNumber, assertObject, assertString } from "../validation/validatePrimitives";

/** A kind of composition element. Adding a type means adding one entry to `ELEMENT_TYPES` and its display factory to
 *  `COMPOSITION_ELEMENT_DISPLAYS` (`pixi/imageExport/compositionElementDisplays.ts`): the list panel, the composition
 *  layer on the main canvas and the project file go through this interface only (GitHub issue #1099). */
export interface CompositionElementType {
  id: string;
  label: () => string;
  /** Name a new element of this type starts with; `ordinal` counts the composition's elements of this type. */
  defaultName: (ordinal: number) => string;
  /** Data of a new element; `ordinal` is the same as for `defaultName`. */
  createData: (ordinal: number) => unknown;
  /** Validates the saved `data` of this type, throwing with `path` in the message. */
  validateData: (raw: unknown, path: string) => unknown;
  /** True for a type that draws the maze picture (the maze area element, a later ticket). */
  rendersMaze?: boolean;
}

/** Data of the test text type: one line of text at a position of the main canvas, in its world units. */
export interface TestTextData {
  x: number;
  y: number;
  text: string;
  fontSize: number;
  /** `#RRGGBB`. */
  color: string;
}

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const TEST_TEXT_COLORS = ["#4f8cff", "#ff9f43", "#2ecc71", "#e74c3c", "#9b59b6"];

/** Stand-in element until the real types arrive (GitHub issues #1100 to #1103, the text element is #1101): it lets the
 *  list, the main canvas and the project file be exercised end to end. */
export const TEST_TEXT_TYPE: CompositionElementType = {
  id: "test_text",
  label: () => m["composition.type.test_text"](),
  defaultName: (ordinal) => m["composition.element.default_name.test_text"]({ number: ordinal }),
  createData: (ordinal) => {
    const step = 40 * ((ordinal - 1) % 8);
    return {
      x: 20 + step,
      y: 20 + step,
      text: m["composition.element.default_name.test_text"]({ number: ordinal }),
      fontSize: 24,
      color: TEST_TEXT_COLORS[(ordinal - 1) % TEST_TEXT_COLORS.length],
    } satisfies TestTextData;
  },
  validateData: (raw, path) => {
    const obj = assertObject(raw, path);
    const color = assertString(obj.color, `${path}.color`);
    if (!COLOR_PATTERN.test(color)) throw new Error(`Expected ${path}.color to be #RRGGBB`);
    const fontSize = assertNumber(obj.fontSize, `${path}.fontSize`);
    if (!(fontSize > 0)) throw new Error(`Expected ${path}.fontSize to be positive`);
    return { x: assertNumber(obj.x, `${path}.x`), y: assertNumber(obj.y, `${path}.y`), text: assertString(obj.text, `${path}.text`), fontSize, color } satisfies TestTextData;
  },
};

export const ELEMENT_TYPES: readonly CompositionElementType[] = [TEST_TEXT_TYPE];

export function resolveElementType(id: string): CompositionElementType | null {
  return ELEMENT_TYPES.find((t) => t.id === id) ?? null;
}

/** The maze picture belongs to the composition: it is drawn only while the active composition has a visible
 *  element of a type that renders it. With no such element the canvas shows only the composition's elements. */
export function compositionShowsMaze(
  state: Pick<CompositionState, "compositions" | "activeCompositionId">,
  resolve: (id: string) => CompositionElementType | null = resolveElementType,
): boolean {
  const composition = state.compositions.find((c) => c.id === state.activeCompositionId);
  return !!composition?.elements.some((e) => e.visible && resolve(e.type)?.rendersMaze);
}
