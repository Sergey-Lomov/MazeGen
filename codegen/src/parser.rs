//! Reads `#[derive(WireEvent)]`-annotated enums and their `#[wire(...)]`/`#[wire_event(...)]`
//! attributes into a `Schema` — see plan section "Архитектурный принцип": this module never reads
//! a generated `_wire.rs` file, only original source files under `maze-core/src`.

use std::fs;
use std::path::{Path, PathBuf};

use syn::punctuated::Punctuated;
use syn::{Expr, Fields, Item, Lit, Meta, Token};

use crate::naming::to_snake_case;
use crate::schema::{
    EventSource, Field, FieldType, MutatingMode, SourceLocation, Variant, VariantShape,
};
use crate::{codecs, type_map};

#[derive(Debug)]
pub struct ParseError {
    pub file: PathBuf,
    pub message: String,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.file.display(), self.message)
    }
}

/// Recursively finds every `.rs` file under `root` and parses each for `#[derive(WireEvent)]`
/// enums. Not a hardcoded file list (plan section 6) — an 8th source is picked up automatically.
pub fn discover_sources(root: &Path) -> Result<Vec<EventSource>, ParseError> {
    let mut sources = Vec::new();
    for entry in walk_rs_files(root) {
        let text = fs::read_to_string(&entry).map_err(|e| ParseError {
            file: entry.clone(),
            message: e.to_string(),
        })?;
        let file = syn::parse_file(&text).map_err(|e| ParseError {
            file: entry.clone(),
            message: e.to_string(),
        })?;
        for item in &file.items {
            if let Item::Enum(item_enum) = item
                && has_derive_wire_event(&item_enum.attrs)
            {
                sources.push(parse_enum(&entry, root, item_enum)?);
            }
        }
    }
    Ok(sources)
}

fn walk_rs_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    out
}

fn has_derive_wire_event(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|a| {
        a.path().is_ident("derive")
            && a.parse_args_with(
                syn::punctuated::Punctuated::<syn::Path, syn::Token![,]>::parse_terminated,
            )
            .is_ok_and(|paths| {
                paths
                    .iter()
                    .any(|p| p.segments.last().is_some_and(|s| s.ident == "WireEvent"))
            })
    })
}

