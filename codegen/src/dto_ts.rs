//! Generates TS interfaces/unions from `maze-wasm/src/dto.rs`'s plain `#[derive(Serialize)]`/
//! `#[derive(Deserialize)]` structs and enums — see GitHub issue #366. Independent of the
//! `WireEvent` pipeline (`parser.rs`/`schema.rs`): those model binary wire-encoded event payloads
//! with tags and read/write helper wiring, this models a plain JSON-shaped DTO with no binary wire
//! concerns at all.
//!
//! A struct/enum opts in by carrying `#[derive(Serialize)]` and/or `#[derive(Deserialize)]`.
//! Field/type name divergences from the mechanical Rust->TS mapping are declared explicitly via
//! `#[dto(...)]`:
//! - `#[dto(rename_ts = "...")]` on a struct/enum — emit under a different TS type name.
//! - `#[dto(optional)]` on a field — emit as optional (`field?:`) even though the Rust type isn't
//!   `Option<T>` (e.g. `NodeDto.level`, kept required in Rust but optional in TS so the many
//!   hand-built `NodeDto` test fixtures predating multi-floor generation don't all need updating).
//! - `#[dto(ts_type = "...")]` on a field — use this TS type verbatim instead of resolving the
//!   Rust type structurally (e.g. a field naming a foreign type from another module under a
//!   different TS name, or a `String` that's actually a constrained id union on the TS side).

use std::fs;
use std::path::Path;

use syn::{Fields, GenericArgument, Item, Meta, PathArguments, Type};

use crate::naming::to_snake_case;

#[derive(Debug)]
pub struct DtoParseError {
    pub message: String,
}

#[derive(Debug, Clone)]
pub enum DtoField {
    /// A struct field or named-enum-variant field, resolved to a TS type expression.
    Named { name: String, ts_type: String, optional: bool, doc: Vec<String> },
}

#[derive(Debug, Clone)]
pub enum DtoItem {
    /// A plain struct -> TS interface. `rust_name` is the original Rust identifier (before any
    /// `#[dto(rename_ts = "...")]`) — kept so a *different* item's field referencing this type by
    /// its Rust name can still be resolved to the renamed `ts_name` (see `build_rename_map`).
    Struct { rust_name: String, ts_name: String, doc: Vec<String>, fields: Vec<DtoField> },
    /// A unit-only enum with `#[serde(rename_all = "snake_case")]` -> TS string-literal union.
    StringUnion { rust_name: String, ts_name: String, doc: Vec<String>, variants: Vec<String> },
    /// A `#[serde(tag = "kind", rename_all = "snake_case")]` enum -> TS discriminated union.
    TaggedUnion { rust_name: String, ts_name: String, doc: Vec<String>, tag_variants: Vec<(String, Vec<DtoField>)> },
}

impl DtoItem {
    fn rust_and_ts_name(&self) -> (&str, &str) {
        match self {
            DtoItem::Struct { rust_name, ts_name, .. }
            | DtoItem::StringUnion { rust_name, ts_name, .. }
            | DtoItem::TaggedUnion { rust_name, ts_name, .. } => (rust_name, ts_name),
        }
    }
}

pub fn parse_dto_file(path: &Path) -> Result<Vec<DtoItem>, DtoParseError> {
    let text = fs::read_to_string(path).map_err(|e| DtoParseError { message: format!("{}: {e}", path.display()) })?;
    let file = syn::parse_file(&text).map_err(|e| DtoParseError { message: format!("{}: {e}", path.display()) })?;

    let mut items = Vec::new();
    for item in &file.items {
        match item {
            Item::Struct(s) if has_serde_derive(&s.attrs) => items.push(parse_struct(s)?),
            Item::Enum(e) if has_serde_derive(&e.attrs) => items.push(parse_enum(e)?),
            _ => {}
        }
    }
    Ok(items)
}

fn has_serde_derive(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|a| {
        a.path().is_ident("derive")
            && a.parse_args_with(syn::punctuated::Punctuated::<syn::Path, syn::Token![,]>::parse_terminated)
                .is_ok_and(|paths| paths.iter().any(|p| p.segments.last().is_some_and(|s| s.ident == "Serialize" || s.ident == "Deserialize")))
    })
}

