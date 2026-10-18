import { describe, expect, it } from "vitest";
import { BOARD_SIZES } from "../../src/shared/types.ts";
import {
  THRESHOLD_MULTIPLIERS,
  playedThreshold,
  sizeText,
  thresholdFor,
  thresholdMultiplier,
  thresholdNum,
  thresholdText,
} from "../../src/shared/threshold.ts";

describe("mistake threshold by board size", () => {
  it("scales the 9×9 threshold by ×1, ×1.5 and ×2", () => {
    expect(THRESHOLD_MULTIPLIERS).toEqual({ 9: 1, 13: 1.5, 19: 2 });
    expect(BOARD_SIZES).toEqual([9, 13, 19]);
    expect(BOARD_SIZES.map(thresholdMultiplier)).toEqual([1, 1.5, 2]);
    expect(BOARD_SIZES.map((s) => thresholdFor(4, s))).toEqual([4, 6, 8]);
    // The adaptive range, 2 to 6 on 9×9, and a half-point step between.
    expect(BOARD_SIZES.map((s) => thresholdFor(2, s))).toEqual([2, 3, 4]);
    expect(BOARD_SIZES.map((s) => thresholdFor(6, s))).toEqual([6, 9, 12]);
    expect(BOARD_SIZES.map((s) => thresholdFor(4.5, s))).toEqual([4.5, 6.75, 9]);
  });

  it("writes thresholds exactly, and the profile's on every board", () => {
    expect([4, 4.5, 6.75].map(thresholdNum)).toEqual(["4", "4.5", "6.75"]);
    expect(thresholdText(4)).toBe("4 pts on 9×9 (6 on 13×13, 8 on 19×19)");
    expect(thresholdText(4.5)).toBe("4.5 pts on 9×9 (6.75 on 13×13, 9 on 19×19)");
  });

  it("finds the threshold a game was played with", () => {
    const settings = { size: 19 as const };
    const recent = [{ ts: 0, gameId: "old", size: 19 as const, humanMoves: 2, avgPointLoss: 3, mistakes: 1, threshold: 3.5 }];
    expect(playedThreshold({ id: "new", settings, summary: { threshold: 8 } }, 4, recent)).toBe(8);
    // Saved before thresholds scaled by size: the recent-games entry's, else the base, unscaled.
    expect(playedThreshold({ id: "old", settings, summary: {} }, 4, recent)).toBe(3.5);
    expect(playedThreshold({ id: "older", settings, summary: {} }, 4.5, recent)).toBe(4.5);
    expect(playedThreshold({ id: "older", settings, summary: {} })).toBe(4);
    // Unfinished: the base scaled to the board.
    expect(playedThreshold({ id: "now", settings, summary: null }, 4.5)).toBe(9);
    expect(playedThreshold({ id: "now", settings })).toBe(8);
  });

  it("names a board size", () => {
    expect(sizeText(13)).toBe("13×13");
  });
});