fn parse_enum(
    file: &Path,
    root: &Path,
    item_enum: &syn::ItemEnum,
) -> Result<EventSource, ParseError> {
    let enum_name = item_enum.ident.to_string();
    let mutating_mode = if has_wire_event_flag(&item_enum.attrs, "always_mutating") {
        MutatingMode::AlwaysMutating
    } else {
        MutatingMode::PerVariant
    };

    let mut variants = Vec::new();
    for v in &item_enum.variants {
        variants.push(parse_variant(file, &enum_name, v, mutating_mode)?);
    }

    // Relative to `root` (`maze-core/src`) — e.g. `generation/recursive_backtracker.rs`, not
    // `maze-core/src/generation/recursive_backtracker.rs`. `main.rs` joins this back onto
    // `maze-core/src` when writing the `_wire.rs` sibling.
    let rel_file = file
        .strip_prefix(root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/");
    let stem = to_snake_case(enum_name.strip_suffix("Event").unwrap_or(&enum_name));
    Ok(EventSource {
        enum_name,
        location: SourceLocation {
            rust_file: rel_file,
            stem,
        },
        mutating_mode,
        variants,
    })
}

fn has_wire_event_flag(attrs: &[syn::Attribute], flag: &str) -> bool {
    attrs.iter().any(|a| {
        a.path().is_ident("wire_event") && parsed_wire_meta(a).iter().any(|m| is_bare_flag(m, flag))
    })
}

fn parse_variant(
    file: &Path,
    enum_name: &str,
    v: &syn::Variant,
    mutating_mode: MutatingMode,
) -> Result<Variant, ParseError> {
    let name = v.ident.to_string();
    let err = |msg: String| ParseError {
        file: file.to_path_buf(),
        message: format!("{enum_name}::{name}: {msg}"),
    };

    let tag = find_wire_tag(&v.attrs).ok_or_else(|| err("missing #[wire(tag = N)]".to_string()))?;
    let mutating_flag = has_wire_flag(&v.attrs, "mutating");

    match mutating_mode {
        MutatingMode::AlwaysMutating if mutating_flag => {
            return Err(err(
                "#[wire(mutating)] conflicts with #[wire_event(always_mutating)] on the enum"
                    .to_string(),
            ));
        }
        _ => {}
    }

    let shape = match &v.fields {
        Fields::Unit => VariantShape::Unit,
        Fields::Unnamed(fields) if fields.unnamed.len() == 1 => {
            let f = &fields.unnamed[0];
            // A newtype-tuple variant has no separate per-field attribute position distinct from
            // the variant's own — `#[wire(tag = N, custom = "...", name = "...")]` sits on the
            // variant, so `custom`/`name` (like `tag`/`mutating`) are read from `v.attrs`, not
            // `f.attrs`.
            let ty = resolve_field_type(&v.attrs, &f.ty, &err)?;
            let field_name = find_wire_name(&v.attrs)
                .ok_or_else(|| err("missing #[wire(name = \"...\")] — every tuple-variant field needs an explicit name so generated TS/Rust field access reads meaningfully".to_string()))?;
            VariantShape::NewtypeTuple(Field {
                name: field_name,
                ty,
            })
        }
        Fields::Unnamed(fields) => {
            return Err(err(format!(
                "tuple variant with {} fields is not a whitelisted shape (need exactly 1, or use a struct variant)",
                fields.unnamed.len()
            )));
        }
        Fields::Named(fields) => {
            let mut out = Vec::new();
            for f in &fields.named {
                let field_name = f.ident.as_ref().unwrap().to_string();
                let ty = resolve_field_type(&f.attrs, &f.ty, &err)?;
                out.push(Field {
                    name: field_name,
                    ty,
                });
            }
            VariantShape::Struct(out)
        }
    };

    Ok(Variant {
        name,
        tag,
        mutating: mutating_flag || mutating_mode == MutatingMode::AlwaysMutating,
        shape,
    })
}

fn resolve_field_type(
    attrs: &[syn::Attribute],
    ty: &syn::Type,
    err: &impl Fn(String) -> ParseError,
) -> Result<FieldType, ParseError> {
    if let Some(codec_name) = find_wire_custom(attrs) {
        return codecs::lookup(&codec_name)
            .map(|_| FieldType::Custom(codec_name.clone()))
            .ok_or_else(|| {
                err(format!(
                    "unknown codec '{codec_name}' — not registered in codegen/src/codecs.rs"
                ))
            });
    }
    // `quote!` renders e.g. `Vec < NodeId >` before whitespace stripping collapses the generic
    // punctuation spacing away — `type_map`'s entries are plain strings like `"Vec<NodeId>"`, no
    // further normalization (no `::`-qualified path handling) is done or needed today: every
    // standard type in `type_map.rs` is referenced unqualified in source. A future field written
    // with a qualified path (e.g. `std::collections::HashMap<...>` in bare-field position rather
    // than behind a `#[wire(custom = "...")]` codec) will fail this lookup with the message below
    // rather than being silently normalized — add explicit handling here if that's ever needed.
    let ty_str = quote::quote!(#ty).to_string().replace(' ', "");
    type_map::lookup(&ty_str)
        .map(|m| FieldType::Standard(m.rust_type))
        .ok_or_else(|| err(format!("field type '{ty_str}' is neither a standard type nor #[wire(custom = \"...\")]-annotated")))
}

fn find_wire_tag(attrs: &[syn::Attribute]) -> Option<u16> {
    wire_metas(attrs)
        .iter()
        .find_map(|m| wire_int_value(m, "tag"))
}

fn has_wire_flag(attrs: &[syn::Attribute], flag: &str) -> bool {
    wire_metas(attrs).iter().any(|m| is_bare_flag(m, flag))
}

fn find_wire_name(attrs: &[syn::Attribute]) -> Option<String> {
    find_wire_string_attr(attrs, "name")
}

fn find_wire_custom(attrs: &[syn::Attribute]) -> Option<String> {
    find_wire_string_attr(attrs, "custom")
}

/// Reads `#[wire(<key> = "...")]`'s string value — shared by `custom` and `name`, the two
/// `#[wire(...)]` sub-attributes whose value is a quoted string rather than a bare token
/// (`tag`/`mutating`).
fn find_wire_string_attr(attrs: &[syn::Attribute], key: &str) -> Option<String> {
    wire_metas(attrs)
        .iter()
        .find_map(|m| wire_str_value(m, key))
}

/// Collects every `Meta` item inside every `#[wire(...)]` attribute on `attrs`, structurally
/// parsed via `syn`'s own comma-separated `Meta` list grammar — not string-split, so a value like
/// `name = "a, b"` or a key that's a prefix of another (`name` vs. a hypothetical `named`) can't
/// be misparsed the way naive `.split(',')` scanning could.
fn wire_metas(attrs: &[syn::Attribute]) -> Vec<Meta> {
    attrs
        .iter()
        .filter(|a| a.path().is_ident("wire"))
        .flat_map(parsed_wire_meta)
        .collect()
}

fn parsed_wire_meta(attr: &syn::Attribute) -> Vec<Meta> {
    let Meta::List(list) = &attr.meta else {
        return Vec::new();
    };
    list.parse_args_with(Punctuated::<Meta, Token![,]>::parse_terminated)
        .map(|p| p.into_iter().collect())
        .unwrap_or_default()
}

/// `true` if `meta` is the bare path `flag` (e.g. `mutating` in `#[wire(mutating)]`) — a `Meta::Path`
/// with no `=`/`(...)`, matched by identifier rather than substring so `flag`-prefixed names never
/// false-match (structurally impossible here anyway, since `syn` already segments each comma-item).
fn is_bare_flag(meta: &Meta, flag: &str) -> bool {
    matches!(meta, Meta::Path(p) if p.is_ident(flag))
}

/// `Some(n)` if `meta` is `key = N` (`Meta::NameValue` with an integer literal) with the given key.
fn wire_int_value(meta: &Meta, key: &str) -> Option<u16> {
    let Meta::NameValue(nv) = meta else {
        return None;
    };
    if !nv.path.is_ident(key) {
        return None;
    }
    let Expr::Lit(expr_lit) = &nv.value else {
        return None;
    };
    let Lit::Int(lit_int) = &expr_lit.lit else {
        return None;
    };
    lit_int.base10_parse::<u16>().ok()
}

/// `Some(s)` if `meta` is `key = "s"` (`Meta::NameValue` with a string literal) with the given key.
fn wire_str_value(meta: &Meta, key: &str) -> Option<String> {
    let Meta::NameValue(nv) = meta else {
        return None;
    };
    if !nv.path.is_ident(key) {
        return None;
    }
    let Expr::Lit(expr_lit) = &nv.value else {
        return None;
    };
    let Lit::Str(lit_str) = &expr_lit.lit else {
        return None;
    };
    Some(lit_str.value())
}

#[cfg(test)]
mod parse_enum_tests {
    use super::*;
    use std::path::Path;

    /// Parses `src` as a standalone file and runs it through `parse_enum` on its first (and only)
    /// `#[derive(WireEvent)]` enum — mirrors what `discover_sources` does per-file, without
    /// touching the filesystem.
    fn parse_enum_source(src: &str) -> Result<EventSource, ParseError> {
        let file = syn::parse_file(src).expect("test fixture must be valid Rust");
        let item_enum = file
            .items
            .iter()
            .find_map(|i| match i {
                Item::Enum(e) => Some(e),
                _ => None,
            })
            .expect("test fixture must contain an enum");
        parse_enum(Path::new("fixture.rs"), Path::new("."), item_enum)
    }

    #[test]
    fn unit_variant_needs_only_a_tag() {
        let source = parse_enum_source(
            r#"
            #[derive(WireEvent)]
            enum FooEvent {
                #[wire(tag = 1)]
                Bar,
            }
        "#,
        )
        .expect("should parse");
        assert_eq!(source.variants.len(), 1);
        assert!(matches!(source.variants[0].shape, VariantShape::Unit));
        assert_eq!(source.variants[0].tag, 1);
        assert!(!source.variants[0].mutating);
    }

    #[test]
    fn newtype_tuple_with_standard_type_requires_an_explicit_name() {
        let source = parse_enum_source(
            r#"
            #[derive(WireEvent)]
            enum FooEvent {
                #[wire(tag = 1, name = "id")]
                Bar(NodeId),
            }
        "#,
        )
        .expect("should parse");
        let VariantShape::NewtypeTuple(field) = &source.variants[0].shape else {
            panic!("expected NewtypeTuple")
        };
        assert_eq!(field.name, "id");
        assert!(matches!(field.ty, FieldType::Standard("NodeId")));
    }

    #[test]
    fn newtype_tuple_without_a_name_is_a_parse_error() {
        let err = parse_enum_source(
            r#"
            #[derive(WireEvent)]
            enum FooEvent {
                #[wire(tag = 1)]
                Bar(NodeId),
            }
        "#,
        )
        .expect_err("missing #[wire(name = ...)] must be rejected");
        assert!(
            err.message.contains("name"),
            "error should mention the missing name attribute: {}",
            err.message
        );
    }

    #[test]
    fn variant_without_a_tag_is_a_parse_error() {
        let err = parse_enum_source(
            r#"
            #[derive(WireEvent)]
            enum FooEvent {
                Bar,
            }
        "#,
        )
        .expect_err("missing #[wire(tag = ...)] must be rejected");
        assert!(
            err.message.contains("tag"),
            "error should mention the missing tag: {}",
            err.message
        );
    }

    #[test]
    fn tuple_variant_with_two_fields_is_a_parse_error() {
        let err = parse_enum_source(
            r#"
            #[derive(WireEvent)]
            enum FooEvent {
                #[wire(tag = 1)]
                Bar(NodeId, NodeId),
            }
        "#,
        )
        .expect_err("multi-field tuple variant must be rejected");
        assert!(
            err.message.contains("2 fields"),
            "error should name the field count: {}",
            err.message
        );
    }

    #[test]
    fn unrecognized_field_type_is_a_parse_error() {
        let err = parse_enum_source(
            r#"
            #[derive(WireEvent)]
            enum FooEvent {
                #[wire(tag = 1, name = "x")]
                Bar(SomeUnknownType),
            }
        "#,
        )
        .expect_err("a type absent from type_map and uncoded must be rejected");
        assert!(
            err.message.contains("SomeUnknownType"),
            "error should name the offending type: {}",
            err.message
        );
    }

    #[test]
    fn struct_variant_resolves_every_field_independently() {
        let source = parse_enum_source(
            r#"
            #[derive(WireEvent)]
            enum FooEvent {
                #[wire(tag = 1, mutating)]
                Bar { from: NodeId, to: NodeId, ok: bool },
            }
        "#,
        )
        .expect("should parse");
        let VariantShape::Struct(fields) = &source.variants[0].shape else {
            panic!("expected Struct")
        };
        assert_eq!(fields.len(), 3);
        assert_eq!(fields[0].name, "from");
        assert_eq!(fields[2].name, "ok");
        assert!(source.variants[0].mutating);
    }

    #[test]
    fn always_mutating_enum_rejects_a_per_variant_mutating_flag() {
        let err = parse_enum_source(
            r#"
            #[derive(WireEvent)]
            #[wire_event(always_mutating)]
            enum FooEvent {
                #[wire(tag = 1, mutating)]
                Bar,
            }
        "#,
        )
        .expect_err("per-variant #[wire(mutating)] must conflict with enum-level always_mutating");
        assert!(
            err.message.contains("always_mutating"),
            "error should name the conflicting mode: {}",
            err.message
        );
    }

    #[test]
    fn always_mutating_enum_marks_every_variant_mutating_without_the_flag() {
        let source = parse_enum_source(
            r#"
            #[derive(WireEvent)]
            #[wire_event(always_mutating)]
            enum FooEvent {
                #[wire(tag = 1)]
                Bar,
            }
        "#,
        )
        .expect("should parse");
        assert_eq!(source.mutating_mode, MutatingMode::AlwaysMutating);
        assert!(source.variants[0].mutating);
    }

    #[test]
    fn enum_name_suffix_event_is_stripped_for_the_generated_file_stem() {
        let source = parse_enum_source(
            r#"
            #[derive(WireEvent)]
            enum FooEvent {
                #[wire(tag = 1)]
                Bar,
            }
        "#,
        )
        .expect("should parse");
        assert_eq!(source.location.stem, "foo");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use syn::parse::Parser;

    fn parse_attr(text: &str) -> syn::Attribute {
        syn::Attribute::parse_outer
            .parse_str(text)
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
    }

    fn wire_attr(tokens: &str) -> syn::Attribute {
        parse_attr(&format!("#[wire({tokens})]"))
    }

    #[test]
    fn finds_tag_and_string_values_across_multiple_entries() {
        let attrs = vec![wire_attr(
            r#"tag = 7, mutating, custom = "FooCodec", name = "bar""#,
        )];
        assert_eq!(find_wire_tag(&attrs), Some(7));
        assert!(has_wire_flag(&attrs, "mutating"));
        assert_eq!(find_wire_custom(&attrs), Some("FooCodec".to_string()));
        assert_eq!(find_wire_name(&attrs), Some("bar".to_string()));
    }

    /// Regression: the previous string-split parser matched `key` as a plain prefix of the token
    /// text, so a value string containing `key` as a substring — or a key name that happens to
    /// prefix a longer identifier — risked misparsing. Structural `syn::Meta` matching only
    /// compares the item's own parsed identifier, so this can't happen.
    #[test]
    fn does_not_confuse_a_string_value_that_contains_the_key_name_as_a_substring() {
        let attrs = vec![wire_attr(r#"name = "tag = 99, mutating""#)];
        assert_eq!(
            find_wire_name(&attrs),
            Some("tag = 99, mutating".to_string())
        );
        assert_eq!(find_wire_tag(&attrs), None);
        assert!(!has_wire_flag(&attrs, "mutating"));
    }

    #[test]
    fn missing_key_returns_none() {
        let attrs = vec![wire_attr("tag = 1")];
        assert_eq!(find_wire_name(&attrs), None);
        assert_eq!(find_wire_custom(&attrs), None);
        assert!(!has_wire_flag(&attrs, "mutating"));
    }

    #[test]
    fn always_mutating_flag_is_read_from_wire_event_attribute() {
        let attrs = vec![wire_attr_named("wire_event", "always_mutating")];
        assert!(has_wire_event_flag(&attrs, "always_mutating"));
    }

    fn wire_attr_named(path: &str, tokens: &str) -> syn::Attribute {
        parse_attr(&format!("#[{path}({tokens})]"))
    }
}
