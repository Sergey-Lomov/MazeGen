//! `IssuePayload`'s wire tag switch (`event_encode.rs`'s `write_issue_payload` / `qcCustom.ts`'s
//! `readIssuePayload`) is hand-written on both sides — not `Schema`-driven like the rest of
//! `check.rs`'s invariants, since `IssuePayload` is an ad-hoc Rust enum with variant-specific
//! field shapes, not a declarative wire source `parser.rs` understands. Codegen can't safely
//! generate this pair (see `codecs.rs`'s own doc comment: "codegen never writes their bodies"),
//! but it *can* text-scan both sides' tag numbers and flag a mismatch — the exact failure mode
//! that shipped once (GitHub issue #399's `InvalidElevatorStop` tag 11: added to the Rust side,
//! forgotten on the TS side, only caught by a runtime crash in the debug tape viewer).
//!
//! Purely a tag-*set* comparison — it does not (and cannot, without re-parsing each side's actual
//! field-decoding calls) confirm the two sides decode a given tag's payload the same way, only
//! that every tag written on one side has a matching read arm on the other.

use std::collections::BTreeSet;

pub struct IssuePayloadTagError(pub String);

/// Extracts every `out.push(N);` tag literal appearing before a `write_issue_payload` match arm's
/// body in `event_encode.rs`'s source text — text-scanning, not a real Rust parse, same rationale
/// as `check.rs::old_write_call_sequence` (this file's only read of hand-written source, mirrors
/// that one's own justification for scanning instead of using `syn`).
pub fn rust_tags(source: &str) -> BTreeSet<u16> {
    let Some(fn_start) = source.find("fn write_issue_payload(") else {
        return BTreeSet::new();
    };
    let body = &source[fn_start..];
    let Some(body_end) = body.find("\npub(crate) fn write_str(") else {
        return BTreeSet::new();
    };
    let body = &body[..body_end];

    let mut tags = BTreeSet::new();
    let marker = "out.push(";
    let mut pos = 0;
    while let Some(rel) = body[pos..].find(marker) {
        let start = pos + rel + marker.len();
        let rest = &body[start..];
        if let Some(paren) = rest.find(')')
            && let Ok(tag) = rest[..paren].trim().parse::<u16>()
        {
            tags.insert(tag);
        }
        pos = start;
    }
    tags
}

/// Extracts every `tag === N` literal from `qcCustom.ts`'s `readIssuePayload` function body —
/// mirrors `rust_tags`'s scan on the TS side.
pub fn ts_tags(source: &str) -> BTreeSet<u16> {
    let Some(fn_start) = source.find("export function readIssuePayload(") else {
        return BTreeSet::new();
    };
    let body = &source[fn_start..];
    let Some(body_end) = body.find("\n/** Reads an `IssueKind`") else {
        return BTreeSet::new();
    };
    let body = &body[..body_end];

    let mut tags = BTreeSet::new();
    let marker = "tag === ";
    let mut pos = 0;
    while let Some(rel) = body[pos..].find(marker) {
        let start = pos + rel + marker.len();
        let rest = &body[start..];
        if let Some(paren) = rest.find(')')
            && let Ok(tag) = rest[..paren].trim().parse::<u16>()
        {
            tags.insert(tag);
        }
        pos = start;
    }
    tags
}

/// Compares the two tag sets, reporting a tag present on only one side — the exact drift that let
/// GitHub issue #399's tag-11 crash ship silently through `codegen --check`.
pub fn check_tags(rust_source: &str, ts_source: &str) -> Vec<IssuePayloadTagError> {
    let rust = rust_tags(rust_source);
    let ts = ts_tags(ts_source);
    let mut errors = Vec::new();

    for &tag in rust.difference(&ts) {
        errors.push(IssuePayloadTagError(format!(
            "IssuePayload tag {tag}: written by event_encode.rs's write_issue_payload but no matching `tag === {tag}` arm in qcCustom.ts's readIssuePayload"
        )));
    }
    for &tag in ts.difference(&rust) {
        errors.push(IssuePayloadTagError(format!(
            "IssuePayload tag {tag}: read by qcCustom.ts's readIssuePayload but no matching arm in event_encode.rs's write_issue_payload"
        )));
    }

    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rust_src(arms: &str) -> String {
        format!(
            "pub(crate) fn write_issue_payload(out: &mut Vec<u8>, payload: &IssuePayload) {{\n    match payload {{\n{arms}    }}\n}}\n\npub(crate) fn write_str(out: &mut Vec<u8>, s: &str) {{}}\n"
        )
    }

    fn ts_src(arms: &str) -> String {
        format!(
            "export function readIssuePayload(bytes: Uint8Array, offset: number): {{ value: IssuePayload; next: number }} {{\n{arms}}}\n\n/** Reads an `IssueKind` */\nexport function readIssueKind() {{}}\n"
        )
    }

    #[test]
    fn extracts_rust_tags_in_order() {
        let src = rust_src(
            "        IssuePayload::None => out.push(0),\n        IssuePayload::InvalidLoop { .. } => { out.push(1); }\n",
        );
        assert_eq!(rust_tags(&src), BTreeSet::from([0, 1]));
    }

    #[test]
    fn extracts_ts_tags() {
        let src = ts_src(
            "  if (tag === 0) return { value: { kind: \"None\" }, next: offset + 1 };\n  if (tag === 1) { return x; }\n",
        );
        assert_eq!(ts_tags(&src), BTreeSet::from([0, 1]));
    }

    #[test]
    fn matching_tag_sets_produce_no_errors() {
        let rust = rust_src("        IssuePayload::None => out.push(0),\n");
        let ts = ts_src("  if (tag === 0) { }\n");
        assert!(check_tags(&rust, &ts).is_empty());
    }

    #[test]
    fn rust_only_tag_is_reported() {
        let rust = rust_src(
            "        IssuePayload::None => out.push(0),\n        IssuePayload::InvalidElevatorStop { .. } => { out.push(11); }\n",
        );
        let ts = ts_src("  if (tag === 0) { }\n");
        let errors = check_tags(&rust, &ts);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].0.contains("tag 11"));
        assert!(errors[0].0.contains("qcCustom.ts"));
    }

    #[test]
    fn ts_only_tag_is_reported() {
        let rust = rust_src("        IssuePayload::None => out.push(0),\n");
        let ts = ts_src("  if (tag === 0) { }\n  if (tag === 11) { }\n");
        let errors = check_tags(&rust, &ts);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].0.contains("tag 11"));
        assert!(errors[0].0.contains("event_encode.rs"));
    }
}
