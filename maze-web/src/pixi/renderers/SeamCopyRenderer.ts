import { Container, Graphics, Matrix } from "pixi.js";
import type { FieldConfig } from "../../fieldConfig";
import { planSeamCopies, type SeamDisk } from "../selectors/seamCopies";

/** The stacking slots of a copy, bottom to top: the same order the artwork itself is layered in. */
export const SEAM_COPY_LAYERS = ["indexGap", "vertical", "markers", "indexBody"] as const;
export type SeamCopyLayerName = (typeof SEAM_COPY_LAYERS)[number];
export type SeamCopyLayers = Record<SeamCopyLayerName, Container>;

/** One kind of free-standing artwork that can reach past a glued face (GitHub issue #981,
 *  `Specs/topology.md`, "Elements that cross a seam"). A kind describes only its elements' reach and how
 *  to draw a subset of them; where the copies go, how they are turned and what masks them is
 *  `SeamCopyRenderer`'s. */
export interface SeamCopySource {
  /** One circle per element, bounding all it draws. Generous bounds are fine: the copy is masked. */
  disks: readonly SeamDisk[];
  /** Draws the elements at `indices` (into `disks`) into `layers`, in the original's own coordinates.
   *  Returns what releases the renderers it made. */
  draw(layers: SeamCopyLayers, indices: readonly number[]): () => void;
}

interface Entry {
  wrapper: Container;
  release: (() => void)[];
}

/** Draws the part of free-standing artwork that reaches past a glued face on the partner's side.
 *
 *  Each copy is the element drawn again under the seam's own isometry (`SeamCopy.transform`), so it reads
 *  as the same element continuing over the glue, turned (and mirrored on a twisted seam) as the partner's
 *  frame is. A mask, the strip inside the partner's cell along the glued face, keeps from it only what
 *  the original lost to the trim mask. */
export class SeamCopyRenderer {
  private readonly layer = new Container();
  private entries: Entry[] = [];

  constructor(parent: Container) {
    parent.addChild(this.layer);
  }

  get container(): Container {
    return this.layer;
  }

  clear(): void {
    for (const entry of this.entries) {
      for (const release of entry.release) release();
      entry.wrapper.destroy({ children: true });
    }
    this.entries = [];
  }

  /** Redraws the copies of every source's elements; none when the floor has no glued face to cross. */
  render(cfg: FieldConfig, sources: readonly SeamCopySource[]): void {
    this.clear();
    const offsets: number[] = [];
    const disks: SeamDisk[] = [];
    for (const source of sources) {
      offsets.push(disks.length);
      disks.push(...source.disks);
    }
    for (const copy of planSeamCopies(cfg, disks)) {
      const { transform: t, clip } = copy;
      const wrapper = new Container();
      const mask = new Graphics();
      for (const polygon of clip) mask.poly(polygon).fill(0xffffff);
      // The mask stays out of the transformed holder: a mask works in world space, so it keeps the clip's own
      // (display-space) polygons while the holder moves the artwork.
      const holder = new Container();
      holder.mask = mask;
      const inner = new Container();
      inner.setFromMatrix(new Matrix(t.a, t.b, t.c, t.d, t.tx, t.ty));
      const layers = {} as SeamCopyLayers;
      for (const name of SEAM_COPY_LAYERS) {
        layers[name] = new Container();
        inner.addChild(layers[name]);
      }
      holder.addChild(inner);
      wrapper.addChild(mask, holder);
      this.layer.addChild(wrapper);

      const release: (() => void)[] = [];
      sources.forEach((source, i) => {
        const from = offsets[i];
        const indices = copy.indices.filter((index) => index >= from && index < from + source.disks.length).map((index) => index - from);
        if (indices.length > 0) release.push(source.draw(layers, indices));
      });
      this.entries.push({ wrapper, release });
    }
  }

  destroy(): void {
    this.clear();
    this.layer.destroy({ children: true });
  }
}
