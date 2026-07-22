import { describe, it, expect } from "vitest";
import {
  parseTape,
  decodePresetSetupEvent, isMutatingPresetSetupEvent, mutatingPresetSetupEvents, applyPresetSetup,
  TAG_SCOPE, NO_NODE, PRESET_SETUP_TAG,
  type ParsedTape,
} from "../debug/eventTape";

function u64le(v: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, v, true);
  return bytes;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function scopePayload(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

function passagePayload(from: bigint, to: bigint): Uint8Array {
  return concatBytes([u64le(from), u64le(to)]);
}

function teleportPayload(from: bigint, to: bigint, twoWay: boolean): Uint8Array {
  return concatBytes([u64le(from), u64le(to), new Uint8Array([twoWay ? 1 : 0])]);
}

interface FixtureNode {
  parent: number | null;
  firstChild: number | null;
  nextSibling: number | null;
  tag: number;
  payloadBytes: Uint8Array;
}

/** Mirrors `buildFixture` in `eventTape.test.ts` — kept local since that one isn't exported and
 *  this source's own fixtures are small enough not to need the shared helper. */
function buildFixture(nodes: FixtureNode[]): ParsedTape {
  const payloadChunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let cursor = 0;
  for (const n of nodes) {
    offsets.push(cursor);
    payloadChunks.push(n.payloadBytes);
    cursor += n.payloadBytes.byteLength;
  }
  const payload = concatBytes(payloadChunks);

  const nodeTable = new Uint8Array(nodes.length * 22);
  const dv = new DataView(nodeTable.buffer);
  nodes.forEach((n, i) => {
    const base = i * 22;
    dv.setUint32(base + 0, n.parent ?? NO_NODE, true);
    dv.setUint32(base + 4, n.firstChild ?? NO_NODE, true);
    dv.setUint32(base + 8, n.nextSibling ?? NO_NODE, true);
    dv.setUint16(base + 12, n.tag, true);
    dv.setUint32(base + 14, offsets[i], true);
    dv.setUint32(base + 18, n.payloadBytes.byteLength, true);
  });

  return parseTape(nodeTable, payload);
}

// root (0)
//   -> "preset_setup" scope (1)
//     -> PassageEstablished(1,2) (2)
//     -> OneWayEstablished(3,4) (3)
//     -> TeleportEstablished(5,6,two_way) (4)
function buildThreeEventTape(twoWay: boolean): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("preset_setup") },
    { parent: 1, firstChild: null, nextSibling: 3, tag: PRESET_SETUP_TAG.PASSAGE_ESTABLISHED, payloadBytes: passagePayload(1n, 2n) },
    { parent: 1, firstChild: null, nextSibling: 4, tag: PRESET_SETUP_TAG.ONE_WAY_ESTABLISHED, payloadBytes: passagePayload(3n, 4n) },
    { parent: 1, firstChild: null, nextSibling: null, tag: PRESET_SETUP_TAG.TELEPORT_ESTABLISHED, payloadBytes: teleportPayload(5n, 6n, twoWay) },
  ]);
}