fn parse_struct(s: &syn::ItemStruct) -> Result<DtoItem, DtoParseError> {
    let rust_name = s.ident.to_string();
    let ts_name = rename_ts(&s.attrs).unwrap_or_else(|| rust_name.clone());
    let doc = doc_lines(&s.attrs);
    let Fields::Named(named) = &s.fields else {
        return Err(DtoParseError { message: format!("{}: only named-field structs are supported", s.ident) });
    };
    let mut fields = Vec::new();
    for f in &named.named {
        fields.push(parse_field(f)?);
    }
    Ok(DtoItem::Struct { rust_name, ts_name, doc, fields })
}

fn parse_field(f: &syn::Field) -> Result<DtoField, DtoParseError> {
    let name = f.ident.as_ref().unwrap().to_string();
    let doc = doc_lines(&f.attrs);
    // `#[serde(rename = "...")]` on a field would change the actual wire key while `dto_ts`
    // keeps emitting the Rust field name unchanged — a silent Rust<->TS desync. Not supported
    // today (no field in dto.rs uses it), so fail loudly instead of emitting a wrong key.
    if let Some(renamed) = find_serde_string_value(&f.attrs, "rename") {
        return Err(DtoParseError { message: format!("field `{name}`: #[serde(rename = \"{renamed}\")] is not supported by dto_ts — it would silently desync the wire key from the emitted TS field name. Add explicit support in dto_ts::parse_field, or rename the Rust field itself instead.") });
    }
    let optional_flag = has_dto_flag(&f.attrs, "optional");
    let ts_type = if let Some(explicit) = find_dto_string_attr(&f.attrs, "ts_type") {
        explicit
    } else {
        resolve_type(&f.ty).map_err(|msg| DtoParseError { message: format!("field `{name}`: {msg}") })?
    };
    // Plain `Option<T>` (no `#[serde(default)]`) is nullable but NOT key-optional: serde still
    // requires the JSON key present (as `null` or a value) on Deserialize. Only `#[serde(default)]`
    // (or an explicit `#[dto(optional)]`) makes the key itself omittable.
    let optional = optional_flag || has_serde_flag(&f.attrs, "default");
    Ok(DtoField::Named { name, ts_type, optional, doc })
}

fn has_serde_flag(attrs: &[syn::Attribute], flag: &str) -> bool {
    attrs.iter().filter(|a| a.path().is_ident("serde")).any(|a| {
        let Meta::List(list) = &a.meta else { return false };
        list.parse_args_with(syn::punctuated::Punctuated::<Meta, syn::Token![,]>::parse_terminated)
            .is_ok_and(|metas| metas.iter().any(|m| matches!(m, Meta::Path(p) if p.is_ident(flag))))
    })
}

/// Reads `#[serde(<key> = "...")]`'s string value off any `#[serde(...)]` attribute — used to
/// detect (and reject) `rename`, which `dto_ts` doesn't act on.
fn find_serde_string_value(attrs: &[syn::Attribute], key: &str) -> Option<String> {
    attrs.iter().filter(|a| a.path().is_ident("serde")).find_map(|a| {
        let Meta::List(list) = &a.meta else { return None };
        let metas = list.parse_args_with(syn::punctuated::Punctuated::<Meta, syn::Token![,]>::parse_terminated).ok()?;
        metas.iter().find_map(|m| {
            let Meta::NameValue(nv) = m else { return None };
            if !nv.path.is_ident(key) {
                return None;
            }
            let syn::Expr::Lit(expr_lit) = &nv.value else { return None };
            let syn::Lit::Str(lit_str) = &expr_lit.lit else { return None };
            Some(lit_str.value())
        })
    })
}

