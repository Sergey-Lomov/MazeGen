//! Declarative `--check` invariants (plan section "Обязательные проверки") — never parses or
//! diffs a hand-written function body, only `Schema`-level facts: tag uniqueness, tag 0 reserved,
//! every variant tagged, every codec reference known. `detect_breaking_changes` is the one
//! exception: it *does* scan the previously generated `_wire.rs` text (never a hand-written
//! file — see plan section 5, `codegen`'s only read of its own prior output), because the whole
//! point of that check is comparing today's `Schema` against yesterday's generated layout.

use std::collections::HashSet;

use crate::naming::to_screaming_snake;
use crate::schema::{EventSource, Field, FieldType, VariantShape};

pub struct CheckError(pub String);

pub fn check_source(source: &EventSource) -> Vec<CheckError> {
    let mut errors = Vec::new();
    let mut seen_tags = HashSet::new();

    for v in &source.variants {
        if v.tag == 0 {
            errors.push(CheckError(format!(
                "{}::{}: tag 0 is reserved for TAG_SCOPE and must never be assigned",
                source.enum_name, v.name
            )));
        }
        if !seen_tags.insert(v.tag) {
            errors.push(CheckError(format!(
                "{}::{}: duplicate wire tag {}",
                source.enum_name, v.name, v.tag
            )));
        }
        check_shape_field_types(source, v, &mut errors);
    }

    errors
}

fn check_shape_field_types(
    source: &EventSource,
    v: &crate::schema::Variant,
    errors: &mut Vec<CheckError>,
) {
    let fields: Vec<&FieldType> = match &v.shape {
        VariantShape::Unit => vec![],
        VariantShape::NewtypeTuple(f) => vec![&f.ty],
        VariantShape::Struct(fields) => fields.iter().map(|f| &f.ty).collect(),
    };
    for ty in fields {
        if let FieldType::Custom(name) = ty
            && crate::codecs::lookup(name).is_none()
        {
            errors.push(CheckError(format!(
                "{}::{}: unknown codec '{}'",
                source.enum_name, v.name, name
            )));
        }
    }
}

/// Compares a freshly generated file's tag/layout facts against a previously generated file on
/// disk (if any) — flags both a changed tag *and* a changed field set/order for an *existing*
/// variant name as a possible breaking wire change (plan section 9's "смена тега **или**
/// изменение порядка/состава полей"). Does not block generation; only prints a warning the caller
/// surfaces to the user.
pub fn detect_breaking_changes(old_text: &str, new_source: &EventSource) -> Vec<String> {
    let mut warnings = Vec::new();
    for v in &new_source.variants {
        if let Some(old_tag) = old_tag_for(old_text, &v.name)
            && old_tag != v.tag
        {
            warnings.push(format!(
                    "tag changed for variant {}::{} ({} -> {}) — confirm this is an intentional wire-format break",
                    new_source.enum_name, v.name, old_tag, v.tag
                ));
        }
        if let Some(old_call_seq) =
            old_write_call_sequence(old_text, &new_source.enum_name, &v.name)
        {
            let new_call_seq = write_call_sequence(&v.shape);
            if old_call_seq != new_call_seq {
                warnings.push(format!(
                    "field layout changed for variant {}::{} ({} -> {}) — confirm this is an intentional wire-format break",
                    new_source.enum_name, v.name, old_call_seq.join(", "), new_call_seq.join(", ")
                ));
            }
        }
    }
    warnings
}

fn old_tag_for(old_text: &str, variant_name: &str) -> Option<u16> {
    let marker = format!("pub const {}: u16 = ", to_screaming_snake(variant_name));
    let pos = old_text.find(&marker)?;
    let rest = &old_text[pos + marker.len()..];
    rest.split(';').next().and_then(|s| s.trim().parse().ok())
}

