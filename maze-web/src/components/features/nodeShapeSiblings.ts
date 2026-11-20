/** Source of a cell type's full shape vocabulary for text outside the limits editor (issue
 *  bubbles). A registry with no imports of its own: `issueRegistry` reads it, and the module that
 *  knows the applied tessellation (`nodeShapeVocabulary`, which reaches the store) registers
 *  itself, so the store and the registry never import each other. */
type SiblingsSource = (cellType: string) => readonly string[] | undefined;

let source: SiblingsSource | null = null;

export function registerNodeShapeSiblingsSource(next: SiblingsSource | null): void {
  source = next;
}

/** Every shape key of `cellType`, the `siblings` of `nodeShapeLabel`; `undefined` when no source is
 *  registered or it cannot tell, which makes the label show degree and faces both. */
export function nodeShapeSiblingsOf(cellType: string): readonly string[] | undefined {
  return source?.(cellType);
}
