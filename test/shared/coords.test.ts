import { describe, expect, it } from "vitest";
import { fromGtp, moveGtp, movePoint, pointKey, samePoint, toGtp, tryFromGtp } from "../../src/shared/coords.ts";

describe("toGtp", () => {
  it("puts row 1 at the bottom and A at the left", () => {
    expect(toGtp({ x: 0, y: 8 }, 9)).toBe("A1");
    expect(toGtp({ x: 0, y: 0 }, 9)).toBe("A9");
    expect(toGtp({ x: 3, y: 5 }, 9)).toBe("D4");
  });

  it("skips I", () => {
    expect(toGtp({ x: 7, y: 0 }, 9)).toBe("H9");
    expect(toGtp({ x: 8, y: 0 }, 9)).toBe("J9");
  });

  it("reaches T19 on 19×19", () => {
    expect(toGtp({ x: 18, y: 0 }, 19)).toBe("T19");
    expect(toGtp({ x: 18, y: 18 }, 19)).toBe("T1");
    expect(toGtp({ x: 15, y: 3 }, 19)).toBe("Q16");
  });

  it("returns pass for null", () => {
    expect(toGtp(null, 19)).toBe("pass");
  });

  it("throws off the board", () => {
    expect(() => toGtp({ x: 9, y: 0 }, 9)).toThrow(RangeError);
    expect(() => toGtp({ x: 0, y: -1 }, 9)).toThrow(RangeError);
  });
});

describe("fromGtp", () => {
  it("parses points case-insensitively", () => {
    expect(fromGtp("D4", 9)).toEqual({ x: 3, y: 5 });
    expect(fromGtp("q16", 19)).toEqual({ x: 15, y: 3 });
    expect(fromGtp(" t19 ", 19)).toEqual({ x: 18, y: 0 });
    expect(fromGtp("J1", 9)).toEqual({ x: 8, y: 8 });
  });

  it("parses pass", () => {
    expect(fromGtp("pass", 9)).toBeNull();
    expect(fromGtp("PASS", 9)).toBeNull();
  });

  it("rejects I, off-board and junk", () => {
    for (const bad of ["I5", "K9", "A10", "A0", "", "D", "44", "D4x", "resign"]) {
      expect(() => fromGtp(bad, 9), bad).toThrow(RangeError);
    }
    expect(() => fromGtp("U1", 19)).toThrow(/A1–T19/);
  });

  it("round-trips every point on 19×19", () => {
    for (let y = 0; y < 19; y++) {
      for (let x = 0; x < 19; x++) expect(fromGtp(toGtp({ x, y }, 19), 19)).toEqual({ x, y });
    }
  });

  it("tryFromGtp returns undefined instead of throwing", () => {
    expect(tryFromGtp("I1", 9)).toBeUndefined();
    expect(tryFromGtp("pass", 9)).toBeNull();
    expect(tryFromGtp("A1", 9)).toEqual({ x: 0, y: 8 });
  });
});

describe("points and moves", () => {
  it("keys and compares points", () => {
    expect(pointKey({ x: 3, y: 12 })).toBe("3,12");
    expect(samePoint({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
    expect(samePoint({ x: 1, y: 2 }, { x: 2, y: 1 })).toBe(false);
    expect(samePoint(null, { x: 1, y: 2 })).toBe(false);
    expect(samePoint(undefined, null)).toBe(false);
  });

  it("names a move's point", () => {
    expect(movePoint({ color: "B", point: { x: 3, y: 5 } })).toEqual({ x: 3, y: 5 });
    expect(movePoint({ color: "W", pass: true })).toBeNull();
    expect(movePoint(null)).toBeNull();
    expect(moveGtp({ color: "B", point: { x: 3, y: 5 } }, 9)).toBe("D4");
    expect(moveGtp({ color: "W", pass: true }, 9)).toBe("pass");
  });
});
