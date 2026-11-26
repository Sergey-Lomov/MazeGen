import type { Container } from "pixi.js";
import type { TestTextData } from "../../composition/elementTypes";
import { makeLabelText } from "../renderers/labelFont";
import { VECTOR_FONT_FAMILY } from "../../domain/renderers/fontChoice";

/** Builds the Pixi object of one composition element from its type's `data`, positioned in the canvas's world units. */
export type CompositionElementDisplay = (data: unknown) => Container;

function testTextDisplay(raw: unknown): Container {
  const d = raw as TestTextData;
  const label = makeLabelText(d.text, { family: VECTOR_FONT_FAMILY, weight: 400 }, d.fontSize, Number.parseInt(d.color.slice(1), 16));
  label.anchor.set(0, 0);
  label.position.set(d.x, d.y);
  return label;
}

/** One display factory per registered element type id (`ELEMENT_TYPES`); a test fails when a type has none. */
export const COMPOSITION_ELEMENT_DISPLAYS: Record<string, CompositionElementDisplay> = {
  test_text: testTextDisplay,
};
