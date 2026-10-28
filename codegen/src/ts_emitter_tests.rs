use super::*;
use crate::schema::{Field, SourceLocation, Variant};

fn source(mutating_mode: MutatingMode, variants: Vec<Variant>) -> EventSource {
    EventSource {
        enum_name: "FooEvent".to_string(),
        location: SourceLocation {
            rust_file: "foo.rs".to_string(),
            stem: "foo".to_string(),
        },
        mutating_mode,
        variants,
    }
}

#[test]
fn wire_imports_include_expect_len_for_a_unit_variant_but_no_type_read_fns() {
    let src = source(
        MutatingMode::PerVariant,
        vec![Variant {
            name: "Bar".to_string(),
            tag: 1,
            mutating: false,
            shape: VariantShape::Unit,
        }],
    );
    let mut out = String::new();
    emit_wire_imports(&mut out, &src);
    assert_eq!(out, "import { expectLen } from \"../wire\";\n");
}

#[test]
fn wire_imports_include_the_readfn_for_a_newtype_tuple_standard_field() {
    let src = source(
        MutatingMode::PerVariant,
        vec![Variant {
            name: "Bar".to_string(),
            tag: 1,
            mutating: false,
            shape: VariantShape::NewtypeTuple(Field {
                name: "id".to_string(),
                ty: FieldType::Standard("NodeId"),
            }),
        }],
    );
    let mut out = String::new();
    emit_wire_imports(&mut out, &src);
    assert_eq!(out, "import { expectLen, readNodeId } from \"../wire\";\n");
}

/// `Vec<NodeId>` is `WireWidth::LengthPrefixed` — a source with only such a field never needs
/// `expectLen` at all, since there's no fixed total payload width to check against.
#[test]
fn wire_imports_omit_expect_len_for_a_length_prefixed_only_field() {
    let src = source(
        MutatingMode::PerVariant,
        vec![Variant {
            name: "Bar".to_string(),
            tag: 1,
            mutating: false,
            shape: VariantShape::NewtypeTuple(Field {
                name: "ids".to_string(),
                ty: FieldType::Standard("Vec<NodeId>"),
            }),
        }],
    );
    let mut out = String::new();
    emit_wire_imports(&mut out, &src);
    assert_eq!(out, "import { readNodeIdList } from \"../wire\";\n");
}

#[test]
fn codec_imports_are_empty_when_no_variant_uses_a_custom_field() {
    let src = source(
        MutatingMode::PerVariant,
        vec![Variant {
            name: "Bar".to_string(),
            tag: 1,
            mutating: false,
            shape: VariantShape::Unit,
        }],
    );
    let mut out = String::new();
    emit_codec_imports(&mut out, &src);
    assert_eq!(out, "");
}

#[test]
fn codec_imports_include_the_readfn_and_named_type_for_a_custom_field() {
    let src = source(
        MutatingMode::PerVariant,
        vec![Variant {
            name: "Bar".to_string(),
            tag: 1,
            mutating: false,
            shape: VariantShape::NewtypeTuple(Field {
                name: "payload".to_string(),
                ty: FieldType::Custom("IssuePayloadCodec".to_string()),
            }),
        }],
    );
    let mut out = String::new();
    emit_codec_imports(&mut out, &src);
    assert_eq!(
        out,
        "import { readIssuePayload } from \"../fooCustom\";\nimport type { IssuePayload } from \"../fooCustom\";\n"
    );
}

#[test]
fn emit_type_renders_one_union_arm_per_variant_shape() {
    let src = source(
        MutatingMode::PerVariant,
        vec![
            Variant {
                name: "Unit".to_string(),
                tag: 1,
                mutating: false,
                shape: VariantShape::Unit,
            },
            Variant {
                name: "Tuple".to_string(),
                tag: 2,
                mutating: false,
                shape: VariantShape::NewtypeTuple(Field {
                    name: "id".to_string(),
                    ty: FieldType::Standard("NodeId"),
                }),
            },
            Variant {
                name: "Struct".to_string(),
                tag: 3,
                mutating: false,
                shape: VariantShape::Struct(vec![Field {
                    name: "from".to_string(),
                    ty: FieldType::Standard("NodeId"),
                }]),
            },
        ],
    );
    let mut out = String::new();
    emit_type(&mut out, &src);
    assert_eq!(
        out,
        "export type FooEvent =\n  | { kind: \"Unit\" }\n  | { kind: \"Tuple\"; id: bigint }\n  | { kind: \"Struct\"; from: bigint };\n\n"
    );
}

/// Pins the field-name collision fix made this session (`QcEvent::IssuesMerged.kind` renamed
/// to `issue_kind` — the field name `kind` would otherwise clash with the discriminant field
/// every union arm already carries) at the emitter level: a struct field literally named
/// `kind` renders as `kind: <type>` right next to the discriminant, which is exactly the
/// TS-side symptom that prompted the rename — this test documents why the emitter itself does
/// NOT guard against it (no dedup/rename logic here), so a future regression on the Rust side
/// (re-adding a field named `kind`) reintroduces the same bug rather than being caught here.
#[test]
fn emit_type_does_not_rename_a_field_literally_called_kind() {
    let src = source(
        MutatingMode::PerVariant,
        vec![Variant {
            name: "Merged".to_string(),
            tag: 1,
            mutating: false,
            shape: VariantShape::Struct(vec![Field {
                name: "kind".to_string(),
                ty: FieldType::Standard("NodeId"),
            }]),
        }],
    );
    let mut out = String::new();
    emit_type(&mut out, &src);
    assert!(
        out.contains("{ kind: \"Merged\"; kind: bigint }"),
        "emitter renders the collision verbatim: {out}"
    );
}

