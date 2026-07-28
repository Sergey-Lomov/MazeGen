//! Whitelist of custom codecs (plan section 4) — `#[wire(custom = "...")]` may only reference a
//! name registered here. Each entry points at an already hand-written Rust encode function and TS
//! decode function; codegen never writes their bodies, only wires a `case` to call them by name.

pub struct Codec {
    pub name: &'static str,
    pub rust_type: &'static str,
    pub rust_write_fn: &'static str,
    pub ts_type: &'static str,
    pub ts_read_fn: &'static str,
    /// Named TS type(s) `ts_type` references that must also be imported from the codec's own
    /// `<stem>Custom.ts` file alongside `ts_read_fn` — e.g. `IssuePayload`, a discriminated union
    /// hand-written next to `readIssuePayload`. `&[]` when `ts_type` is a structural/inline type
    /// (tuples, `Map<...>`, primitives) with no named type to import.
    pub ts_type_imports: &'static [&'static str],
}

pub const CODECS: &[Codec] = &[
    Codec {
        name: "IssuePayloadCodec",
        rust_type: "IssuePayload",
        rust_write_fn: "write_issue_payload",
        ts_type: "IssuePayload",
        ts_read_fn: "readIssuePayload",
        ts_type_imports: &["IssuePayload"],
    },
    Codec {
        name: "SplitNodeEdgesCodec",
        rust_type: "Vec<Vec<SplitNodeEdge>>",
        rust_write_fn: "write_split_nodes",
        ts_type: "SplitNodeEdge[][]",
        ts_read_fn: "readSplitNodes",
        ts_type_imports: &["SplitNodeEdge"],
    },
    Codec {
        name: "DetailsMapCodec",
        rust_type: "std::collections::HashMap<&'static str, String>",
        rust_write_fn: "write_details",
        ts_type: "Map<string, string>",
        ts_read_fn: "readDetails",
        ts_type_imports: &[],
    },
    Codec {
        name: "EdgePairsCodec",
        rust_type: "Vec<(NodeId, NodeId)>",
        rust_write_fn: "write_edge_pairs",
        ts_type: "[bigint, bigint][]",
        ts_read_fn: "readEdgePairs",
        ts_type_imports: &[],
    },
    Codec {
        name: "PresetUnionsCodec",
        rust_type: "Vec<(NodeId, NodeId, EdgeKind)>",
        rust_write_fn: "write_preset_unions",
        ts_type: "[bigint, bigint, \"basic\" | \"teleport\"][]",
        ts_read_fn: "readPresetUnions",
        ts_type_imports: &[],
    },
    Codec {
        name: "IssueKindCodec",
        rust_type: "IssueKind",
        rust_write_fn: "write_issue_kind",
        ts_type: "string",
        ts_read_fn: "readIssueKind",
        ts_type_imports: &[],
    },
    Codec {
        name: "RepairLimitKindCodec",
        rust_type: "RepairLimitKind",
        rust_write_fn: "write_repair_limit_kind",
        ts_type: "RepairLimitKind",
        ts_read_fn: "readRepairLimitKind",
        ts_type_imports: &["RepairLimitKind"],
    },
    Codec {
        name: "CheckIssueCodec",
        rust_type: "Option<(IssueKind, IssuePayload, std::collections::HashMap<&'static str, String>)>",
        rust_write_fn: "write_check_issue",
        ts_type: "{ issueKind: string; payload: IssuePayload; details: Map<string, string> } | null",
        ts_read_fn: "readCheckIssue",
        ts_type_imports: &["IssuePayload"],
    },
    Codec {
        name: "DetailsMapMapCodec",
        rust_type: "std::collections::HashMap<String, std::collections::HashMap<&'static str, String>>",
        rust_write_fn: "write_details_map",
        ts_type: "Map<string, Map<string, string>>",
        ts_read_fn: "readDetailsMap",
        ts_type_imports: &[],
    },
];

pub fn lookup(name: &str) -> Option<&'static Codec> {
    CODECS.iter().find(|c| c.name == name)
}
