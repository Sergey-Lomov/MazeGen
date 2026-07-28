//! Language-neutral intermediate representation the parser builds and both emitters consume.
//! Neither this module nor its consumers know anything about Rust or TS syntax — see the plan's
//! "Архитектура: единая Schema, два emitter'а" section.

/// Where in `maze-core/src` a source enum lives, and where its generated `_wire.rs` sibling and
/// `mod` insertion point are.
#[derive(Debug, Clone)]
pub struct SourceLocation {
    /// Path to the `.rs` file containing the enum, relative to the repo root.
    pub rust_file: String,
    /// Module-relative stem used for the generated Rust file (`<stem>_wire.rs`) and the TS output
    /// file (`generated/<stem>.ts`) — derived from the enum name (snake_case).
    pub stem: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireWidth {
    Fixed(u32),
    LengthPrefixed,
}

/// One field's type, resolved to either a standard type (looked up in `type_map`) or a named
/// custom codec (looked up in `codecs`) — never a raw, unresolved Rust type string past parsing.
#[derive(Debug, Clone)]
pub enum FieldType {
    Standard(&'static str),
    Custom(String),
}

#[derive(Debug, Clone)]
pub struct Field {
    pub name: String,
    pub ty: FieldType,
}

/// The three whitelisted variant shapes (plan section 2) — no other shape is representable in
/// `Schema` at all, so an emitter can exhaustively match this enum without a catch-all.
#[derive(Debug, Clone)]
pub enum VariantShape {
    Unit,
    /// Tuple variant with exactly one field (e.g. `VertexSelected(NodeId)`) — the field name comes
    /// from the mandatory `#[wire(name = "...")]` attribute (see plan section 2's revision), not a
    /// generated placeholder, since every real single-field tuple variant migrated so far already
    /// had a meaningful hand-written field name (`id`, `edges`, `pairs`) that TS consumers depend
    /// on — a generic `value` would silently break every one of them.
    NewtypeTuple(Field),
    Struct(Vec<Field>),
}

#[derive(Debug, Clone)]
pub struct Variant {
    pub name: String,
    pub tag: u16,
    pub mutating: bool,
    pub shape: VariantShape,
}

/// Whether a source's `is_mutating()` is a per-variant `matches!` (the common case) or an
/// unconditional `true` (`PresetSetupEvent` today — see plan section 6's "Особый случай").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutatingMode {
    PerVariant,
    AlwaysMutating,
}

#[derive(Debug, Clone)]
pub struct EventSource {
    pub enum_name: String,
    pub location: SourceLocation,
    pub mutating_mode: MutatingMode,
    pub variants: Vec<Variant>,
}

pub struct Schema {
    pub sources: Vec<EventSource>,
}
