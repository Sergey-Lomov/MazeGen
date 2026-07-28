//! Single registry mapping a Rust field type to its TS counterpart and the read/write helper
//! functions each side already has in `wire.ts`/the Rust `write_*` helpers — see plan section 3.
//! Adding a new simple type (e.g. `EdgeId`) is one entry here, not a change scattered across the
//! emitters.

use crate::schema::WireWidth;

/// Whether `ts_read_fn(bytes, offset)` returns the value directly, or an object with a named
/// field holding the value plus a `next` byte offset (`readNodeIdList`/`readF64List`/`readStr`'s
/// shape) — the emitter needs this to know whether to append `.value`/`.ids`/`.values` or use the
/// call expression as-is.
pub enum TsReadShape {
    Bare,
    Object(&'static str),
}

pub struct TypeMapping {
    pub rust_type: &'static str,
    pub ts_type: &'static str,
    pub rust_write_fn: &'static str,
    pub ts_read_fn: &'static str,
    pub ts_read_shape: TsReadShape,
    pub wire_width: WireWidth,
}

pub const STANDARD_TYPES: &[TypeMapping] = &[
    TypeMapping { rust_type: "NodeId", ts_type: "bigint", rust_write_fn: "write_node_id", ts_read_fn: "readNodeId", ts_read_shape: TsReadShape::Bare, wire_width: WireWidth::Fixed(8) },
    TypeMapping { rust_type: "u32", ts_type: "number", rust_write_fn: "write_u32", ts_read_fn: "readU32", ts_read_shape: TsReadShape::Bare, wire_width: WireWidth::Fixed(4) },
    TypeMapping { rust_type: "u64", ts_type: "bigint", rust_write_fn: "write_u64", ts_read_fn: "readNodeId", ts_read_shape: TsReadShape::Bare, wire_width: WireWidth::Fixed(8) },
    TypeMapping { rust_type: "usize", ts_type: "number", rust_write_fn: "write_usize_as_u32", ts_read_fn: "readU32", ts_read_shape: TsReadShape::Bare, wire_width: WireWidth::Fixed(4) },
    TypeMapping { rust_type: "f64", ts_type: "number", rust_write_fn: "write_f64", ts_read_fn: "readF64", ts_read_shape: TsReadShape::Bare, wire_width: WireWidth::Fixed(8) },
    TypeMapping { rust_type: "bool", ts_type: "boolean", rust_write_fn: "write_bool", ts_read_fn: "readBool", ts_read_shape: TsReadShape::Bare, wire_width: WireWidth::Fixed(1) },
    TypeMapping { rust_type: "String", ts_type: "string", rust_write_fn: "write_str", ts_read_fn: "readStr", ts_read_shape: TsReadShape::Object("value"), wire_width: WireWidth::LengthPrefixed },
    TypeMapping { rust_type: "&'staticstr", ts_type: "string", rust_write_fn: "write_str", ts_read_fn: "readStr", ts_read_shape: TsReadShape::Object("value"), wire_width: WireWidth::LengthPrefixed },
    TypeMapping { rust_type: "Vec<NodeId>", ts_type: "bigint[]", rust_write_fn: "push_ids", ts_read_fn: "readNodeIdList", ts_read_shape: TsReadShape::Object("ids"), wire_width: WireWidth::LengthPrefixed },
    TypeMapping { rust_type: "Vec<f64>", ts_type: "number[]", rust_write_fn: "push_f64s", ts_read_fn: "readF64List", ts_read_shape: TsReadShape::Object("values"), wire_width: WireWidth::LengthPrefixed },
    TypeMapping { rust_type: "Option<NodeId>", ts_type: "bigint | null", rust_write_fn: "write_optional_node_id", ts_read_fn: "readOptionalNodeId", ts_read_shape: TsReadShape::Bare, wire_width: WireWidth::Fixed(9) },
    TypeMapping { rust_type: "Option<usize>", ts_type: "number | null", rust_write_fn: "write_optional_usize_as_u32", ts_read_fn: "readOptionalUsize", ts_read_shape: TsReadShape::Bare, wire_width: WireWidth::Fixed(5) },
];

pub fn lookup(rust_type: &str) -> Option<&'static TypeMapping> {
    STANDARD_TYPES.iter().find(|t| t.rust_type == rust_type)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_finds_a_registered_standard_type() {
        let m = lookup("NodeId").expect("NodeId should be registered");
        assert_eq!(m.ts_type, "bigint");
        assert_eq!(m.wire_width, WireWidth::Fixed(8));
    }

    #[test]
    fn lookup_returns_none_for_an_unregistered_type() {
        assert!(lookup("EdgeId").is_none());
    }

    #[test]
    fn every_standard_type_has_a_unique_rust_type_key() {
        let mut seen = std::collections::HashSet::new();
        for t in STANDARD_TYPES {
            assert!(seen.insert(t.rust_type), "duplicate rust_type entry: {}", t.rust_type);
        }
    }
}
