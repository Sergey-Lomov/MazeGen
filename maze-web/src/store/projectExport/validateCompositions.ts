import type { ProjectFileCompositions } from "./types";
import type { Composition, CompositionElement } from "../../composition/compositionModel";
import { resolveElementType } from "../../composition/elementTypes";
import { assertArray, assertBoolean, assertNumber, assertObject, assertString, assertUniqueIds } from "../../validation/validatePrimitives";

function assertCounter(v: unknown, path: string): number {
  const n = assertNumber(v, path);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Expected ${path} to be a positive integer`);
  return n;
}

function validateElement(raw: unknown, path: string): CompositionElement {
  const obj = assertObject(raw, path);
  const typeId = assertString(obj.type, `${path}.type`);
  const type = resolveElementType(typeId);
  if (!type) throw new Error(`${path}.type: unknown composition element type "${typeId}"`);
  return {
    id: assertString(obj.id, `${path}.id`),
    type: typeId,
    name: assertString(obj.name, `${path}.name`),
    visible: assertBoolean(obj.visible, `${path}.visible`),
    locked: assertBoolean(obj.locked, `${path}.locked`),
    data: type.validateData(obj.data, `${path}.data`),
  };
}

function validateComposition(raw: unknown, path: string): Composition {
  const obj = assertObject(raw, path);
  const elements = assertArray(obj.elements, `${path}.elements`).map((e, i) => validateElement(e, `${path}.elements[${i}]`));
  assertUniqueIds(elements, (e) => e.id, "composition element id", `${path}.elements`);
  return { id: assertString(obj.id, `${path}.id`), name: assertString(obj.name, `${path}.name`), elements };
}

/** The project file's required `compositions` section (GitHub issue #1099): at least one composition, and an
 *  `activeCompositionId` that names one of them. Element `data` is validated by each element's own type. */
export function validateCompositions(raw: unknown, path: string): ProjectFileCompositions {
  const obj = assertObject(raw, path);
  const compositions = assertArray(obj.compositions, `${path}.compositions`).map((c, i) => validateComposition(c, `${path}.compositions[${i}]`));
  if (compositions.length === 0) throw new Error(`${path}.compositions: expected at least one composition`);
  assertUniqueIds(compositions, (c) => c.id, "composition id", `${path}.compositions`);
  const elementIds = compositions.flatMap((c) => c.elements.map((e) => e.id));
  assertUniqueIds(elementIds, (id) => id, "composition element id", `${path}.compositions`);
  const activeCompositionId = assertString(obj.activeCompositionId, `${path}.activeCompositionId`);
  if (!compositions.some((c) => c.id === activeCompositionId)) throw new Error(`${path}.activeCompositionId: no composition "${activeCompositionId}"`);
  return {
    compositions,
    activeCompositionId,
    nextCompositionNumber: assertCounter(obj.nextCompositionNumber, `${path}.nextCompositionNumber`),
    nextElementNumber: assertCounter(obj.nextElementNumber, `${path}.nextElementNumber`),
  };
}