fn parse_enum(e: &syn::ItemEnum) -> Result<DtoItem, DtoParseError> {
    let rust_name = e.ident.to_string();
    let ts_name = rename_ts(&e.attrs).unwrap_or_else(|| rust_name.clone());
    let doc = doc_lines(&e.attrs);
    let tag = find_serde_tag(&e.attrs);

    if let Some(_tag) = tag {
        let mut tag_variants = Vec::new();
        for v in &e.variants {
            // `#[serde(rename = "...")]` on a variant would change its actual wire tag while
            // `dto_ts` keeps emitting `to_snake_case` of the Rust variant name — a silent
            // Rust<->TS desync on the discriminant literal itself. Not supported today (no
            // variant in dto.rs uses it), so fail loudly instead of emitting a wrong tag.
            if let Some(renamed) = find_serde_string_value(&v.attrs, "rename") {
                return Err(DtoParseError { message: format!("{}::{}: #[serde(rename = \"{renamed}\")] is not supported by dto_ts — it would silently desync the wire tag from the emitted TS discriminant literal. Add explicit support in dto_ts::parse_enum, or rename the Rust variant itself instead.", e.ident, v.ident) });
            }
            let variant_id = to_snake_case(&v.ident.to_string());
            let fields = match &v.fields {
                Fields::Unit => Vec::new(),
                Fields::Named(named) => {
                    let mut out = Vec::new();
                    for f in &named.named {
                        out.push(parse_field(f)?);
                    }
                    out
                }
                Fields::Unnamed(_) => {
                    return Err(DtoParseError { message: format!("{}::{}: tuple variants are not supported in tagged unions", e.ident, v.ident) });
                }
            };
            tag_variants.push((variant_id, fields));
        }
        Ok(DtoItem::TaggedUnion { rust_name, ts_name, doc, tag_variants })
    } else {
        let mut variants = Vec::new();
        for v in &e.variants {
            if !matches!(v.fields, Fields::Unit) {
                return Err(DtoParseError { message: format!("{}::{}: non-unit variant requires #[serde(tag = \"...\")] on the enum", e.ident, v.ident) });
            }
            if let Some(renamed) = find_serde_string_value(&v.attrs, "rename") {
                return Err(DtoParseError { message: format!("{}::{}: #[serde(rename = \"{renamed}\")] is not supported by dto_ts — it would silently desync the wire value from the emitted TS string-literal union member. Add explicit support in dto_ts::parse_enum, or rename the Rust variant itself instead.", e.ident, v.ident) });
            }
            variants.push(to_snake_case(&v.ident.to_string()));
        }
        Ok(DtoItem::StringUnion { rust_name, ts_name, doc, variants })
    }
}

fn find_serde_tag(attrs: &[syn::Attribute]) -> Option<String> {
    attrs.iter().filter(|a| a.path().is_ident("serde")).find_map(|a| {
        let Meta::List(list) = &a.meta else { return None };
        let metas = list.parse_args_with(syn::punctuated::Punctuated::<Meta, syn::Token![,]>::parse_terminated).ok()?;
        metas.iter().find_map(|m| {
            let Meta::NameValue(nv) = m else { return None };
            if !nv.path.is_ident("tag") {
                return None;
            }
            let syn::Expr::Lit(expr_lit) = &nv.value else { return None };
            let syn::Lit::Str(lit_str) = &expr_lit.lit else { return None };
            Some(lit_str.value())
        })
    })
}

fn rename_ts(attrs: &[syn::Attribute]) -> Option<String> {
    find_dto_string_attr(attrs, "rename_ts")
}

fn has_dto_flag(attrs: &[syn::Attribute], flag: &str) -> bool {
    attrs.iter().filter(|a| a.path().is_ident("dto")).any(|a| {
        let Meta::List(list) = &a.meta else { return false };
        list.parse_args_with(syn::punctuated::Punctuated::<Meta, syn::Token![,]>::parse_terminated)
            .is_ok_and(|metas| metas.iter().any(|m| matches!(m, Meta::Path(p) if p.is_ident(flag))))
    })
}

fn find_dto_string_attr(attrs: &[syn::Attribute], key: &str) -> Option<String> {
    attrs.iter().filter(|a| a.path().is_ident("dto")).find_map(|a| {
        let Meta::List(list) = &a.meta else { return None };
        let metas = list.parse_args_with(syn::punctuated::Punctuated::<Meta, syn::Token![,]>::parse_terminated).ok()?;
        metas.iter().find_map(|m| {
            let Meta::NameValue(nv) = m else { return None };
            if !nv.path.is_ident(key) {
                return None;
            }
            let syn::Expr::Lit(expr_lit) = &nv.value else { return None };
            let syn::Lit::Str(lit_str) = &expr_lit.lit else { return None };
            Some(lit_str.value())
        })
    })
}

