//! Generates `as_str`/`from_str`/`Display` for a unit-only, string-id enum from a single source of
//! truth (the variant list) — see GitHub issue #361. Independent of the `WireEvent` pipeline
//! (`parser.rs`/`schema.rs`/`rust_emitter.rs`/`ts_emitter.rs`): those model wire-encoded event
//! payloads with tags and typed fields, this models a plain `Variant -> "snake_case_id"` mapping
//! with no wire concerns at all, so reusing that machinery would mean threading tag/field/mutating
//! concepts through a shape that has none of them.
//!
//! Source enum opts in with `#[derive(IdEnum)]`; a variant's id defaults to its name in
//! snake_case, overridable with `#[id(rename = "...")]` for a case where the wire string must stay
//! stable across a Rust rename (mirrors `#[wire(name = "...")]`'s rationale on the WireEvent side).

use std::fs;
use std::path::{Path, PathBuf};

use syn::{Expr, Item, Lit, Meta};

use crate::naming::to_snake_case;

#[derive(Debug)]
pub struct IdEnumParseError {
    pub file: PathBuf,
    pub message: String,
}

impl std::fmt::Display for IdEnumParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.file.display(), self.message)
    }
}

#[derive(Debug)]
pub struct IdVariant {
    pub name: String,
    pub id: String,
}

#[derive(Debug)]
pub struct IdEnumSource {
    pub enum_name: String,
    /// Path to the file containing the enum, relative to `root` (`maze-core/src`) — e.g.
    /// `quality_control/issue.rs`.
    pub rust_file: String,
    pub variants: Vec<IdVariant>,
}

