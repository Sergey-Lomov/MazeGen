//! Generates golden byte vectors for round-trip regression tests (plan section 7) — standard-type
//! variants only. Custom-field variants are skipped here on purpose: `Schema` knows a custom
//! codec's name and covered type, but not what bytes its hand-written function produces for a
//! given value, so a golden entry for it would be fabricated, not derived. Those variants rely on
//! the existing hand-written tests in `event.rs` instead (see plan's "Основная защита" note).

use crate::naming::to_camel_case;
use crate::schema::{EventSource, Field, FieldType, VariantShape};

pub struct GoldenEntry {
    pub variant_name: String,
    /// Rust expression constructing the example value, e.g. `RecursiveBacktrackerEvent::VertexSelected(7)`.
    pub rust_construct_expr: String,
    /// JSON value for the `codegen/golden/<stem>.json` inspection fixture — plain numbers, since
    /// JSON has no bigint literal (e.g. `{"kind":"VertexSelected","value":7}`).
    pub example_value_json: String,
    /// TS object-literal expression for the golden test's `toEqual` comparison — unlike the JSON
    /// field above, this uses real `bigint` literals (`7n`) where the decoded field is a
    /// `bigint`, so the comparison's expected shape actually matches what `decodeXEvent` returns.
    pub example_value_ts: String,
    pub expected_bytes: Vec<u8>,
}

/// `None` per variant means "not representable as a standard-type golden entry" (unit variants
/// with no payload still produce an empty-bytes entry; only custom-field variants are skipped —
/// see module doc).
pub fn generate_golden(source: &EventSource) -> Vec<GoldenEntry> {
    let mut out = Vec::new();
    for v in &source.variants {
        if let Some(entry) = golden_for_variant(&source.enum_name, v) {
            out.push(entry);
        }
    }
    out
}

fn golden_for_variant(enum_name: &str, v: &crate::schema::Variant) -> Option<GoldenEntry> {
    match &v.shape {
        VariantShape::Unit => Some(GoldenEntry {
            variant_name: v.name.clone(),
            rust_construct_expr: format!("{enum_name}::{}", v.name),
            example_value_json: format!("{{\"kind\":\"{}\"}}", v.name),
            example_value_ts: format!("{{ kind: \"{}\" }}", v.name),
            expected_bytes: Vec::new(),
        }),
        VariantShape::NewtypeTuple(field) => {
            let ex = example_for(&field.ty)?;
            let field_camel = to_camel_case(&field.name);
            Some(GoldenEntry {
                variant_name: v.name.clone(),
                rust_construct_expr: format!("{enum_name}::{}({})", v.name, ex.rust_lit),
                example_value_json: format!(
                    "{{\"kind\":\"{}\",\"{}\":{}}}",
                    v.name, field.name, ex.json_lit
                ),
                example_value_ts: format!(
                    "{{ kind: \"{}\", {}: {} }}",
                    v.name, field_camel, ex.ts_lit
                ),
                expected_bytes: ex.bytes,
            })
        }
        VariantShape::Struct(fields) => golden_for_struct(enum_name, v, fields),
    }
}

fn golden_for_struct(
    enum_name: &str,
    v: &crate::schema::Variant,
    fields: &[Field],
) -> Option<GoldenEntry> {
    let mut bytes = Vec::new();
    let mut rust_fields = Vec::new();
    let mut json_fields = Vec::new();
    let mut ts_fields = Vec::new();
    for f in fields {
        let ex = example_for(&f.ty)?;
        bytes.extend(ex.bytes);
        rust_fields.push(format!("{}: {}", f.name, ex.rust_lit));
        json_fields.push(format!("\"{}\":{}", f.name, ex.json_lit));
        ts_fields.push(format!("{}: {}", to_camel_case(&f.name), ex.ts_lit));
    }
    Some(GoldenEntry {
        variant_name: v.name.clone(),
        rust_construct_expr: format!("{enum_name}::{} {{ {} }}", v.name, rust_fields.join(", ")),
        example_value_json: format!("{{\"kind\":\"{}\",{}}}", v.name, json_fields.join(",")),
        example_value_ts: format!("{{ kind: \"{}\", {} }}", v.name, ts_fields.join(", ")),
        expected_bytes: bytes,
    })
}

struct FieldExample {
    bytes: Vec<u8>,
    rust_lit: String,
    /// Plain-number JSON literal (JSON has no bigint) — for the inspection fixture only.
    json_lit: String,
    /// TS literal with a real `n` suffix where the field decodes to `bigint` — for the golden
    /// test's `toEqual` comparison, which must match `decodeXEvent`'s actual runtime type.
    ts_lit: String,
}

