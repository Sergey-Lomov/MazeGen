import type { FieldConfig } from "../fieldConfig";
import { getCellGeometry } from "./cartesianCache";
import type { SplitFaceKind } from "./splitFaceLayout";

/** A cell's shape template and the binding of its faces to the template's canonical order (core's
 *  `CellShape`): `canonicalOfLocal[i]` is the canonical index of the cell's `i`-th face
 *  (`faces_of` order), `localOfCanonical` its inverse. Shape-specific recognition and layout are
 *  defined on the template's canonical faces, so they hold for every cell of the template. */
export interface SplitShapeBinding {
  /** `ShapeDescriptor` key: `regular:4`, `regular:6`, `cairo_pentagon`, … */
  shape: string;
  canonicalOfLocal: readonly number[];
  localOfCanonical: readonly number[];
  /** The cell's allowed transform group as permutations of canonical faces, identity first. */
  group: readonly (readonly number[])[];
}

const bindings = new WeakMap<object, SplitShapeBinding | null>();

/** The shape binding of cell `(x, y)`, or `null` for a cell without a template. */
export function splitShapeBinding(cfg: FieldConfig, x: number, y: number): SplitShapeBinding | null {
  const geometry = getCellGeometry(x, y, cfg);
  let binding = bindings.get(geometry);
  if (binding === undefined) {
    const canonicalOfLocal = geometry.faces.map((face) => face.canonical_face);
    if (geometry.shape == null || geometry.allowed_group == null || canonicalOfLocal.some((face) => face === null)) {
      binding = null;
    } else {
      const forward = canonicalOfLocal as number[];
      const inverse: number[] = [];
      forward.forEach((canonical, local) => { inverse[canonical] = local; });
      binding = { shape: geometry.shape, canonicalOfLocal: forward, localOfCanonical: inverse, group: geometry.allowed_group };
    }
    bindings.set(geometry, binding);
  }
  return binding;
}

/** `kinds` (one per face in the cell's `faces_of` order) reordered into canonical face order. */
export function canonicalFaceKinds(binding: SplitShapeBinding, kinds: readonly SplitFaceKind[]): SplitFaceKind[] {
  return binding.localOfCanonical.map((local) => kinds[local]);
}

/** The group element that moves every canonical face `k` to `k + step` (mod face count): one
 *  rotation step around the template. `null` when the cell's allowed group has no such element
 *  (Cairo's group is identity + one reflection, so it cannot rotate). */
export function rotationTransform(binding: SplitShapeBinding, step: 1 | -1): readonly number[] | null {
  const n = binding.canonicalOfLocal.length;
  return binding.group.find((perm) => perm.every((image, face) => image === (face + step + n) % n)) ?? null;
}

/** Whether the cell's allowed group contains a rotation, i.e. whether rotating its split point is possible. */
export function canRotateSplit(cfg: FieldConfig, x: number, y: number): boolean {
  const binding = splitShapeBinding(cfg, x, y);
  return binding !== null && rotationTransform(binding, 1) !== null;
}
