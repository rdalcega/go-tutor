import { describe, expect, it } from "vitest";
import { defaultProfile } from "../../src/server/store.ts";
import { latestEstimate, nextBotText, ratingChangeFor, ratingSparkPoints, topCategories } from "../../web/src/geometry.ts";

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
    expect(latestEstimate(p)).toBeNull();
  });

  it("describes a game's rank estimate and the help left out of it", () => {
    const estimate = { rating: 12.2, floor: false, moves: 34, hints: 3, takeBacks: 2, rethinks: 0 };
    const p = {
      ...defaultProfile(),
      ratingHistory: [
        { ts: 1, gameId: "g1", rating: 10, botRank: "20k", won: true, delta: 0, estimate: { ...estimate, rating: 10, floor: true, moves: 20, hints: 0, takeBacks: 0 } },
        { ts: 2, gameId: "g2", rating: 11.5, botRank: "20k", won: true, delta: 1.5, estimate },
      ],
    };
    expect(ratingChangeFor(p, "g2")).toEqual({ before: "20k", after: "18k", delta: 1.5, estimate: "Rank estimate 18k from 34 unassisted moves (3 hints, 2 take-backs)" });
    expect(ratingChangeFor(p, "g1")?.estimate).toBe("Rank estimate 20k or weaker from 20 unassisted moves");
    expect(latestEstimate(p)).toEqual({ short: "18k · 34 moves", long: "Last game: Rank estimate 18k from 34 unassisted moves (3 hints, 2 take-backs)." });
  });
});
