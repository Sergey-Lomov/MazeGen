//! Cell types: a tessellation-defined classification of its cells, for consumers (QC rules, the
//! generator) that treat cells differently by type. See `Specs/space.md`'s "Cell types".

use std::collections::BTreeMap;

/// A cell type of one tessellation instance: a stable key, unique within the instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CellType {
    key: &'static str,
}

impl CellType {
    pub const fn new(key: &'static str) -> Self {
        Self { key }
    }

    /// The stable key, e.g. `octagon`. Unique among `Tessellation::cell_types` of one instance.
    pub const fn key(&self) -> &'static str {
        self.key
    }
}

/// Position of a type in `Tessellation::cell_types`. Valid only for the instance that produced it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CellTypeId(usize);

impl CellTypeId {
    pub const fn new(index: usize) -> Self {
        Self(index)
    }

    pub const fn index(self) -> usize {
        self.0
    }
}

/// The only type of a tessellation that does not override `Tessellation::cell_types`.
pub(super) const UNIFORM_TYPES: [CellType; 1] = [CellType::new("cell")];

/// The type with `key` among `types` (a `Tessellation::cell_types` list).
pub fn cell_type_by_key(types: &[CellType], key: &str) -> Option<CellTypeId> {
    types
        .iter()
        .position(|cell_type| cell_type.key() == key)
        .map(CellTypeId::new)
}

/// One value per cell type of a tessellation instance: how a consumer (QC rule, generator
/// setting) parametrizes by type. Configs name types by key, never by `CellTypeId`, so they
/// survive serialization; `from_overrides` resolves the keys against one instance.
#[derive(Debug, Clone, PartialEq)]
pub struct CellTypeTable<V> {
    values: Vec<V>,
}

impl<V: Clone> CellTypeTable<V> {
    /// A table over `types` where every type has `default`, except the keys in `overrides`.
    /// A key that is not among `types` is an error naming the key and the known ones.
    pub fn from_overrides(
        types: &[CellType],
        overrides: &BTreeMap<String, V>,
        default: V,
    ) -> Result<Self, String> {
        let mut values = vec![default; types.len()];
        for (key, value) in overrides {
            let id = cell_type_by_key(types, key).ok_or_else(|| {
                let known: Vec<_> = types.iter().map(CellType::key).collect();
                format!("unknown cell type `{key}`, expected one of {known:?}")
            })?;
            values[id.index()] = value.clone();
        }
        Ok(Self { values })
    }

    /// The value of `id`, which must come from the instance the table was built for.
    pub fn get(&self, id: CellTypeId) -> &V {
        &self.values[id.index()]
    }
}
