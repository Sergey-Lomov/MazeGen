//! Inert marker macro for the debug-tape wire codegen (see plan `toasty-honking-pie.md` and
//! GitHub issue #268 for the deferred Rust-generation phase this crate's attribute schema also
//! feeds). `#[derive(WireEvent)]` generates nothing — its only purpose is registering `#[wire]`/
//! `#[wire_event]` as known helper attributes so `rustc` accepts them on the annotated enum
//! without a separate `#[allow(unknown_lints)]`-style workaround. The `codegen` binary parses the
//! same source text independently via `syn` and is the actual reader of these attributes — this
//! macro never inspects its own input beyond making it a no-op passthrough.

use proc_macro::TokenStream;

#[proc_macro_derive(WireEvent, attributes(wire, wire_event))]
pub fn derive_wire_event(_input: TokenStream) -> TokenStream {
    TokenStream::new()
}

/// Inert marker macro for the id-list codegen (GitHub issue #361) — `#[derive(IdEnum)]` generates
/// nothing itself; its only purpose is registering `#[id]` as a known helper attribute so `rustc`
/// accepts it on the annotated enum. The `codegen` binary's `id_enum` module parses the same source
/// text independently via `syn` and emits the real `as_str`/`from_str`/`Display` impls into a
/// generated sibling file.
#[proc_macro_derive(IdEnum, attributes(id))]
pub fn derive_id_enum(_input: TokenStream) -> TokenStream {
    TokenStream::new()
}
