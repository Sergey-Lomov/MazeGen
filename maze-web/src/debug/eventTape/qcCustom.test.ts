// Hand-written decoder tests for qcCustom.ts's custom `read*` codecs -- these aren't covered by
// the codegen golden tests (see qcCustom.ts's own doc comment: QcEvent's HashMap/enum-payload
// fields use hand-written codecs, not generated ones). Bytes are built with small local helpers
// mirroring each field's wire width, not hand-typed byte arrays, to keep the encoding legible and
// resistant to transcription errors.

import { describe, it, expect } from "vitest";
import { readIssuePayload } from "./qcCustom";

function u32le(n: number): number[] {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, true);
  return Array.from(buf);
}

function str(text: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(text));
  return [...u32le(bytes.length), ...bytes];
}

describe("readIssuePayload", () => {
  it("decodes IssuePayload::None (tag 0)", () => {
    const bytes = new Uint8Array([0]);
    const { value, next } = readIssuePayload(bytes, 0);
    expect(value).toEqual({ kind: "None" });
    expect(next).toBe(1);
  });

  it("decodes IssuePayload::InvalidSplitRoute (tag 7), preserving edge order and the is_split_edge flag", () => {
    // Mirrors maze-core's `check_ran_with_invalid_split_route_payload_encodes_the_full_str_keyed_routes_map`
    // test in event.rs -- same logical payload, same wire bytes, cross-checking the TS decoder
    // against the Rust encoder's exact byte layout.
    const bytes = new Uint8Array([
      7, // IssuePayload::InvalidSplitRoute variant tag
      ...u32le(1), // map: 1 entry
      ...str("check1"),
      ...u32le(1), // 1 route
      ...u32le(2), // route has 2 edges
      ...u32le(1), ...u32le(2), 1, // edge0: from=1 to=2 is_split=true
      ...u32le(2), ...u32le(3), 0, // edge1: from=2 to=3 is_split=false
    ]);

    const { value, next } = readIssuePayload(bytes, 0);
    expect(value.kind).toBe("InvalidSplitRoute");
    if (value.kind !== "InvalidSplitRoute") throw new Error("unreachable");
    expect(value.routes.size).toBe(1);
    expect(value.routes.get("check1")).toEqual([[[1n, 2n, true], [2n, 3n, false]]]);
    expect(next).toBe(bytes.length);
  });

  it("throws on an unknown IssuePayload tag", () => {
    const bytes = new Uint8Array([99]);
    expect(() => readIssuePayload(bytes, 0)).toThrow();
  });
});