/// `///` doc comments as plain text lines, in source order.
fn doc_lines(attrs: &[syn::Attribute]) -> Vec<String> {
    attrs.iter().filter(|a| a.path().is_ident("doc")).filter_map(|a| {
        let Meta::NameValue(nv) = &a.meta else { return None };
        let syn::Expr::Lit(expr_lit) = &nv.value else { return None };
        let syn::Lit::Str(lit_str) = &expr_lit.lit else { return None };
        Some(lit_str.value().trim().to_string())
    }).collect()
}


fn path_ident_and_args(ty: &Type) -> Option<(&syn::Ident, &PathArguments)> {
    let Type::Path(p) = ty else { return None };
    let seg = p.path.segments.last()?;
    Some((&seg.ident, &seg.arguments))
}

fn generic_args(args: &PathArguments) -> Vec<&Type> {
    let PathArguments::AngleBracketed(a) = args else { return Vec::new() };
    a.args.iter().filter_map(|ga| match ga {
        GenericArgument::Type(t) => Some(t),
        _ => None,
    }).collect()
}

/// Structurally resolves a Rust type to its TS equivalent. Primitives are hardcoded; any other
/// named type (whether defined in `dto.rs` itself or a foreign type from another module) passes
/// through unchanged by its own Rust name — codegen assumes the same name is either generated here
/// too, or already exists hand-written on the TS side (use `#[dto(ts_type = "...")]` on the field
/// when the name actually differs).
fn resolve_type(ty: &Type) -> Result<String, String> {
    match ty {
        Type::Array(arr) => {
            let elem = resolve_type(&arr.elem)?;
            let syn::Expr::Lit(syn::ExprLit { lit: syn::Lit::Int(n), .. }) = &arr.len else {
                return Err("array length must be an integer literal".to_string());
            };
            let n: usize = n.base10_parse().map_err(|e: syn::Error| e.to_string())?;
            Ok(format!("[{}]", vec![elem; n].join(", ")))
        }
        Type::Tuple(tup) => {
            let mut parts = Vec::new();
            for elem in &tup.elems {
                parts.push(resolve_type(elem)?);
            }
            Ok(format!("[{}]", parts.join(", ")))
        }
        Type::Path(_) => {
            let (ident, args) = path_ident_and_args(ty).ok_or_else(|| "unresolvable type path".to_string())?;
            let name = ident.to_string();
            let generics = generic_args(args);
            match name.as_str() {
                "u8" | "u16" | "u32" | "u64" | "i8" | "i16" | "i32" | "i64" | "usize" | "isize" | "f32" | "f64" => Ok("number".to_string()),
                "bool" => Ok("boolean".to_string()),
                "String" => Ok("string".to_string()),
                "Vec" => {
                    let inner = generics.first().ok_or_else(|| "Vec<..> missing type argument".to_string())?;
                    Ok(format!("{}[]", resolve_type(inner)?))
                }
                "Option" => {
                    let inner = generics.first().ok_or_else(|| "Option<..> missing type argument".to_string())?;
                    Ok(format!("{} | null", resolve_type(inner)?))
                }
                "HashMap" => {
                    if generics.len() != 2 {
                        return Err("HashMap<..> needs exactly two type arguments".to_string());
                    }
                    let key = resolve_type(generics[0])?;
                    if key != "string" {
                        return Err(format!("HashMap key type must resolve to `string` (got `{key}`) — TS `Record` keys are always string"));
                    }
                    let value = resolve_type(generics[1])?;
                    Ok(format!("Record<string, {value}>"))
                }
                // Opaque named type reference (dto.rs's own type, or a foreign one) — pass
                // through unchanged. Ignores any of its own generic args; none of dto.rs's named
                // types are themselves generic.
                _ => Ok(name),
            }
        }
        _ => Err("unsupported type shape".to_string()),
    }
}