describe("decodePresetSetupEvent", () => {
  it("decodes PassageEstablished as from/to", () => {
    expect(decodePresetSetupEvent(PRESET_SETUP_TAG.PASSAGE_ESTABLISHED, passagePayload(1n, 2n))).toEqual({
      kind: "PassageEstablished", from: 1n, to: 2n,
    });
  });

  it("decodes OneWayEstablished as an already-directed from/to", () => {
    expect(decodePresetSetupEvent(PRESET_SETUP_TAG.ONE_WAY_ESTABLISHED, passagePayload(3n, 4n))).toEqual({
      kind: "OneWayEstablished", from: 3n, to: 4n,
    });
  });

  it("decodes TeleportEstablished with its two_way flag", () => {
    expect(decodePresetSetupEvent(PRESET_SETUP_TAG.TELEPORT_ESTABLISHED, teleportPayload(5n, 6n, false))).toEqual({
      kind: "TeleportEstablished", from: 5n, to: 6n, twoWay: false,
    });
    expect(decodePresetSetupEvent(PRESET_SETUP_TAG.TELEPORT_ESTABLISHED, teleportPayload(5n, 6n, true))).toEqual({
      kind: "TeleportEstablished", from: 5n, to: 6n, twoWay: true,
    });
  });

  it("throws on an unknown wire tag", () => {
    expect(() => decodePresetSetupEvent(99, new Uint8Array(0))).toThrow(/unknown wire tag/);
  });

  it("throws when payload length doesn't match the tag's expected shape", () => {
    expect(() => decodePresetSetupEvent(PRESET_SETUP_TAG.PASSAGE_ESTABLISHED, new Uint8Array(5))).toThrow(/payload_len/);
  });
});

describe("isMutatingPresetSetupEvent", () => {
  it("every event kind is mutating", () => {
    expect(isMutatingPresetSetupEvent({ kind: "PassageEstablished", from: 1n, to: 2n })).toBe(true);
    expect(isMutatingPresetSetupEvent({ kind: "OneWayEstablished", from: 1n, to: 2n })).toBe(true);
    expect(isMutatingPresetSetupEvent({ kind: "TeleportEstablished", from: 1n, to: 2n, twoWay: true })).toBe(true);
  });
});

describe("mutatingPresetSetupEvents / applyPresetSetup", () => {
  it("exact sequence: passage, one-way, then two-way teleport", () => {
    const tape = buildThreeEventTape(true);
    expect(mutatingPresetSetupEvents(tape)).toEqual([
      { kind: "PassageEstablished", from: 1n, to: 2n },
      { kind: "OneWayEstablished", from: 3n, to: 4n },
      { kind: "TeleportEstablished", from: 5n, to: 6n, twoWay: true },
    ]);
  });

  it("applies passage/one-way with the right edge count and kind (passage bidirectional, one-way not)", () => {
    const tape = buildThreeEventTape(false);
    const result = applyPresetSetup(tape, 2);
    expect(result.edges).toEqual([
      { from: 1n, to: 2n, kind: "basic" },
      { from: 2n, to: 1n, kind: "basic" },
      { from: 3n, to: 4n, kind: "basic" },
      { from: 5n, to: 6n, kind: "teleport" },
    ]);
    expect(result.step).toBe(2);
  });

  it("a two-way teleport contributes both directed edges, a one-way teleport only its own", () => {
    const twoWay = applyPresetSetup(buildThreeEventTape(true), 2);
    expect(twoWay.edges).toContainEqual({ from: 6n, to: 5n, kind: "teleport" });

    const oneWay = applyPresetSetup(buildThreeEventTape(false), 2);
    expect(oneWay.edges).not.toContainEqual({ from: 6n, to: 5n, kind: "teleport" });
  });

  it("resumes from a previous result without re-decoding the already-known prefix", () => {
    const tape = buildThreeEventTape(true);
    const partial = applyPresetSetup(tape, 0);
    expect(partial.edges).toEqual([
      { from: 1n, to: 2n, kind: "basic" },
      { from: 2n, to: 1n, kind: "basic" },
    ]);

    const resumed = applyPresetSetup(tape, 2, partial);
    expect(resumed.edges).toEqual([
      { from: 1n, to: 2n, kind: "basic" },
      { from: 2n, to: 1n, kind: "basic" },
      { from: 3n, to: 4n, kind: "basic" },
      { from: 5n, to: 6n, kind: "teleport" },
      { from: 6n, to: 5n, kind: "teleport" },
    ]);
  });

  it("throws when targetStep is out of range", () => {
    const tape = buildThreeEventTape(true);
    expect(() => applyPresetSetup(tape, 3)).toThrow(/out of range/);
  });
});
