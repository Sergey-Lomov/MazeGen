//! Shared little-endian write helpers for `EncodeEventPayload::encode_payload` implementations.
//! Every generated `<name>_wire.rs` file (see `codegen/`) calls these instead of each source
//! carrying its own private copy — before this module existed, `write_node_id`/`push_ids`-shaped
//! helpers were duplicated privately per file (`quality_control/event.rs`, `vertex_based.rs`).
//! Hand-written `encode_payload` impls (e.g. `QcEvent`'s, which the codegen
//! plan keeps hand-written for its custom-coded fields) may keep using their own private copies —
//! this module doesn't retroactively claim every existing call site, only the ones `codegen`
//! itself emits calls to.

use crate::ids::NodeId;

pub fn write_node_id(out: &mut Vec<u8>, id: NodeId) {
    out.extend_from_slice(&id.to_le_bytes());
}

pub fn write_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn write_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn write_usize_as_u32(out: &mut Vec<u8>, v: usize) {
    out.extend_from_slice(&(v as u32).to_le_bytes());
}

pub fn write_f64(out: &mut Vec<u8>, v: f64) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn write_bool(out: &mut Vec<u8>, v: bool) {
    out.push(if v { 1 } else { 0 });
}

pub fn write_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

pub fn push_ids(out: &mut Vec<u8>, ids: &[NodeId]) {
    out.extend_from_slice(&(ids.len() as u32).to_le_bytes());
    for id in ids {
        out.extend_from_slice(&id.to_le_bytes());
    }
}

pub fn push_f64s(out: &mut Vec<u8>, values: &[f64]) {
    out.extend_from_slice(&(values.len() as u32).to_le_bytes());
    for v in values {
        out.extend_from_slice(&v.to_le_bytes());
    }
}

pub fn write_optional_node_id(out: &mut Vec<u8>, id: Option<NodeId>) {
    match id {
        None => {
            out.push(0);
            out.extend_from_slice(&0u64.to_le_bytes());
        }
        Some(id) => {
            out.push(1);
            out.extend_from_slice(&id.to_le_bytes());
        }
    }
}

pub fn write_optional_usize_as_u32(out: &mut Vec<u8>, v: Option<usize>) {
    match v {
        None => {
            out.push(0);
            out.extend_from_slice(&0u32.to_le_bytes());
        }
        Some(v) => {
            out.push(1);
            out.extend_from_slice(&(v as u32).to_le_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test: `write_optional_node_id` once wrote only a 1-byte payload for `None`
    /// (skipping the 8-byte placeholder), while every consumer — `type_map`'s
    /// `WireWidth::Fixed(9)`, TS's `readOptionalNodeId` (always reads presence + 8 bytes),
    /// `expectLen` checks in generated decoders — assumed a fixed 9-byte width regardless of
    /// presence; the field is always 9 bytes wide, `None` just zero-fills the value half.
    #[test]
    fn write_optional_node_id_is_always_nine_bytes() {
        let mut none_bytes = Vec::new();
        write_optional_node_id(&mut none_bytes, None);
        assert_eq!(none_bytes, vec![0, 0, 0, 0, 0, 0, 0, 0, 0]);

        let mut some_bytes = Vec::new();
        write_optional_node_id(&mut some_bytes, Some(9));
        assert_eq!(some_bytes.len(), 9);
        assert_eq!(some_bytes[0], 1);
        assert_eq!(&some_bytes[1..], &9u64.to_le_bytes());
    }

    #[test]
    fn write_optional_usize_as_u32_is_always_five_bytes() {
        let mut none_bytes = Vec::new();
        write_optional_usize_as_u32(&mut none_bytes, None);
        assert_eq!(none_bytes, vec![0, 0, 0, 0, 0]);

        let mut some_bytes = Vec::new();
        write_optional_usize_as_u32(&mut some_bytes, Some(9));
        assert_eq!(some_bytes.len(), 5);
        assert_eq!(some_bytes[0], 1);
        assert_eq!(&some_bytes[1..], &9u32.to_le_bytes());
    }
}
