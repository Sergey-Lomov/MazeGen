import { tessellationConfigOf, type DisplayOrientation, type FieldConfig, type FieldShape, type TessellationKind } from "../fieldConfig";

/** A `FieldConfig` literal for tests: tessellation `kind`, the floor's `shape` and an optional
 * display orientation (hex/tri). */
export function fieldOf<S extends FieldShape>(kind: TessellationKind, shape: S, orientation?: DisplayOrientation): FieldConfig & { shape: S } {
  return orientation === undefined
    ? { tessellation: tessellationConfigOf(kind), shape }
    : { tessellation: tessellationConfigOf(kind), orientation, shape };
}