/// Applies every `#[dto(rename_ts = "...")]` rename to every field's resolved `ts_type` — a field
/// referencing another `dto.rs` type by its plain Rust name (e.g. `PostEditEdgeDto.from:
/// PostEditEndpointDto`) must still resolve to that type's renamed TS name
/// (`PostEditEndpointWasmDto`), even though `resolve_type` ran before renames were known.
fn apply_renames(items: &mut [DtoItem], renames: &std::collections::HashMap<String, String>) {
    fn rename_fields(fields: &mut [DtoField], renames: &std::collections::HashMap<String, String>) {
        for DtoField::Named { ts_type, .. } in fields {
            *ts_type = rename_type_string(ts_type, renames);
        }
    }
    for item in items {
        match item {
            DtoItem::Struct { fields, .. } => rename_fields(fields, renames),
            DtoItem::TaggedUnion { tag_variants, .. } => {
                for (_, fields) in tag_variants {
                    rename_fields(fields, renames);
                }
            }
            DtoItem::StringUnion { .. } => {}
        }
    }
}

/// Replaces every whole-identifier occurrence of a renamed type in a resolved TS type expression
/// (`"PostEditEndpointDto[]"` -> `"PostEditEndpointWasmDto[]"`) — identifiers are delimited by
/// non-identifier characters (`[`, `]`, `<`, `>`, `,`, ` `, `|`), which is every punctuation
/// character `resolve_type` ever emits around a named type.
fn rename_type_string(ts_type: &str, renames: &std::collections::HashMap<String, String>) -> String {
    let mut out = String::new();
    let mut ident = String::new();
    let flush = |ident: &mut String, out: &mut String| {
        if !ident.is_empty() {
            out.push_str(renames.get(ident.as_str()).map(String::as_str).unwrap_or(ident.as_str()));
            ident.clear();
        }
    };
    for c in ts_type.chars() {
        if c.is_alphanumeric() || c == '_' {
            ident.push(c);
        } else {
            flush(&mut ident, &mut out);
            out.push(c);
        }
    }
    flush(&mut ident, &mut out);
    out
}

/// `imports` is `(named_type, module_specifier)` pairs for TS types this file's fields reference
/// but doesn't itself define — e.g. `IssueKindId` from `./generated/issueKind`
/// (`IssueDto.kind`'s `#[dto(ts_type = "IssueKindId")]` override) — `dto_ts` has no way to derive
/// these on its own since they're never resolved structurally, so the caller supplies them.
/// Candidates whose name doesn't actually appear anywhere in the emitted body are skipped — the
/// caller's list is a superset covering every field that *might* need one across `dto.rs`'s whole
/// history, not a per-run exact set, so unconditionally emitting all of them would leave a stale
/// `import type` behind (and trip `noUnusedLocals` in `maze-web`'s `tsconfig.json`) the moment a
/// field naming one stops existing.
pub fn generate_ts_file(items: &[DtoItem], source_rel_path: &str, imports: &[(&str, &str)]) -> String {
    let mut items = items.to_vec();
    let renames = build_rename_map(&items);
    apply_renames(&mut items, &renames);

    let mut body = String::new();
    for item in &items {
        body.push_str(&emit_item(item));
        body.push('\n');
    }

    let mut out = String::new();
    out.push_str(&format!("// @generated by codegen/ — DO NOT EDIT. Source: {source_rel_path}\n\n"));
    let used_imports: Vec<_> = imports.iter().filter(|(ty, _)| type_name_appears_in(&body, ty)).collect();
    for (ty, module) in &used_imports {
        out.push_str(&format!("import type {{ {ty} }} from \"{module}\";\n"));
    }
    if !used_imports.is_empty() {
        out.push('\n');
    }
    out.push_str(&body);
    out
}

/// Whether `name` appears in `text` as a whole identifier (not as a substring of a longer one) —
/// same identifier-boundary rule as `rename_type_string`, reused here to decide whether a caller-
/// supplied import candidate is actually referenced anywhere in the generated body (including
/// inside `#[dto(ts_type = "...")]` overrides and doc comments, both of which are plain text this
/// scans indiscriminately; a doc-comment-only false-positive match only ever adds a harmless extra
/// import, never removes a needed one).
fn type_name_appears_in(text: &str, name: &str) -> bool {
    let mut ident = String::new();
    for c in text.chars().chain(std::iter::once('\0')) {
        if c.is_alphanumeric() || c == '_' {
            ident.push(c);
        } else {
            if ident == name {
                return true;
            }
            ident.clear();
        }
    }
    false
}

