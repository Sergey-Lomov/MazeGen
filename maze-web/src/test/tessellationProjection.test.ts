import { describe, it, expect } from "vitest";
import { encodePoint, decodePoint } from "../pixi/tessellationProjection";

describe("encodePoint / decodePoint", () => {
  it("round-trips positive coords", () => {
    expect(decodePoint(encodePoint(3, 7))).toEqual([3, 7]);
  });

  it("round-trips zero", () => {
    expect(decodePoint(encodePoint(0, 0))).toEqual([0, 0]);
  });

  it("round-trips negative x", () => {
    expect(decodePoint(encodePoint(-1, 0))).toEqual([-1, 0]);
  });

  it("round-trips negative y", () => {
    expect(decodePoint(encodePoint(0, -1))).toEqual([0, -1]);
  });

  it("round-trips both negative", () => {
    expect(decodePoint(encodePoint(-5, -10))).toEqual([-5, -10]);
  });

  it("round-trips max positive coords (32767)", () => {
    expect(decodePoint(encodePoint(32767, 32767))).toEqual([32767, 32767]);
  });

  it("round-trips min negative coords (-32768)", () => {
    expect(decodePoint(encodePoint(-32768, -32768))).toEqual([-32768, -32768]);
  });

  it("round-trips mixed extremes", () => {
    expect(decodePoint(encodePoint(32767, -32768))).toEqual([32767, -32768]);
    expect(decodePoint(encodePoint(-32768, 32767))).toEqual([-32768, 32767]);
  });

  it("encodes distinct points to distinct keys", () => {
    const k1 = encodePoint(1, 2);
    const k2 = encodePoint(2, 1);
    const k3 = encodePoint(0, 0);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k2).not.toBe(k3);
  });
});