/// The ordered sequence of `write_*(out, ...)` calls a variant's `encode_payload` match arm would
/// emit — the observable wire-layout fingerprint `rust_emitter::emit_field_writes` produces for a
/// given `VariantShape`. Comparing this sequence (not just field count) catches a reorder, a type
/// swap that keeps the same field count, or an added/removed field — anything that shifts byte
/// offsets for this variant's payload.
fn write_call_sequence(shape: &VariantShape) -> Vec<String> {
    let field_ty = |ty: &FieldType| -> String {
        match ty {
            FieldType::Standard(t) => crate::type_map::lookup(t)
                .map(|m| m.rust_write_fn.to_string())
                .unwrap_or_default(),
            FieldType::Custom(name) => crate::codecs::lookup(name)
                .map(|c| c.rust_write_fn.to_string())
                .unwrap_or_default(),
        }
    };
    match shape {
        VariantShape::Unit => Vec::new(),
        VariantShape::NewtypeTuple(Field { ty, .. }) => vec![field_ty(ty)],
        VariantShape::Struct(fields) => fields.iter().map(|f| field_ty(&f.ty)).collect(),
    }
}

/// Extracts the same call sequence from the *previously generated* file's `encode_payload` match
/// arm for `variant_name`, by locating `EnumName::VariantName` (unit) or `EnumName::VariantName{`/
/// `EnumName::VariantName(` (struct/tuple) inside the arm patterns and reading the `write_*(out,`
/// calls up to the arm's closing `}`. Text-scanning rather than re-parsing with `syn` — the input
/// is `codegen`'s own previously generated, mechanically uniform output (see module doc), not
/// arbitrary Rust, so the fixed shape `rust_emitter` always produces is a safe assumption here.
/// Finds `marker` in `text` starting at `from`, skipping any occurrence immediately followed by
/// an identifier character (so searching for `SrcExhausted` doesn't match inside
/// `SrcExhaustedEmptyPool`, which starts with the same text). Returns the byte offset of the
/// matched marker's start, not an occurrence that turned out to be a longer identifier's prefix.
fn find_whole_marker(text: &str, marker: &str, from: usize) -> Option<usize> {
    let mut start = from;
    loop {
        let rel = text[start..].find(marker)?;
        let pos = start + rel;
        let after = pos + marker.len();
        let boundary_ok = text
            .as_bytes()
            .get(after)
            .is_none_or(|&b| !(b.is_ascii_alphanumeric() || b == b'_'));
        if boundary_ok {
            return Some(pos);
        }
        start = after;
    }
}