/// Maps every item's original Rust identifier to its (possibly `#[dto(rename_ts = "...")]`
/// overridden) TS name — only items whose name actually changed are included, since
/// `rename_type_string` only needs to rewrite occurrences that differ.
fn build_rename_map(items: &[DtoItem]) -> std::collections::HashMap<String, String> {
    items.iter().filter_map(|i| {
        let (rust_name, ts_name) = i.rust_and_ts_name();
        (rust_name != ts_name).then(|| (rust_name.to_string(), ts_name.to_string()))
    }).collect()
}

fn emit_doc(doc: &[String], indent: &str) -> String {
    if doc.is_empty() {
        return String::new();
    }
    if doc.len() == 1 {
        return format!("{indent}/** {} */\n", doc[0]);
    }
    let mut out = format!("{indent}/**\n");
    for line in doc {
        out.push_str(&format!("{indent} * {line}\n"));
    }
    out.push_str(&format!("{indent} */\n"));
    out
}

fn emit_field_line(field: &DtoField, indent: &str) -> String {
    let DtoField::Named { name, ts_type, optional, doc } = field;
    let mut out = emit_doc(doc, indent);
    let q = if *optional { "?" } else { "" };
    out.push_str(&format!("{indent}{name}{q}: {ts_type};\n"));
    out
}

