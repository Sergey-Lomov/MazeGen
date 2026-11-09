//! Normalization of a field's cells (GitHub issue #957): the cells with no edge-adjacent neighbor
//! and, with smoothing, the one-edge terminal cells are removed, repeating until nothing changes.
//!
//! The same rule runs in the web editor (`normalizeCells`, `maze-web/src/pixi/primitiveGeometry.ts`)
//! for every field editing tool; core applies it to preset shapes so that print sizing measures the
//! field the editor shows. `maze-web` tests compare the two.

use super::Tessellation;
use std::collections::HashSet;

/// `cells` without the cells that have fewer than `min_links` neighbors among the remaining ones,
/// repeated until no cell is removed. A neighbor counts once per face it is reached through, as the
/// editor counts it once per neighbor offset.
///
/// Smoothing (`smooth`) needs at least four cells to leave a meaningful shape and requires two
/// links; otherwise one link is enough. This is judged once on the input: a per-pass check would
/// stop peeling a thin strip at three cells and leave its stubs behind.
pub fn normalize_cells<T: Tessellation>(
    tessellation: &T,
    cells: &[T::CellId],
    smooth: bool,
) -> Vec<T::CellId> {
    let min_links = if smooth && cells.len() >= 4 { 2 } else { 1 };
    let mut result = linked_cells(tessellation, cells, min_links);
    loop {
        let next = linked_cells(tessellation, &result, min_links);
        if next.len() == result.len() {
            return result;
        }
        result = next;
    }
}

/// One pass of `normalize_cells`: the cells of `cells` with at least `min_links` neighbors in it.
fn linked_cells<T: Tessellation>(
    tessellation: &T,
    cells: &[T::CellId],
    min_links: usize,
) -> Vec<T::CellId> {
    let present: HashSet<T::CellId> = cells.iter().copied().collect();
    cells
        .iter()
        .copied()
        .filter(|&cell| {
            let links = tessellation
                .faces_of(cell)
                .iter()
                .filter(|&&face| {
                    tessellation
                        .neighbor(cell, face)
                        .is_some_and(|(other, _)| present.contains(&other))
                })
                .count();
            links >= min_links
        })
        .collect()
}

/// A preset shape as the editor shows it with smoothing on: `normalize_cells` with smoothing, a
/// shape of fewer than two cells is kept as it is, and so is a shape smoothing would peel away
/// entirely (a one-cell-thick strip).
pub fn smooth_preset_cells<T: Tessellation>(
    tessellation: &T,
    cells: Vec<T::CellId>,
) -> Vec<T::CellId> {
    if cells.len() < 2 {
        return cells;
    }
    let smoothed = normalize_cells(tessellation, &cells, true);
    if smoothed.is_empty() { cells } else { smoothed }
}

/// Whether smoothing leaves a preset alone: a box, a polyhedron, a cylinder or a torus is built
/// from exact cells.
pub fn preset_requires_exact_cells(preset: &str) -> bool {
    matches!(
        preset,
        "box" | "tetrahedron" | "octahedron" | "icosahedron" | "cylinder" | "torus"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{SquarePoint, SquareTessellation};

    type Cell = SquarePoint;

    fn cell(x: i32, y: i32) -> Cell {
        SquarePoint { x, y }
    }

    #[test]
    fn an_isolated_cell_is_removed_without_smoothing() {
        let t = SquareTessellation;
        let cells = vec![cell(0, 0), cell(1, 0), cell(5, 5)];
        assert_eq!(normalize_cells(&t, &cells, false), vec![cell(0, 0), cell(1, 0)]);
    }

    #[test]
    fn smoothing_peels_a_terminal_cell_and_a_spike_cascade() {
        let t = SquareTessellation;
        // A 3x3 block with a two-cell tail: the tail goes cell by cell, the block stays.
        let mut cells: Vec<Cell> = (0..3).flat_map(|x| (0..3).map(move |y| cell(x, y))).collect();
        cells.extend([cell(3, 1), cell(4, 1)]);
        let smoothed = normalize_cells(&t, &cells, true);
        assert_eq!(smoothed.len(), 9);
        assert!(!smoothed.contains(&cell(3, 1)) && !smoothed.contains(&cell(4, 1)));
    }

    #[test]
    fn a_shape_of_fewer_than_four_cells_is_not_smoothed() {
        let t = SquareTessellation;
        let cells = vec![cell(0, 0), cell(1, 0), cell(2, 0)];
        assert_eq!(normalize_cells(&t, &cells, true), cells);
    }

    #[test]
    fn a_preset_smoothing_would_peel_away_is_kept() {
        let t = SquareTessellation;
        let strip: Vec<Cell> = (0..6).map(|x| cell(x, 0)).collect();
        assert!(normalize_cells(&t, &strip, true).is_empty());
        assert_eq!(smooth_preset_cells(&t, strip.clone()), strip);
    }

    #[test]
    fn exact_cell_presets_are_named() {
        for preset in ["box", "tetrahedron", "octahedron", "icosahedron", "cylinder", "torus"] {
            assert!(preset_requires_exact_cells(preset), "{preset}");
        }
        for preset in ["rect", "parallelogram", "circle", "triangle", "hexagon"] {
            assert!(!preset_requires_exact_cells(preset), "{preset}");
        }
    }
}