#[test]
fn emit_decode_variant_for_unit_checks_zero_length_before_returning() {
    let v = Variant {
        name: "Bar".to_string(),
        tag: 1,
        mutating: false,
        shape: VariantShape::Unit,
    };
    let mut out = String::new();
    emit_decode_variant(&mut out, &v);
    assert_eq!(
        out,
        "      expectLen(tag, bytes, 0);\n      return { kind: \"Bar\" };\n"
    );
}

#[test]
fn emit_decode_variant_for_newtype_tuple_checks_length_before_reading() {
    let v = Variant {
        name: "Bar".to_string(),
        tag: 1,
        mutating: false,
        shape: VariantShape::NewtypeTuple(Field {
            name: "id".to_string(),
            ty: FieldType::Standard("NodeId"),
        }),
    };
    let mut out = String::new();
    emit_decode_variant(&mut out, &v);
    // `expectLen` must appear before the read statement — a too-short buffer must fail with
    // the payload_len message, not a raw DataView-out-of-bounds error (regression this
    // session fixed: the field used to be read before the length check).
    let expect_pos = out.find("expectLen").expect("must call expectLen");
    let read_pos = out.find("readNodeId").expect("must call readNodeId");
    assert!(
        expect_pos < read_pos,
        "expectLen must run before the field read: {out}"
    );
}

/// A struct variant with a mix of fixed-width and length-prefixed fields has no single
/// constant payload length, so `expectLen` must be omitted entirely — only the individual
/// length-prefixed reads (`readStr`, etc.) validate their own bounds.
#[test]
fn emit_decode_variant_for_struct_with_a_variable_length_field_omits_expect_len() {
    let v = Variant {
        name: "Bar".to_string(),
        tag: 1,
        mutating: false,
        shape: VariantShape::Struct(vec![
            Field {
                name: "id".to_string(),
                ty: FieldType::Standard("NodeId"),
            },
            Field {
                name: "label".to_string(),
                ty: FieldType::Standard("String"),
            },
        ]),
    };
    let mut out = String::new();
    emit_decode_variant(&mut out, &v);
    assert!(
        !out.contains("expectLen"),
        "variable-length struct must not emit expectLen: {out}"
    );
    assert!(out.contains("readNodeId(bytes, 0)"));
    assert!(out.contains("readStr(bytes, 0 + 8)"));
}

#[test]
fn emit_decode_variant_for_all_fixed_struct_emits_expect_len_with_the_summed_width() {
    let v = Variant {
        name: "Bar".to_string(),
        tag: 1,
        mutating: false,
        shape: VariantShape::Struct(vec![
            Field {
                name: "from".to_string(),
                ty: FieldType::Standard("NodeId"),
            },
            Field {
                name: "to".to_string(),
                ty: FieldType::Standard("NodeId"),
            },
            Field {
                name: "ok".to_string(),
                ty: FieldType::Standard("bool"),
            },
        ]),
    };
    let mut out = String::new();
    emit_decode_variant(&mut out, &v);
    assert!(
        out.contains("expectLen(tag, bytes, 17);"),
        "8 + 8 + 1 = 17: {out}"
    );
}

#[test]
fn is_mutating_always_mutating_mode_ignores_the_event_parameter() {
    let src = source(
        MutatingMode::AlwaysMutating,
        vec![Variant {
            name: "Bar".to_string(),
            tag: 1,
            mutating: true,
            shape: VariantShape::Unit,
        }],
    );
    let mut out = String::new();
    emit_is_mutating(&mut out, &src);
    assert!(
        out.contains("isMutatingFooEvent(_event: FooEvent)"),
        "unused param must be named _event: {out}"
    );
    assert!(out.contains("return true;"));
}

#[test]
fn is_mutating_per_variant_with_no_mutating_variant_ignores_the_event_parameter() {
    let src = source(
        MutatingMode::PerVariant,
        vec![Variant {
            name: "Bar".to_string(),
            tag: 1,
            mutating: false,
            shape: VariantShape::Unit,
        }],
    );
    let mut out = String::new();
    emit_is_mutating(&mut out, &src);
    assert!(
        out.contains("isMutatingFooEvent(_event: FooEvent)"),
        "unused param must be named _event: {out}"
    );
    assert!(out.contains("return false;"));
}

#[test]
fn is_mutating_per_variant_with_a_mutating_variant_names_the_event_parameter() {
    let src = source(
        MutatingMode::PerVariant,
        vec![Variant {
            name: "Bar".to_string(),
            tag: 1,
            mutating: true,
            shape: VariantShape::Unit,
        }],
    );
    let mut out = String::new();
    emit_is_mutating(&mut out, &src);
    assert!(out.contains("isMutatingFooEvent(event: FooEvent)"));
    assert!(out.contains("event.kind === \"Bar\""));
}