fn old_write_call_sequence(
    old_text: &str,
    enum_name: &str,
    variant_name: &str,
) -> Option<Vec<String>> {
    let arm_marker = format!("{enum_name}::{variant_name}");
    // `encode_payload`'s match starts after `type_id`'s match — search from the *second*
    // occurrence of the arm marker (the first is `type_id`'s non-binding arm) to land inside
    // `encode_payload`'s body, where the actual `write_*` calls live. Each occurrence must not be
    // immediately followed by an identifier character — plain `find` would let e.g.
    // `SrcExhausted` match inside `SrcExhaustedEmptyPool`'s own arm, since the shorter name is a
    // prefix of the longer one.
    let first = find_whole_marker(old_text, &arm_marker, 0)?;
    let second = find_whole_marker(old_text, &arm_marker, first + arm_marker.len())?;
    let arm_start = second;
    let after_pattern = &old_text[arm_start..];
    let body_start = after_pattern.find("=> {")? + "=> {".len();
    let body = &after_pattern[body_start..];
    // `rustfmt` compacts an empty arm from `=> {\n}` to `=> {}`. Without this fast path the
    // newline search below skips into the following arm and mistakes its field writes for this
    // unit variant's payload.
    if body.starts_with('}') {
        return Some(Vec::new());
    }
    let body_end = body.find("\n            }")?;
    let arm_body = &body[..body_end];

    let mut calls = Vec::new();
    for line in arm_body.lines() {
        let line = line.trim();
        if let Some(paren) = line.find('(') {
            let fn_name = &line[..paren];
            if fn_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !fn_name.is_empty()
            {
                calls.push(fn_name.to_string());
            }
        }
    }
    Some(calls)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{MutatingMode, SourceLocation, Variant, VariantShape};

    fn source(variants: Vec<Variant>) -> EventSource {
        EventSource {
            enum_name: "TestEvent".to_string(),
            location: SourceLocation {
                rust_file: "test.rs".to_string(),
                stem: "test".to_string(),
            },
            mutating_mode: MutatingMode::PerVariant,
            variants,
        }
    }

    fn unit_variant(name: &str, tag: u16) -> Variant {
        Variant {
            name: name.to_string(),
            tag,
            mutating: false,
            shape: VariantShape::Unit,
        }
    }

    #[test]
    fn tag_zero_is_rejected() {
        let src = source(vec![unit_variant("A", 0)]);
        let errors = check_source(&src);
        assert!(errors.iter().any(|e| e.0.contains("tag 0 is reserved")));
    }

    #[test]
    fn duplicate_tags_are_rejected() {
        let src = source(vec![unit_variant("A", 1), unit_variant("B", 1)]);
        let errors = check_source(&src);
        assert!(errors.iter().any(|e| e.0.contains("duplicate wire tag")));
    }

    #[test]
    fn unique_nonzero_tags_pass() {
        let src = source(vec![unit_variant("A", 1), unit_variant("B", 2)]);
        assert!(check_source(&src).is_empty());
    }

    #[test]
    fn unknown_codec_is_rejected() {
        let src = source(vec![Variant {
            name: "A".to_string(),
            tag: 1,
            mutating: false,
            shape: VariantShape::NewtypeTuple(crate::schema::Field {
                name: "value".to_string(),
                ty: FieldType::Custom("NotRegistered".to_string()),
            }),
        }]);
        let errors = check_source(&src);
        assert!(errors.iter().any(|e| e.0.contains("unknown codec")));
    }

    #[test]
    fn detect_breaking_changes_flags_a_changed_tag() {
        let old_text = "pub const A: u16 = 1;\n";
        let src = source(vec![unit_variant("A", 2)]);
        let warnings = detect_breaking_changes(old_text, &src);
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("tag changed") && w.contains("1 -> 2"))
        );
    }

    #[test]
    fn detect_breaking_changes_is_silent_when_tag_unchanged() {
        let old_text = "pub const A: u16 = 1;\n";
        let src = source(vec![unit_variant("A", 1)]);
        assert!(detect_breaking_changes(old_text, &src).is_empty());
    }

    #[test]
    fn detects_no_layout_change_for_a_rustfmt_compacted_empty_arm() {
        let old_text = r#"
            TestEvent::DeadEnd => wire_tags::DEAD_END,
            TestEvent::Other => wire_tags::OTHER,
            TestEvent::DeadEnd => {}
            TestEvent::Other(__field0) => {
                write_node_id(out, *__field0);
            }
        "#;

        assert_eq!(
            old_write_call_sequence(old_text, "TestEvent", "DeadEnd"),
            Some(Vec::new())
        );
    }

    fn newtype_variant(name: &str, tag: u16, field_name: &str, ty: FieldType) -> Variant {
        Variant {
            name: name.to_string(),
            tag,
            mutating: false,
            shape: VariantShape::NewtypeTuple(Field {
                name: field_name.to_string(),
                ty,
            }),
        }
    }

    fn struct_variant(name: &str, tag: u16, fields: Vec<Field>) -> Variant {
        Variant {
            name: name.to_string(),
            tag,
            mutating: false,
            shape: VariantShape::Struct(fields),
        }
    }

    #[test]
    fn detect_breaking_changes_flags_a_field_added_to_a_struct_variant() {
        let old_src = source(vec![struct_variant(
            "Moved",
            1,
            vec![Field {
                name: "from".to_string(),
                ty: FieldType::Standard("NodeId"),
            }],
        )]);
        let old_text = crate::rust_emitter::generate_rust_wire_file(&old_src);
        let new_src = source(vec![struct_variant(
            "Moved",
            1,
            vec![
                Field {
                    name: "from".to_string(),
                    ty: FieldType::Standard("NodeId"),
                },
                Field {
                    name: "to".to_string(),
                    ty: FieldType::Standard("NodeId"),
                },
            ],
        )]);
        let warnings = detect_breaking_changes(&old_text, &new_src);
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("field layout changed") && w.contains("Moved"))
        );
    }

    #[test]
    fn detect_breaking_changes_flags_reordered_struct_fields() {
        let old_src = source(vec![struct_variant(
            "Pair",
            1,
            vec![
                Field {
                    name: "a".to_string(),
                    ty: FieldType::Standard("NodeId"),
                },
                Field {
                    name: "b".to_string(),
                    ty: FieldType::Standard("bool"),
                },
            ],
        )]);
        let old_text = crate::rust_emitter::generate_rust_wire_file(&old_src);
        // Same field set, swapped order — same field count, still a wire-breaking change since
        // byte offsets shift; a naive "field count only" check would miss this.
        let new_src = source(vec![struct_variant(
            "Pair",
            1,
            vec![
                Field {
                    name: "b".to_string(),
                    ty: FieldType::Standard("bool"),
                },
                Field {
                    name: "a".to_string(),
                    ty: FieldType::Standard("NodeId"),
                },
            ],
        )]);
        let warnings = detect_breaking_changes(&old_text, &new_src);
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("field layout changed") && w.contains("Pair"))
        );
    }

    #[test]
    fn detect_breaking_changes_is_silent_when_struct_fields_are_unchanged() {
        let src = source(vec![struct_variant(
            "Pair",
            1,
            vec![
                Field {
                    name: "a".to_string(),
                    ty: FieldType::Standard("NodeId"),
                },
                Field {
                    name: "b".to_string(),
                    ty: FieldType::Standard("bool"),
                },
            ],
        )]);
        let old_text = crate::rust_emitter::generate_rust_wire_file(&src);
        assert!(detect_breaking_changes(&old_text, &src).is_empty());
    }

    /// Regression test: `SrcExhausted` is a text prefix of `SrcExhaustedEmptyPool` — an earlier
    /// version of `old_write_call_sequence` used plain `str::find`, which matched the shorter
    /// name's search *inside* the longer variant's own arm and produced a bogus "field layout
    /// changed" warning for an unmodified source.
    #[test]
    fn detect_breaking_changes_is_silent_for_a_variant_name_that_prefixes_another() {
        let src = source(vec![
            struct_variant(
                "SrcExhaustedEmptyPool",
                1,
                vec![Field {
                    name: "src".to_string(),
                    ty: FieldType::Standard("NodeId"),
                }],
            ),
            struct_variant(
                "SrcExhausted",
                2,
                vec![Field {
                    name: "src".to_string(),
                    ty: FieldType::Standard("NodeId"),
                }],
            ),
        ]);
        let old_text = crate::rust_emitter::generate_rust_wire_file(&src);
        assert!(detect_breaking_changes(&old_text, &src).is_empty());
    }

    #[test]
    fn detect_breaking_changes_flags_a_newtype_field_type_swap() {
        let old_src = source(vec![newtype_variant(
            "Selected",
            1,
            "id",
            FieldType::Standard("NodeId"),
        )]);
        let old_text = crate::rust_emitter::generate_rust_wire_file(&old_src);
        let new_src = source(vec![newtype_variant(
            "Selected",
            1,
            "id",
            FieldType::Standard("u32"),
        )]);
        let warnings = detect_breaking_changes(&old_text, &new_src);
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("field layout changed") && w.contains("Selected"))
        );
    }
}
