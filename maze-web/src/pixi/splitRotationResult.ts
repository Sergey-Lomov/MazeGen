export type SplitRotationRefusal = "outside_field" | "ambiguous_face_owner";

/** Rotation values keep their native Array/Map API while exposing a refusal from the pure helper. */
export type SplitRotationResult<T extends object> = T & { readonly refusalReason?: SplitRotationRefusal };

export function refusedRotation<T extends object>(value: T, refusalReason: SplitRotationRefusal): SplitRotationResult<T> {
  Object.defineProperty(value, "refusalReason", { value: refusalReason, enumerable: false });
  return value;
}