/// Deterministic example value — wire bytes plus Rust/JSON/TS literal forms — for standard types
/// only. `None` for `FieldType::Custom` (see module doc).
fn example_for(ty: &FieldType) -> Option<FieldExample> {
    let FieldType::Standard(t) = ty else {
        return None;
    };
    Some(match *t {
        "NodeId" | "u64" => FieldExample {
            bytes: 7u64.to_le_bytes().to_vec(),
            rust_lit: "7".into(),
            json_lit: "7".into(),
            ts_lit: "7n".into(),
        },
        "u32" | "usize" => FieldExample {
            bytes: 7u32.to_le_bytes().to_vec(),
            rust_lit: "7".into(),
            json_lit: "7".into(),
            ts_lit: "7".into(),
        },
        "f64" => FieldExample {
            bytes: 1.5f64.to_le_bytes().to_vec(),
            rust_lit: "1.5".into(),
            json_lit: "1.5".into(),
            ts_lit: "1.5".into(),
        },
        "bool" => FieldExample {
            bytes: vec![1u8],
            rust_lit: "true".into(),
            json_lit: "true".into(),
            ts_lit: "true".into(),
        },
        "String" => {
            let s = "x";
            let mut b = (s.len() as u32).to_le_bytes().to_vec();
            b.extend(s.as_bytes());
            FieldExample {
                bytes: b,
                rust_lit: "\"x\".to_string()".into(),
                json_lit: "\"x\"".into(),
                ts_lit: "\"x\"".into(),
            }
        }
        "Vec<NodeId>" => {
            let ids = [3u64, 5u64];
            let mut b = (ids.len() as u32).to_le_bytes().to_vec();
            for id in ids {
                b.extend(id.to_le_bytes());
            }
            FieldExample {
                bytes: b,
                rust_lit: "vec![3, 5]".into(),
                json_lit: "[3,5]".into(),
                ts_lit: "[3n, 5n]".into(),
            }
        }
        "Vec<f64>" => {
            let vals = [1.0f64];
            let mut b = (vals.len() as u32).to_le_bytes().to_vec();
            for v in vals {
                b.extend(v.to_le_bytes());
            }
            FieldExample {
                bytes: b,
                rust_lit: "vec![1.0]".into(),
                json_lit: "[1]".into(),
                ts_lit: "[1]".into(),
            }
        }
        "Option<NodeId>" => {
            let mut b = vec![1u8];
            b.extend(9u64.to_le_bytes());
            FieldExample {
                bytes: b,
                rust_lit: "Some(9)".into(),
                json_lit: "9".into(),
                ts_lit: "9n".into(),
            }
        }
        "Option<usize>" => {
            let mut b = vec![1u8];
            b.extend(9u32.to_le_bytes());
            FieldExample {
                bytes: b,
                rust_lit: "Some(9)".into(),
                json_lit: "9".into(),
                ts_lit: "9".into(),
            }
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{MutatingMode, SourceLocation, Variant};

    #[test]
    fn example_for_custom_field_is_none() {
        assert!(example_for(&FieldType::Custom("IssuePayloadCodec".to_string())).is_none());
    }

    #[test]
    fn example_for_node_id_matches_its_wire_width() {
        let ex = example_for(&FieldType::Standard("NodeId")).unwrap();
        assert_eq!(ex.bytes.len(), 8);
        assert_eq!(ex.bytes, 7u64.to_le_bytes().to_vec());
    }

    #[test]
    fn example_for_option_node_id_encodes_presence_byte_then_value() {
        let ex = example_for(&FieldType::Standard("Option<NodeId>")).unwrap();
        assert_eq!(ex.bytes.len(), 9);
        assert_eq!(ex.bytes[0], 1);
    }

    #[test]
    fn example_for_option_usize_encodes_presence_byte_then_u32_value() {
        let ex = example_for(&FieldType::Standard("Option<usize>")).unwrap();
        assert_eq!(ex.bytes.len(), 5);
        assert_eq!(ex.bytes[0], 1);
    }

    #[test]
    fn generate_golden_skips_variants_with_a_custom_field() {
        let source = EventSource {
            enum_name: "TestEvent".to_string(),
            location: SourceLocation {
                rust_file: "test.rs".to_string(),
                stem: "test".to_string(),
            },
            mutating_mode: MutatingMode::PerVariant,
            variants: vec![
                Variant {
                    name: "Standard".to_string(),
                    tag: 1,
                    mutating: false,
                    shape: VariantShape::NewtypeTuple(Field {
                        name: "id".to_string(),
                        ty: FieldType::Standard("NodeId"),
                    }),
                },
                Variant {
                    name: "Custom".to_string(),
                    tag: 2,
                    mutating: false,
                    shape: VariantShape::NewtypeTuple(Field {
                        name: "value".to_string(),
                        ty: FieldType::Custom("IssuePayloadCodec".to_string()),
                    }),
                },
            ],
        };
        let entries = generate_golden(&source);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].variant_name, "Standard");
    }
}