/// Recursively finds every `.rs` file under `root` and parses each `#[derive(IdEnum)]` enum —
/// mirrors `parser::discover_sources`'s walk, kept separate since the two derives are found by
/// independent scans over the same tree (an enum could in principle carry both derives, though
/// none does today).
pub fn discover_sources(root: &Path) -> Result<Vec<IdEnumSource>, IdEnumParseError> {
    let mut sources = Vec::new();
    for entry in walk_rs_files(root) {
        let text = fs::read_to_string(&entry).map_err(|e| IdEnumParseError {
            file: entry.clone(),
            message: e.to_string(),
        })?;
        let file = syn::parse_file(&text).map_err(|e| IdEnumParseError {
            file: entry.clone(),
            message: e.to_string(),
        })?;
        for item in &file.items {
            if let Item::Enum(item_enum) = item {
                if has_derive_id_enum(&item_enum.attrs) {
                    sources.push(parse_enum(&entry, root, item_enum)?);
                }
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

fn has_derive_id_enum(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|a| {
        a.path().is_ident("derive")
            && a.parse_args_with(
                syn::punctuated::Punctuated::<syn::Path, syn::Token![,]>::parse_terminated,
            )
            .is_ok_and(|paths| {
                paths
                    .iter()
                    .any(|p| p.segments.last().is_some_and(|s| s.ident == "IdEnum"))
            })
    })
}

fn parse_enum(
    file: &Path,
    root: &Path,
    item_enum: &syn::ItemEnum,
) -> Result<IdEnumSource, IdEnumParseError> {
    let enum_name = item_enum.ident.to_string();
    let mut variants = Vec::new();
    for v in &item_enum.variants {
        if !matches!(v.fields, syn::Fields::Unit) {
            return Err(IdEnumParseError {
                file: file.to_path_buf(),
                message: format!(
                    "{enum_name}::{}: #[derive(IdEnum)] only supports unit variants",
                    v.ident
                ),
            });
        }
        let name = v.ident.to_string();
        let id = find_id_rename(&v.attrs).unwrap_or_else(|| to_snake_case(&name));
        variants.push(IdVariant { name, id });
    }

    let rel_file = file
        .strip_prefix(root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/");
    Ok(IdEnumSource {
        enum_name,
        rust_file: rel_file,
        variants,
    })
}

fn find_id_rename(attrs: &[syn::Attribute]) -> Option<String> {
    attrs
        .iter()
        .filter(|a| a.path().is_ident("id"))
        .find_map(|a| {
            let Meta::List(list) = &a.meta else {
                return None;
            };
            let metas = list
                .parse_args_with(
                    syn::punctuated::Punctuated::<Meta, syn::Token![,]>::parse_terminated,
                )
                .ok()?;
            metas.iter().find_map(|m| {
                let Meta::NameValue(nv) = m else { return None };
                if !nv.path.is_ident("rename") {
                    return None;
                }
                let Expr::Lit(expr_lit) = &nv.value else {
                    return None;
                };
                let Lit::Str(lit_str) = &expr_lit.lit else {
                    return None;
                };
                Some(lit_str.value())
            })
        })
}

/// Writes `<stem>_ids.rs` — `as_str`/`from_str`/`Display` — for one `IdEnumSource`. Never emits the
/// enum's own variant list or doc comments; those stay hand-written in the source file so each
/// variant keeps its own explanatory comment (see `IssueKind`'s doc comments).
pub fn generate_rust_ids_file(source: &IdEnumSource) -> String {
    let mut out = String::new();
    out.push_str("// @generated by codegen/ — DO NOT EDIT.\n");
    out.push_str(&format!(
        "// Source enum: {} (in the sibling file).\n\n",
        source.enum_name
    ));
    out.push_str(&format!("use super::{};\n\n", source.enum_name));
    out.push_str(&format!("impl {} {{\n", source.enum_name));
    out.push_str("    pub fn as_str(self) -> &'static str {\n        match self {\n");
    for v in &source.variants {
        out.push_str(&format!(
            "            {}::{} => \"{}\",\n",
            source.enum_name, v.name, v.id
        ));
    }
    out.push_str("        }\n    }\n\n");
    out.push_str("    pub fn from_str(s: &str) -> Option<Self> {\n        match s {\n");
    for v in &source.variants {
        out.push_str(&format!(
            "            \"{}\" => Some({}::{}),\n",
            v.id, source.enum_name, v.name
        ));
    }
    out.push_str("            _ => None,\n        }\n    }\n");
    out.push_str("}\n\n");
    out.push_str(&format!(
        "impl std::fmt::Display for {} {{\n",
        source.enum_name
    ));
    out.push_str("    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {\n");
    out.push_str("        f.write_str(self.as_str())\n    }\n}\n");
    out
}

/// Writes `maze-web/src/wasm/generated/<stem>.ts` — a string-literal union of every variant's id,
/// for TS code that currently hand-lists the same strings (e.g. `IssueDto.payload.kind`).
pub fn generate_ts_ids_file(source: &IdEnumSource) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "// @generated by codegen/ — DO NOT EDIT. Source: {}\n\n",
        source.rust_file
    ));
    let type_name = format!("{}Id", source.enum_name);
    out.push_str(&format!("export type {type_name} =\n"));
    for (i, v) in source.variants.iter().enumerate() {
        let sep = if i + 1 < source.variants.len() {
            ""
        } else {
            ";"
        };
        out.push_str(&format!("  | \"{}\"{sep}\n", v.id));
    }
    out.push('\n');
    out.push_str(&format!(
        "export const {}_VALUES: readonly {type_name}[] = [\n",
        to_screaming_snake_local(&source.enum_name)
    ));
    for v in &source.variants {
        out.push_str(&format!("  \"{}\",\n", v.id));
    }
    out.push_str("] as const;\n");
    out
}

fn to_screaming_snake_local(s: &str) -> String {
    crate::naming::to_screaming_snake(s)
}

/// Idempotently ensures the source file declares `mod <stem>_ids;` — mirrors
/// `rust_emitter::ensure_mod_declared`'s `_wire` variant, kept separate since the two generated
/// sibling files use different suffixes (`_wire.rs` vs `_ids.rs`) and must not collide if an enum
/// ever carried both derives.
pub fn ensure_mod_declared(source_text: &str, stem: &str) -> Option<String> {
    let mod_line = format!("#[path = \"{stem}_ids.rs\"]\nmod {stem}_ids;");
    if source_text.contains(&format!("mod {stem}_ids;")) {
        return None;
    }
    Some(format!("{mod_line}\n\n{source_text}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn parse_source(src: &str) -> IdEnumSource {
        let file = syn::parse_file(src).expect("test fixture must be valid Rust");
        let item_enum = file
            .items
            .iter()
            .find_map(|i| match i {
                Item::Enum(e) => Some(e),
                _ => None,
            })
            .expect("test fixture must contain an enum");
        parse_enum(Path::new("fixture.rs"), Path::new("."), item_enum).expect("should parse")
    }

    #[test]
    fn variant_id_defaults_to_snake_case_of_its_name() {
        let source = parse_source(
            r#"
            #[derive(IdEnum)]
            enum FooKind {
                MissingEndpoints,
            }
        "#,
        );
        assert_eq!(source.variants[0].id, "missing_endpoints");
    }

    #[test]
    fn id_rename_overrides_the_default() {
        let source = parse_source(
            r#"
            #[derive(IdEnum)]
            enum FooKind {
                #[id(rename = "legacy_name")]
                MissingEndpoints,
            }
        "#,
        );
        assert_eq!(source.variants[0].id, "legacy_name");
    }

    #[test]
    fn non_unit_variant_is_a_parse_error() {
        let file = syn::parse_file(
            r#"
            #[derive(IdEnum)]
            enum FooKind {
                Bar(u32),
            }
        "#,
        )
        .unwrap();
        let item_enum = file
            .items
            .iter()
            .find_map(|i| match i {
                Item::Enum(e) => Some(e),
                _ => None,
            })
            .unwrap();
        let err = parse_enum(Path::new("fixture.rs"), Path::new("."), item_enum).unwrap_err();
        assert!(err.message.contains("unit variants"));
    }

    #[test]
    fn generated_rust_round_trips_every_variant() {
        let source = IdEnumSource {
            enum_name: "FooKind".to_string(),
            rust_file: "foo.rs".to_string(),
            variants: vec![
                IdVariant {
                    name: "A".to_string(),
                    id: "a".to_string(),
                },
                IdVariant {
                    name: "B".to_string(),
                    id: "b".to_string(),
                },
            ],
        };
        let text = generate_rust_ids_file(&source);
        assert!(text.contains("use super::FooKind;"));
        assert!(text.contains("FooKind::A => \"a\""));
        assert!(text.contains("\"b\" => Some(FooKind::B)"));
    }

    #[test]
    fn generated_ts_lists_every_id_as_a_union_member() {
        let source = IdEnumSource {
            enum_name: "FooKind".to_string(),
            rust_file: "foo.rs".to_string(),
            variants: vec![
                IdVariant {
                    name: "A".to_string(),
                    id: "a".to_string(),
                },
                IdVariant {
                    name: "B".to_string(),
                    id: "b".to_string(),
                },
            ],
        };
        let text = generate_ts_ids_file(&source);
        assert!(text.contains("export type FooKindId ="));
        assert!(text.contains("| \"a\""));
        assert!(text.contains("| \"b\";"));
    }
}
