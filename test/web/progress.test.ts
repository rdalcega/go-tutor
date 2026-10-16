import { describe, expect, it } from "vitest";
import { defaultProfile } from "../../src/server/store.ts";
import { nextBotText, ratingChangeFor, ratingSparkPoints, topCategories } from "../../web/src/geometry.ts";

describe("progress panel helpers", () => {
  it("draws higher ratings higher, with a minimum vertical range", () => {
    expect(ratingSparkPoints([], 300, 32)).toEqual([]);
    expect(ratingSparkPoints([10], 300, 32)).toEqual([{ x: 150, y: 16 }]);
    const [a, b] = ratingSparkPoints([10, 12], 300, 32);
    expect(a).toEqual({ x: 4, y: 28 });
    expect(b).toEqual({ x: 296, y: 4 });
    // A small change stays small: 0.2 ranks on a range of at least 2.
    const [c, d] = ratingSparkPoints([10, 10.2], 300, 32);
    expect(c!.y - d!.y).toBeCloseTo(2.4);
  });

  it("names the top mistake categories", () => {
    expect(topCategories({ shape: 2, life_and_death: 5, opening: 1, endgame: 0 })).toEqual(["life and death 5", "shape 2"]);
    expect(topCategories({ other: 0 })).toEqual([]);
  });

  it("describes the next bot and a game's rating change", () => {
    expect(nextBotText({ botRank: "18k", handicap: 0 })).toBe("18k");
    expect(nextBotText({ botRank: "20k", handicap: 3 })).toBe("20k +3 stones");
    const p = { ...defaultProfile(), ratingHistory: [{ ts: 1, gameId: "g1", rating: 11.5, botRank: "20k", won: true, delta: 1.5 }] };
    expect(ratingChangeFor(p, "g1")).toEqual({ before: "20k", after: "18k", delta: 1.5 });
    expect(ratingChangeFor(p, "g2")).toBeNull();
  });
});