fn emit_item(item: &DtoItem) -> String {
    match item {
        DtoItem::Struct { ts_name, doc, fields, .. } => {
            let mut out = emit_doc(doc, "");
            out.push_str(&format!("export interface {ts_name} {{\n"));
            for f in fields {
                out.push_str(&emit_field_line(f, "  "));
            }
            out.push_str("}\n");
            out
        }
        DtoItem::StringUnion { ts_name, doc, variants, .. } => {
            let mut out = emit_doc(doc, "");
            out.push_str(&format!("export type {ts_name} =\n"));
            for (i, v) in variants.iter().enumerate() {
                let sep = if i + 1 < variants.len() { "" } else { ";" };
                out.push_str(&format!("  | \"{v}\"{sep}\n"));
            }
            out
        }
        DtoItem::TaggedUnion { ts_name, doc, tag_variants, .. } => {
            let mut out = emit_doc(doc, "");
            out.push_str(&format!("export type {ts_name} =\n"));
            for (tag, fields) in tag_variants {
                if fields.is_empty() {
                    out.push_str(&format!("  | {{ kind: \"{tag}\" }}\n"));
                } else {
                    out.push_str(&format!("  | {{\n      kind: \"{tag}\";\n"));
                    for f in fields {
                        out.push_str(&emit_field_line(f, "      "));
                    }
                    out.push_str("    }\n");
                }
            }
            if let Some(last) = out.pop() {
                out.push(last);
            }
            out.push_str(";\n");
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_source(src: &str) -> Vec<DtoItem> {
        try_parse_source(src).expect("should parse")
    }

    fn try_parse_source(src: &str) -> Result<Vec<DtoItem>, DtoParseError> {
        let file = syn::parse_file(src).expect("test fixture must be valid Rust");
        let mut items = Vec::new();
        for item in &file.items {
            match item {
                Item::Struct(s) if has_serde_derive(&s.attrs) => items.push(parse_struct(s)?),
                Item::Enum(e) if has_serde_derive(&e.attrs) => items.push(parse_enum(e)?),
                _ => {}
            }
        }
        Ok(items)
    }

    #[test]
    fn struct_fields_resolve_primitives() {
        let items = parse_source(r#"
            #[derive(Serialize)]
            pub struct Foo {
                pub id: u32,
                pub name: String,
                pub ok: bool,
            }
        "#);
        let DtoItem::Struct { fields, .. } = &items[0] else { panic!("expected struct") };
        assert_eq!(fields.len(), 3);
        let DtoField::Named { ts_type, optional, .. } = &fields[0];
        assert_eq!(ts_type, "number");
        assert!(!optional);
    }

    #[test]
    fn plain_option_field_is_nullable_but_not_key_optional() {
        let items = parse_source(r#"
            #[derive(Serialize)]
            pub struct Foo {
                pub score: Option<f64>,
            }
        "#);
        let DtoItem::Struct { fields, .. } = &items[0] else { panic!("expected struct") };
        let DtoField::Named { ts_type, optional, .. } = &fields[0];
        assert_eq!(ts_type, "number | null");
        assert!(!optional, "plain Option<T> without #[serde(default)] must stay a required (non-`?`) key");
    }

    #[test]
    fn serde_default_marks_a_non_option_field_optional() {
        let items = parse_source(r#"
            #[derive(Deserialize)]
            pub struct Foo {
                #[serde(default)]
                pub split_points: Vec<u32>,
            }
        "#);
        let DtoItem::Struct { fields, .. } = &items[0] else { panic!("expected struct") };
        let DtoField::Named { ts_type, optional, .. } = &fields[0];
        assert_eq!(ts_type, "number[]");
        assert!(*optional);
    }

    #[test]
    fn dto_optional_flag_marks_a_non_option_field_optional() {
        let items = parse_source(r#"
            #[derive(Serialize)]
            pub struct Foo {
                #[dto(optional)]
                pub level: u32,
            }
        "#);
        let DtoItem::Struct { fields, .. } = &items[0] else { panic!("expected struct") };
        let DtoField::Named { ts_type, optional, .. } = &fields[0];
        assert_eq!(ts_type, "number");
        assert!(*optional);
    }

    #[test]
    fn dto_ts_type_overrides_resolution() {
        let items = parse_source(r#"
            #[derive(Deserialize)]
            pub struct Foo {
                #[dto(ts_type = "WasmTessellationConfig")]
                pub tessellation: TessellationConfig,
            }
        "#);
        let DtoItem::Struct { fields, .. } = &items[0] else { panic!("expected struct") };
        let DtoField::Named { ts_type, .. } = &fields[0];
        assert_eq!(ts_type, "WasmTessellationConfig");
    }

    #[test]
    fn rename_ts_overrides_the_emitted_type_name() {
        let items = parse_source(r#"
            #[derive(Deserialize)]
            #[dto(rename_ts = "BarWasmDto")]
            pub struct Bar {
                pub x: u32,
            }
        "#);
        let DtoItem::Struct { ts_name, .. } = &items[0] else { panic!("expected struct") };
        assert_eq!(ts_name, "BarWasmDto");
    }

    #[test]
    fn rename_ts_propagates_to_a_field_referencing_the_renamed_type_by_its_rust_name() {
        let items = parse_source(r#"
            #[derive(Deserialize)]
            #[dto(rename_ts = "BarWasmDto")]
            pub struct Bar {
                pub x: u32,
            }

            #[derive(Deserialize)]
            pub struct Container {
                pub bar: Bar,
                pub bars: Vec<Bar>,
            }
        "#);
        let text = generate_ts_file(&items, "foo.rs", &[]);
        assert!(text.contains("export interface BarWasmDto"));
        assert!(text.contains("bar: BarWasmDto;"));
        assert!(text.contains("bars: BarWasmDto[];"));
        assert!(!text.contains("Bar;"), "unrenamed `Bar` must not remain in the output: {text}");
    }

    #[test]
    fn vec_of_named_type_resolves_as_array() {
        let items = parse_source(r#"
            #[derive(Serialize)]
            pub struct Foo {
                pub nodes: Vec<NodeDto>,
            }
        "#);
        let DtoItem::Struct { fields, .. } = &items[0] else { panic!("expected struct") };
        let DtoField::Named { ts_type, .. } = &fields[0];
        assert_eq!(ts_type, "NodeDto[]");
    }

    #[test]
    fn hashmap_string_key_resolves_to_record() {
        let items = parse_source(r#"
            #[derive(Serialize)]
            pub struct Foo {
                pub node_component: HashMap<String, usize>,
            }
        "#);
        let DtoItem::Struct { fields, .. } = &items[0] else { panic!("expected struct") };
        let DtoField::Named { ts_type, .. } = &fields[0];
        assert_eq!(ts_type, "Record<string, number>");
    }

    #[test]
    fn fixed_size_array_resolves_as_tuple() {
        let items = parse_source(r#"
            #[derive(Serialize)]
            pub struct Foo {
                pub edge: [u32; 2],
            }
        "#);
        let DtoItem::Struct { fields, .. } = &items[0] else { panic!("expected struct") };
        let DtoField::Named { ts_type, .. } = &fields[0];
        assert_eq!(ts_type, "[number, number]");
    }

    #[test]
    fn plain_tuple_resolves_positionally() {
        let items = parse_source(r#"
            #[derive(Deserialize)]
            pub struct Foo {
                pub split_points: Vec<([i32; 2], u32, u32)>,
            }
        "#);
        let DtoItem::Struct { fields, .. } = &items[0] else { panic!("expected struct") };
        let DtoField::Named { ts_type, .. } = &fields[0];
        assert_eq!(ts_type, "[[number, number], number, number][]");
    }

    #[test]
    fn unit_only_enum_is_a_string_union() {
        let items = parse_source(r#"
            #[derive(Serialize)]
            #[serde(rename_all = "snake_case")]
            pub enum EdgeKindDto {
                Basic,
                VerticalPassage,
            }
        "#);
        let DtoItem::StringUnion { variants, .. } = &items[0] else { panic!("expected string union") };
        assert_eq!(variants, &vec!["basic".to_string(), "vertical_passage".to_string()]);
    }

    #[test]
    fn tagged_enum_is_a_discriminated_union() {
        let items = parse_source(r#"
            #[derive(Debug, Serialize)]
            #[serde(tag = "kind", rename_all = "snake_case")]
            pub enum SplitFaceRequirementDto {
                Passage,
                OneWay { direction: OneWayDirectionDto },
            }
        "#);
        let DtoItem::TaggedUnion { tag_variants, .. } = &items[0] else { panic!("expected tagged union") };
        assert_eq!(tag_variants.len(), 2);
        assert_eq!(tag_variants[0].0, "passage");
        assert!(tag_variants[0].1.is_empty());
        assert_eq!(tag_variants[1].0, "one_way");
        assert_eq!(tag_variants[1].1.len(), 1);
    }

    #[test]
    fn field_doc_comment_becomes_jsdoc() {
        let items = parse_source(r#"
            #[derive(Serialize)]
            pub struct Foo {
                /// hello
                pub x: u32,
            }
        "#);
        let text = generate_ts_file(&items, "foo.rs", &[]);
        assert!(text.contains("/** hello */"));
    }

    #[test]
    fn unused_import_candidate_is_omitted() {
        let items = parse_source(r#"
            #[derive(Serialize)]
            pub struct Foo {
                pub x: u32,
            }
        "#);
        let text = generate_ts_file(&items, "foo.rs", &[("NeverReferenced", "./nowhere")]);
        assert!(!text.contains("NeverReferenced"), "an import candidate absent from the body must not be emitted: {text}");
        assert!(!text.contains("import type"));
    }

    #[test]
    fn used_import_candidate_is_emitted() {
        let items = parse_source(r#"
            #[derive(Serialize)]
            pub struct Foo {
                #[dto(ts_type = "IssueKindId")]
                pub kind: String,
            }
        "#);
        let text = generate_ts_file(&items, "foo.rs", &[("IssueKindId", "./issueKind")]);
        assert!(text.contains("import type { IssueKindId } from \"./issueKind\";"));
    }

    #[test]
    fn serde_rename_on_a_field_is_a_parse_error() {
        let err = try_parse_source(r#"
            #[derive(Serialize)]
            pub struct Foo {
                #[serde(rename = "renamedField")]
                pub x: u32,
            }
        "#).expect_err("#[serde(rename = ...)] on a field must be rejected, not silently ignored");
        assert!(err.message.contains("renamedField"), "{}", err.message);
    }

    #[test]
    fn serde_rename_on_a_tagged_union_variant_is_a_parse_error() {
        let err = try_parse_source(r#"
            #[derive(Serialize)]
            #[serde(tag = "kind", rename_all = "snake_case")]
            pub enum Foo {
                #[serde(rename = "renamedVariant")]
                Bar,
            }
        "#).expect_err("#[serde(rename = ...)] on a tagged-union variant must be rejected, not silently ignored");
        assert!(err.message.contains("renamedVariant"), "{}", err.message);
    }

    #[test]
    fn serde_rename_on_a_string_union_variant_is_a_parse_error() {
        let err = try_parse_source(r#"
            #[derive(Serialize)]
            #[serde(rename_all = "snake_case")]
            pub enum Foo {
                #[serde(rename = "renamedVariant")]
                Bar,
            }
        "#).expect_err("#[serde(rename = ...)] on a string-union variant must be rejected, not silently ignored");
        assert!(err.message.contains("renamedVariant"), "{}", err.message);
    }
}
