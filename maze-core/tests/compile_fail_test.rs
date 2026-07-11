// Compile-fail proofs for GitHub issue #113: `Rule<T, I>`/`RepairStrategy<T, I>::apply` must
// reject a mismatched Issue type at compile time, not just at runtime. See
// `tests/compile_fail/*.rs` for what each case covers.
#[test]
fn compile_fail_cases() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/compile_fail/*.rs");
}
