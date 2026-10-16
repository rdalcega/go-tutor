import { describe, expect, it } from "vitest";
import { normalizeBotRank, rankToRating, ratingToRank, toHumanSLProfile } from "../../src/shared/rank.ts";

describe("rankToRating", () => {
  it("maps the scale anchors", () => {
    expect(rankToRating("30k")).toBe(0);
    expect(rankToRating("20k")).toBe(10);
    expect(rankToRating("1k")).toBe(29);
    expect(rankToRating("1d")).toBe(30);
    expect(rankToRating("9d")).toBe(38);
  });

  it("accepts case and long forms", () => {
    expect(rankToRating("20K")).toBe(10);
    expect(rankToRating("5 kyu")).toBe(25);
    expect(rankToRating("3dan")).toBe(32);
  });

  it("rejects invalid ranks", () => {
    for (const bad of ["", "k", "0k", "31k", "0d", "10d", "5p", "abc", "-3k"]) {
      expect(() => rankToRating(bad), bad).toThrow(RangeError);
    }
  });
});

describe("ratingToRank", () => {
  it("inverts rankToRating", () => {
    for (let r = 0; r <= 38; r++) expect(rankToRating(ratingToRank(r))).toBe(r);
    expect(ratingToRank(10)).toBe("20k");
    expect(ratingToRank(29)).toBe("1k");
    expect(ratingToRank(30)).toBe("1d");
  });

  it("rounds to the nearest rank", () => {
    expect(ratingToRank(10.4)).toBe("20k");
    expect(ratingToRank(10.6)).toBe("19k");
    expect(ratingToRank(29.5)).toBe("1d");
    expect(ratingToRank(29.49)).toBe("1k");
  });

  it("clamps to 30k … 9d", () => {
    expect(ratingToRank(-4)).toBe("30k");
    expect(ratingToRank(50)).toBe("9d");
    expect(ratingToRank(Number.NaN)).toBe("30k");
  });

  it("normalizes rank strings", () => {
    expect(normalizeBotRank("18K")).toBe("18k");
    expect(normalizeBotRank("2 dan")).toBe("2d");
  });
});

describe("toHumanSLProfile", () => {
  it("names KataGo human-SL profiles", () => {
    expect(toHumanSLProfile("20k")).toBe("rank_20k");
    expect(toHumanSLProfile("5K")).toBe("rank_5k");
    expect(toHumanSLProfile("1d")).toBe("rank_1d");
    expect(toHumanSLProfile("9d")).toBe("rank_9d");
  });

  it("accepts profile names and rejects ranks KataGo has no profile for", () => {
    expect(toHumanSLProfile("rank_3d")).toBe("rank_3d");
    expect(toHumanSLProfile(" 1D ")).toBe("rank_1d");
    expect(() => toHumanSLProfile("25k")).toThrow(/outside KataGo's human profiles/);
    expect(() => toHumanSLProfile("30k")).toThrow(/outside/);
    expect(() => toHumanSLProfile("strong")).toThrow(/not a rank/);
  });
});

describe("normalizeBotRank", () => {
  it("normalizes ranks from 20k to 9d and rejects the rest", () => {
    expect(normalizeBotRank("18K")).toBe("18k");
    expect(normalizeBotRank("20k")).toBe("20k");
    expect(normalizeBotRank("9d")).toBe("9d");
    expect(() => normalizeBotRank("21k")).toThrow(/outside/);
    expect(() => normalizeBotRank("10d")).toThrow(/out of range/);
  });
});
