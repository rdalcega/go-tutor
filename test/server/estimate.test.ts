import { describe, expect, it } from "vitest";
import {
  ESTIMATE_RANKS,
  ESTIMATE_RATINGS,
  MIN_ESTIMATE_MOVES,
  POLICY_FLOOR,
  countsForEstimate,
  estimateRank,
  fitRank,
  logLikelihoods,
  movePolicies,
  openingSkip,
  peakRating,
  positionFor,
  rankSamples,
} from "../../src/server/estimate.ts";
import { policyIndex } from "../../src/server/katago.ts";
import { movesFromLine } from "../../src/engine/index.ts";
import { moveGtp } from "../../src/shared/coords.ts";
import type { GameSettings, MoveRecord, TakenBackMove } from "../../src/shared/types.ts";
import { FakeEngine, flush } from "./fakes.ts";

const settings: GameSettings = { size: 9, komi: 7, humanColor: "B", botRank: "20k", handicap: 0 };

/** Alternating moves along the top rows: black on row 9, white on row 8. */
function moves(n: number): MoveRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    number: i + 1,
    move: { color: i % 2 === 0 ? ("B" as const) : ("W" as const), point: { x: Math.floor(i / 2), y: i % 2 } },
    captures: [],
  }));
}

describe("rank estimate", () => {
  it("measures at KataGo's human-SL profiles from 20k to 9d", () => {
    expect(ESTIMATE_RANKS[0]).toBe("20k");
    expect(ESTIMATE_RANKS.at(-1)).toBe("9d");
    expect(ESTIMATE_RATINGS).toEqual([10, 12, 15, 18, 20, 22, 25, 27, 29, 30, 32, 34, 38]);
  });

  it("sums floored log-probabilities per profile", () => {
    const ll = logLikelihoods(
      [
        [0.5, 0.25],
        [0, 0.5],
      ],
      2,
    );
    expect(ll[0]).toBeCloseTo(Math.log(0.5) + Math.log(POLICY_FLOOR));
    expect(ll[1]).toBeCloseTo(Math.log(0.25) + Math.log(0.5));
  });

  it("finds the peak between profiles with a parabola, and stops at the ends", () => {
    // Evenly spaced and symmetric: the peak is on the middle profile.
    expect(peakRating([10, 12, 14], [-5, -1, -5])).toBeCloseTo(12);
    const ratings = [10, 12, 15];
    // A better right neighbor pulls the peak toward it, never past it.
    const right = peakRating(ratings, [-5, -1, -2]);
    expect(right).toBeGreaterThan(12);
    expect(right).toBeLessThan(15);
    // Unevenly spaced: the parabola through (10,-4), (12,0), (15,-9) is -(x-12)², so 12; equal
    // values on both sides put the peak halfway, toward the farther profile.
    expect(peakRating(ratings, [-4, 0, -9])).toBeCloseTo(12, 5);
    expect(peakRating(ratings, [-5, -1, -5])).toBeCloseTo(12.5, 5);
    expect(peakRating(ratings, [0, -1, -2])).toBe(10);
    expect(peakRating(ratings, [-2, -1, 0])).toBe(15);
  });

  it("reports the weakest profile as the floor, and nothing without moves", () => {
    expect(fitRank([])).toBeNull();
    const weak = fitRank([ESTIMATE_RATINGS.map((_, j) => 0.5 / (j + 1))]);
    expect(weak).toMatchObject({ rating: 10, floor: true });
    const strong = fitRank([ESTIMATE_RATINGS.map((_, j) => (j + 1) / 20)]);
    expect(strong).toMatchObject({ rating: 38, floor: false });
  });

  it("scores only the learner's unassisted moves, after the opening, and the taken-back ones in their own position", () => {
    expect(openingSkip(9)).toBe(4);
    const game = moves(14);
    game[8]!.assist = ["hint"]; // move 9
    game[10] = { ...game[10]!, move: { color: "B", pass: true } }; // move 11 is a pass
    expect(countsForEstimate(game[2]!, 9)).toBe(false); // move 3: the opening
    expect(countsForEstimate(game[4]!, 9)).toBe(true);
    const first: TakenBackMove = {
      moveNumber: 7,
      record: { number: 7, move: { color: "B", point: { x: 8, y: 8 } }, captures: [] },
      by: "tutor",
      ts: 0,
      before: game.slice(0, 6).map((r) => moveGtp(r.move, 9)),
    };
    const samples = rankSamples(settings, game, [first]);
    // Black's moves 5, 7 and 13 (9 had help, 11 is a pass), then the first attempt at 7.
    expect(samples.map((s) => s.move)).toEqual(["C9", "D9", "G9", "J1"]);
    expect(samples[0]!.position.moves).toHaveLength(4);
    expect(samples[3]!.position.moves.map((m) => m[1])).toEqual(first.before);
    // A taken-back move that had help itself doesn't count either.
    expect(rankSamples(settings, game, [{ ...first, record: { ...first.record, assist: ["rethink"] } }])).toHaveLength(3);
  });

  it("rebuilds a taken-back move's position, handicap stones included", () => {
    const handicap = { ...settings, handicap: 2 };
    const line = movesFromLine(handicap, ["C3", "pass"]);
    expect(line).toEqual([
      { color: "W", point: { x: 2, y: 6 } },
      { color: "B", pass: true },
    ]);
    const pos = positionFor(handicap, line);
    expect(pos.initialStones).toHaveLength(2);
    expect(pos.initialPlayer).toBe("W");
    expect(pos.moves).toEqual([
      ["W", "C3"],
      ["B", "pass"],
    ]);
    expect(() => movesFromLine(settings, ["Z99"])).toThrow();
    expect(policyIndex("A9", 9)).toBe(0);
    expect(policyIndex("J1", 9)).toBe(80);
    expect(policyIndex("pass", 9)).toBe(81);
  });

  it("asks KataGo for each move's human-SL probability at each profile, one visit and low priority", async () => {
    const engine = new FakeEngine();
    engine.concurrency = 2;
    // Every move's point gets 0.5 at 5k and 0.01 elsewhere.
    engine.humanPolicy = (pos, profile) => new Array(pos.size * pos.size + 1).fill(profile === "rank_5k" ? 0.5 : 0.01);
    const samples = rankSamples(settings, moves(16));
    expect(samples.length).toBeGreaterThanOrEqual(MIN_ESTIMATE_MOVES);
    const probs = await movePolicies(engine, samples);
    expect(probs).toHaveLength(samples.length);
    expect(probs[0]![ESTIMATE_RANKS.indexOf("5k")]).toBe(0.5);
    expect(engine.analyzeCalls).toHaveLength(samples.length * ESTIMATE_RANKS.length);
    expect(engine.analyzeCalls.every((c) => c.opts?.maxVisits === 1 && c.opts.includePolicy && c.opts.priority! < 0)).toBe(true);
    const help = { hints: 1, takeBacks: 2, rethinks: 3 };
    // The peak is 5k (25); its neighbors 8k (22) and 3k (27) fit equally, and the farther one pulls it to 24.5.
    expect(await estimateRank(engine, samples, help)).toEqual({ rating: 24.5, floor: false, moves: samples.length, ...help });
    // Too few moves to say anything.
    expect(await estimateRank(engine, samples.slice(0, MIN_ESTIMATE_MOVES - 1), help)).toBeNull();
  });

  it("fails when KataGo has no human model", async () => {
    const engine = new FakeEngine();
    const analyze = engine.analyze.bind(engine);
    engine.analyze = async (pos, opts) => {
      const a = await analyze(pos, opts);
      delete a.humanPolicy;
      return a;
    };
    await expect(movePolicies(engine, rankSamples(settings, moves(16)))).rejects.toThrow(/humanPolicy/);
  });

  it("stops every worker once one query fails", async () => {
    const engine = new FakeEngine();
    engine.concurrency = 2; // 4 workers
    const samples = rankSamples(settings, moves(16));
    const analyze = engine.analyze.bind(engine);
    let calls = 0;
    engine.analyze = (pos, opts) => (++calls === 6 ? Promise.reject(new Error("KataGo stopped")) : analyze(pos, opts));
    await expect(movePolicies(engine, samples)).rejects.toThrow(/KataGo stopped/);
    await flush(10);
    // The other workers finish the query they had in flight, then take no more of the 78 jobs.
    expect(samples.length * ESTIMATE_RANKS.length).toBeGreaterThan(50);
    expect(calls).toBeLessThanOrEqual(6 + 3);
  });
});
