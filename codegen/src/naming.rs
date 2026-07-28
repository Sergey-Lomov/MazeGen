//! Shared identifier case conversions — used by both emitters and `golden` so there's one
//! `snake_case -> camelCase`/`SCREAMING_SNAKE_CASE` implementation, not one private copy per file.

/// `root_of_from` -> `rootOfFrom` — Rust struct field/type names are `snake_case`/`PascalCase`,
/// TS object fields and import specifiers are `camelCase` by convention (matches every
/// hand-written decoder in this directory, e.g. `kruskal.ts`'s `rootOfFrom`/`rootA` before this
/// migration).
pub fn to_camel_case(snake: &str) -> String {
    let mut out = String::new();
    let mut upper_next = false;
    for c in snake.chars() {
        if c == '_' {
            upper_next = true;
        } else if upper_next {
            out.extend(c.to_uppercase());
            upper_next = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// `VertexSelected` -> `VERTEX_SELECTED` — used for both Rust `wire_tags` constant names and TS
/// `*_TAG` object keys.
pub fn to_screaming_snake(s: &str) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if c.is_uppercase() {
            if i != 0 {
                out.push('_');
            }
            out.extend(c.to_uppercase());
        } else {
            out.extend(c.to_uppercase());
        }
    }
    out
}

/// `RecursiveBacktrackerEvent` -> `recursive_backtracker_event` — used to derive a source's file
/// stem before the `Event` suffix is stripped (see `parser::parse_enum`).
pub fn to_snake_case(s: &str) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if c.is_uppercase() {
            if i != 0 {
                out.push('_');
            }
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_camel_case_converts_snake_to_camel() {
        assert_eq!(to_camel_case("root_of_from"), "rootOfFrom");
        assert_eq!(to_camel_case("bidirectional"), "bidirectional");
        assert_eq!(to_camel_case(""), "");
    }

    #[test]
    fn to_screaming_snake_converts_pascal_to_screaming_snake() {
        assert_eq!(to_screaming_snake("VertexSelected"), "VERTEX_SELECTED");
        assert_eq!(to_screaming_snake("EdgeAdded"), "EDGE_ADDED");
        assert_eq!(to_screaming_snake("KruskalEvent"), "KRUSKAL_EVENT");
    }

    #[test]
    fn to_snake_case_converts_pascal_to_snake() {
        assert_eq!(to_snake_case("RecursiveBacktrackerEvent"), "recursive_backtracker_event");
        assert_eq!(to_snake_case("Kruskal"), "kruskal");
    }
}
