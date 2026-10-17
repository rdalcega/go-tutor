import { describe, expect, it } from "vitest";
import {
  applyEstimate,
  applyGame,
  applyProblemResult,
  applyTag,
  MIN_BOT_RATING,
  botFor,
  botStrength,
  classifyMistake,
  combinedEstimate,
  type EstimatedGame,
  endgameStart,
  expectedScore,
  mistakeKey,
  openingEnd,
  poorShapeAt,
  ratedGames,
  ratingStep,
  recommendFocus,
  type FinishedGame,
  type MistakeContext,
} from "../../src/server/profile.ts";
import { defaultProfile } from "../../src/server/store.ts";
import type { GameSettings, MistakeCategory, MoveRecord, Profile, RankEstimate, RatingChange } from "../../src/shared/types.ts";
import { boardFrom } from "../engine/helpers.ts";

const EMPTY = Array(9).fill(". . . . . . . . .");

function ctx(over: Partial<MistakeContext> = {}): MistakeContext {
  return {
    size: 9,
    moveNumber: 20,
    move: { color: "B", point: { x: 4, y: 4 } },
    captures: 0,
    pointLoss: 4.5,
    threshold: 4,
    bestMove: "D4", // (3, 5): distance 2 from E5
    boardBefore: boardFrom(EMPTY),
    boardAfter: boardFrom(EMPTY.map((r, y) => (y === 4 ? ". . . . X . . . ." : r))),
    ...over,
  };
}

describe("heuristic mistake categories", () => {
  it("splits the game into opening, middle game and endgame by move number and board size", () => {
    expect([openingEnd(9), endgameStart(9)]).toEqual([12, 41]);
    expect([openingEnd(19), endgameStart(19)]).toEqual([54, 181]);
    expect(classifyMistake(ctx({ moveNumber: 3 }))).toBe("opening");
    expect(classifyMistake(ctx({ moveNumber: 45 }))).toBe("endgame");
    expect(classifyMistake(ctx())).toBe("other");
  });

  it("calls a large loss with the best move far away direction", () => {
    expect(classifyMistake(ctx({ pointLoss: 8, bestMove: "B8" }))).toBe("direction"); // (1, 1): distance 6
    expect(classifyMistake(ctx({ pointLoss: 4.5, bestMove: "B8" }))).toBe("other"); // far but small
  });

  it("calls an empty triangle with a local loss shape", () => {
    const before = boardFrom([
      ". . . . . . . . .",
      ". . . . . . . . .",
      ". . . . . . . . .",
      ". . . . . . . . .",
      ". . . X . . . . .",
      ". . . X . . . . .",
      ". . . . . . . . .",
      ". . . . . . . . .",
      ". . . . . . . . .",
    ]);
    const after = boardFrom([
      ". . . . . . . . .",
      ". . . . . . . . .",
      ". . . . . . . . .",
      ". . . . . . . . .",
      ". . . X X . . . .",
      ". . . X . . . . .",
      ". . . . . . . . .",
      ". . . . . . . . .",
      ". . . . . . . . .",
    ]);
    expect(poorShapeAt(after, { x: 4, y: 4 }, "B")).toBe(true);
    expect(poorShapeAt(after, { x: 4, y: 4 }, "W")).toBe(false);
    expect(classifyMistake(ctx({ boardBefore: before, boardAfter: after, bestMove: "F5" }))).toBe("shape");
  });

  it("calls captures and self-atari tactics", () => {
    expect(classifyMistake(ctx({ captures: 1 }))).toBe("tactics");
    // Black's best move captures the white stone at A1.
    const before = boardFrom([...EMPTY.slice(0, 7), "X . . . . . . . .", "O . . . . . . . ."]);
    expect(classifyMistake(ctx({ boardBefore: before, boardAfter: before, move: { color: "B", pass: true }, bestMove: "B1" }))).toBe("tactics");
    // Black plays into atari at the edge.
    const atari = boardFrom([...EMPTY.slice(0, 7), "O . . . . . . . .", "X . . . . . . . ."]);
    expect(classifyMistake(ctx({ move: { color: "B", point: { x: 0, y: 8 } }, boardAfter: atari }))).toBe("tactics");
    // Black tenukis; White's best reply E8 captures the black stone at E9.
    const after = boardFrom([". . . O X O . . .", ...EMPTY.slice(1, 8), ". . . . . . . . X"]);
    const tenuki = { color: "B" as const, point: { x: 8, y: 8 } };
    expect(classifyMistake(ctx({ move: tenuki, boardAfter: after, bestMove: "J2" }))).toBe("other");
    expect(classifyMistake(ctx({ move: tenuki, boardAfter: after, bestMove: "J2", reply: "E8" }))).toBe("tactics");
  });

  it("calls a group changing life status in KataGo's ownership life and death", () => {
    const board = boardFrom(EMPTY.map((r, y) => (y === 2 ? ". . . . X X . . ." : r)));
    const group = new Set([2 * 9 + 4, 2 * 9 + 5]);
    const own = (v: number) => Array.from({ length: 81 }, (_, i) => (group.has(i) ? v : 0));
    const base = ctx({ boardBefore: board, boardAfter: board, move: { color: "B", point: { x: 0, y: 0 } }, bestMove: "E8" });
    expect(classifyMistake({ ...base, ownershipBefore: own(0.8), ownershipAfter: own(-0.8) })).toBe("life_and_death");
    // A wobble that doesn't flip the status isn't one.
    expect(classifyMistake({ ...base, ownershipBefore: own(0.8), ownershipAfter: own(0.4) })).not.toBe("life_and_death");
    // Without ownership the check is skipped.
    expect(classifyMistake(base)).not.toBe("life_and_death");
  });

  it("calls adjacent groups short of liberties a capturing race", () => {
    const board = boardFrom([...EMPTY.slice(0, 7), "X X . . . . . . .", "O O . . . . . . ."]);
    const far = { color: "B" as const, point: { x: 7, y: 1 } };
    expect(classifyMistake(ctx({ boardBefore: board, boardAfter: board, move: far, bestMove: "C1" }))).toBe("capturing_race");
  });
});

// ---------------------------------------------------------------------------

const settings: GameSettings = { size: 9, komi: 7, humanColor: "B", botRank: "20k", handicap: 0 };

/** `humanMoves` black moves alternating with white ones, each human move losing `loss`. */
function moves(humanMoves: number, loss = 1): MoveRecord[] {
  const out: MoveRecord[] = [];
  for (let i = 0; i < humanMoves; i++) {
    out.push({
      number: out.length + 1,
      move: { color: "B", point: { x: i % 9, y: Math.floor(i / 9) } },
      captures: [],
      eval: { leadBefore: 0, leadAfter: -loss, pointLoss: loss, winrateBefore: 0.5, winrateAfter: 0.45, bestMove: "E5", bestPv: [], candidates: [] },
    });
    out.push({ number: out.length + 1, move: { color: "W", point: { x: i % 9, y: 8 - Math.floor(i / 9) } }, captures: [] });
  }
  return out;
}

function game(over: Partial<FinishedGame> & { won?: boolean; humanMoves?: number; loss?: number } = {}): FinishedGame {
  const { won = true, humanMoves = 12, loss = 1, ...rest } = over;
  return {
    gameId: "g1",
    ts: 1000,
    settings,
    result: { winner: won ? "B" : "W", margin: won ? 5 : -5, reason: "score" },
    moves: moves(humanMoves, loss),
    summary: { moves: humanMoves * 2, mistakes: [], totalPointLoss: humanMoves * loss },
    threshold: 4,
    ...rest,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function estimateAt(rating: number, moves: number): RankEstimate {
  return { rating, floor: rating <= 10, moves, hints: 0, takeBacks: 0, rethinks: 0 };
}

/** The estimate step for a finished game (no help). */
function estimated(g: FinishedGame, estimate: RankEstimate | null): EstimatedGame {
  const human = g.moves.filter((r) => r.move.color === g.settings.humanColor).length;
  return { gameId: g.gameId, ts: g.ts, settings: g.settings, result: g.result, humanMoves: human, assistedMoves: 0, estimate };
}

/** A rated game end to end: the game's stats, then its rank estimate. */
function rate(p: Profile, g: FinishedGame, estimate: RankEstimate | null): RatingChange {
  applyGame(p, g);
  return applyEstimate(p, estimated(g, estimate));
}

describe("rating", () => {
  it("uses an Elo-like expected score on the rank scale", () => {
    expect(expectedScore(10, 10)).toBeCloseTo(0.5);
    expect(expectedScore(11, 10)).toBeCloseTo(0.68, 2);
    expect(expectedScore(10, 13)).toBeCloseTo(0.09, 2);
    expect(botStrength(settings)).toBe(10);
    expect(botStrength({ ...settings, handicap: 2 })).toBe(7); // stones help the learner as Black
    expect(botStrength({ ...settings, handicap: 2, humanColor: "W" })).toBe(13);
  });

  it("waits for the rank estimate: a rated game comes back pending and marks the profile estimating", () => {
    const p = defaultProfile();
    const update = applyGame(p, game());
    expect(update.rating).toEqual({ before: 10, after: 10, rated: true, pending: true, nextBotRank: "20k", nextHandicap: 0 });
    expect(p.estimating).toEqual(["g1"]);
    expect(p.ratingHistory).toEqual([]);
    expect(p.gamesPlayed).toBe(1);
  });

  it("keeps every game waiting for its estimate, in order, and reports each as pending until it is in", () => {
    const p = defaultProfile();
    // A game without evaluated moves leaves no recent-game stats: only the waiting list knows it was applied.
    const unevaluated = (id: string) => game({ gameId: id, moves: moves(12).map(({ eval: _e, ...r }) => r) });
    applyGame(p, unevaluated("g1"));
    applyGame(p, unevaluated("g2"));
    expect(p.estimating).toEqual(["g1", "g2"]);
    expect(p.recentGames).toEqual([]);
    // Finished again after a restart: not counted twice, and still pending (g2 didn't replace g1).
    const again = applyGame(p, unevaluated("g1"));
    expect(again.rating).toMatchObject({ rated: true, pending: true });
    expect(p.gamesPlayed).toBe(2);
    applyEstimate(p, estimated(unevaluated("g1"), null));
    expect(p.estimating).toEqual(["g2"]);
    expect(applyGame(p, unevaluated("g2")).rating).toMatchObject({ pending: true });
    applyEstimate(p, estimated(unevaluated("g2"), null));
    expect(p.estimating).toBeUndefined();
  });

  it("never marks the rating model: only the migration does", () => {
    const p = defaultProfile();
    rate(p, game(), null);
    rate(p, game({ gameId: "g2" }), estimateAt(15, 20));
    expect(p.ratingModel).toBeUndefined();
  });

  it("treats a floor estimate as an upper bound, so a learner below 20k stays there and keeps the handicap", () => {
    // Rated 6 (about 24k): three handicap stones against the 20k bot.
    const p = { ...defaultProfile(), rating: 6, ...botFor(6) };
    expect(p.handicap).toBe(3);
    const handicapGame = { ...settings, handicap: 3, komi: 0.5 };
    const floor = estimateAt(10, 30);
    expect(floor.floor).toBe(true);
    // A loss with a "20k or weaker" estimate: the result decides, the floor doesn't pull the rating up to 10.
    const lost = rate(p, game({ settings: handicapGame, won: false }), floor);
    expect(lost.after).toBeLessThan(6);
    expect(lost).toMatchObject({ nextBotRank: "20k", nextHandicap: 4 });
    expect(p.handicap).toBe(4);
    // A win moves it up by the Elo step only, still below 20k.
    const won = rate(p, game({ gameId: "g2", settings: handicapGame }), floor);
    expect(won.after).toBeGreaterThan(lost.after);
    expect(won.after).toBeLessThan(MIN_BOT_RATING);
    expect(p.handicap).toBeGreaterThan(0);
    // Above the floor, a floor estimate still pulls the rating down toward 20k.
    const q = { ...defaultProfile(), rating: 15, ...botFor(15) };
    const down = rate(q, game({ settings: { ...settings, botRank: "15k" }, won: false }), floor);
    expect(down.after).toBeLessThan(11);
    expect(combinedEstimate([{ ts: 0, gameId: "f", rating: 10, botRank: "20k", won: false, estimate: floor }], 7)).toBe(7);
    expect(combinedEstimate([{ ts: 0, gameId: "f", rating: 10, botRank: "20k", won: false, estimate: floor }], 12)).toBe(10);
  });

  it("moves 1.5 ranks per even game for the first five games without an estimate, then settles to 0.5", () => {
    expect([0, 4, 5, 6, 7, 8, 30].map(ratingStep)).toEqual([1.5, 1.5, 1.25, 1, 0.75, 0.5, 0.5]);
    const p = defaultProfile();
    const change = rate(p, game(), null);
    expect(change).toEqual({ before: 10, after: 11.5, rated: true, nextBotRank: "18k", nextHandicap: 0 });
    expect(p.ratingHistory).toEqual([{ ts: 1000, gameId: "g1", rating: 11.5, botRank: "20k", won: true, handicap: 0, delta: 1.5 }]);
    expect(p.botRank).toBe("18k");
    expect(p.estimating).toBeUndefined();
  });

  it("counts resignations, but not games under 10 human moves", () => {
    const p = defaultProfile();
    const short = game({ won: false, humanMoves: 9, result: { winner: "W", margin: 0, reason: "resign" } });
    expect(applyGame(p, short).rating).toMatchObject({ rated: false, before: 10, after: 10 });
    expect(p.estimating).toBeUndefined();
    expect(p.ratingHistory).toEqual([]);
    expect(p.gamesPlayed).toBe(1);
    rate(p, game({ gameId: "g2", won: false, humanMoves: 10, result: { winner: "W", margin: 0, reason: "resign" } }), null);
    expect(p.rating).toBe(8.5);
  });

  it("doesn't count legacy history entries (every game, no delta) as rated games for the step", () => {
    const p = defaultProfile();
    // Before rating adaptation every finished game was logged, short ones too, and the rating never moved.
    p.ratingHistory = Array.from({ length: 9 }, (_, i) => ({ ts: i, gameId: `old${i}`, rating: 10, botRank: "20k", won: false }));
    expect(ratedGames(p)).toBe(0);
    rate(p, game(), null);
    expect(p.rating).toBe(11.5); // the first rated game's step, not the tenth's
    expect(ratedGames(p)).toBe(1);
  });

  it("applies a game only once, even when it is finished again after a restart", () => {
    const p = defaultProfile();
    const mistakes = [{ moveNumber: 3, move: "C3", pointLoss: 6, bestMove: "E5", category: "shape" as const, categorySource: "heuristic" as const }];
    const lost = game({ won: false, result: { winner: "W", margin: 0, reason: "resign" }, summary: { moves: 24, mistakes, totalPointLoss: 12 } });
    const first = applyGame(p, lost);
    const snapshot = structuredClone(p);
    const again = applyGame(p, lost);
    expect(p).toEqual(snapshot);
    expect(again.rating).toEqual(first.rating); // still pending
    const rated = applyEstimate(p, estimated(lost, estimateAt(15, 20)));
    const afterRating = structuredClone(p);
    expect(applyEstimate(p, estimated(lost, estimateAt(25, 20)))).toEqual(rated);
    expect(p).toEqual(afterRating);
    expect(applyGame(p, lost).rating).toEqual(rated);
    expect(p.ratingHistory).toHaveLength(1);
    expect(p.mistakeCounts.shape).toBe(1);
    // An unrated game is recognized by its recent-game stats.
    const short = game({ gameId: "g2", humanMoves: 5 });
    applyGame(p, short);
    const count = p.gamesPlayed;
    expect(applyGame(p, short).rating).toMatchObject({ rated: false, before: p.rating, after: p.rating });
    expect(p.gamesPlayed).toBe(count);
  });

  it("follows the move-quality estimate, with the result as a light nudge", () => {
    const p = defaultProfile();
    // A win against the 20k bot: Elo says 11.5; the moves say 10k (20). 0.8 × 20 + 0.2 × 11.5.
    const change = rate(p, game(), estimateAt(20, 30));
    expect(change).toEqual({ before: 10, after: 18.3, rated: true, nextBotRank: "12k", nextHandicap: 0, estimate: estimateAt(20, 30) });
    expect(p.ratingHistory[0]).toMatchObject({ rating: 18.3, delta: 8.3, estimate: estimateAt(20, 30) });
    // Help shrinks the nudge: half the moves assisted halves its weight (0.9 × 20 + 0.1 × Elo).
    const q = defaultProfile();
    const helped = applyGame(q, game());
    expect(helped.rating.pending).toBe(true);
    const r = applyEstimate(q, { ...estimated(game(), estimateAt(20, 30)), assistedMoves: 6 });
    expect(r.after).toBe(round2(0.9 * 20 + 0.1 * 11.5));
  });

  it("combines the games' estimates weighted by moves and recency", () => {
    const entry = (rating: number, moves: number) => ({ ts: 0, gameId: `g${rating}`, rating, botRank: "20k", won: true, estimate: estimateAt(rating, moves) });
    expect(combinedEstimate([])).toBeNull();
    expect(combinedEstimate([{ ts: 0, gameId: "old", rating: 12, botRank: "20k", won: true, delta: 1 }])).toBeNull();
    // The older game weighs 0.8 × its 30 moves, the newer one its 30 moves.
    expect(combinedEstimate([entry(10, 30), entry(20, 30)])).toBeCloseTo((0.8 * 30 * 10 + 30 * 20) / (0.8 * 30 + 30));
    // A game with more unassisted moves counts more.
    expect(combinedEstimate([entry(10, 90), entry(20, 10)])).toBeCloseTo((0.8 * 90 * 10 + 10 * 20) / (0.8 * 90 + 10));
    // Without a new estimate the earlier games' estimates keep deciding.
    const p = defaultProfile();
    rate(p, game({ gameId: "a" }), estimateAt(20, 30));
    const next = rate(p, game({ gameId: "b", won: false }), null);
    expect(next.after).toBeGreaterThan(17);
    expect(next.estimate).toBeUndefined();
  });

  it("keeps the bot at 20k and gives 9x9 handicap stones below it", () => {
    expect(botFor(10)).toEqual({ botRank: "20k", handicap: 0 });
    expect(botFor(9.6)).toEqual({ botRank: "20k", handicap: 0 });
    expect(botFor(8.4)).toEqual({ botRank: "20k", handicap: 2 });
    expect(botFor(5.6)).toEqual({ botRank: "20k", handicap: 3 });
    expect(botFor(1)).toEqual({ botRank: "20k", handicap: 4 });
    expect(botFor(14.4)).toEqual({ botRank: "16k", handicap: 0 });
    expect(botFor(40)).toEqual({ botRank: "9d", handicap: 0 });

    const p = { ...defaultProfile(), rating: 9 };
    const update = rate(p, game({ won: false }), null);
    expect(p.rating).toBeLessThan(8.5);
    expect(update).toMatchObject({ nextBotRank: "20k", nextHandicap: 2 });
    expect(p.handicap).toBe(2);
  });
});

describe("taken-back first attempts", () => {
  it("count in the mistake tallies and the game stats, keyed apart from the move that replaced them", () => {
    const p = defaultProfile();
    const g = game();
    const first = { ...g.moves[2]!, move: { color: "B" as const, point: { x: 8, y: 4 } }, eval: { ...g.moves[2]!.eval!, pointLoss: 9 } };
    applyGame(p, {
      ...g,
      takenBack: [{ moveNumber: 3, record: first, by: "tutor", ts: 900, before: ["A9", "A1"], heuristic: "tactics" }],
      summary: {
        moves: 24,
        totalPointLoss: 21,
        mistakes: [
          { moveNumber: 3, move: "J5", pointLoss: 9, bestMove: "E5", category: "tactics", categorySource: "heuristic", takenBack: 0 },
          { moveNumber: 3, move: "C9", pointLoss: 5, bestMove: "E5", category: "shape", categorySource: "heuristic" },
        ],
      },
    });
    expect(p.mistakeCounts).toMatchObject({ tactics: 1, shape: 1 });
    expect(p.recentMistakes.map((m) => [m.moveNumber, m.category, m.takenBack])).toEqual([
      [3, "tactics", 0],
      [3, "shape", undefined],
    ]);
    // 12 moves on the board plus the first attempt.
    expect(p.recentGames[0]).toMatchObject({ humanMoves: 13, avgPointLoss: round2((12 + 9) / 13), mistakes: 2 });
    // A tag on the first attempt replaces its own entry only.
    applyTag(p, { ts: 2000, gameId: "g1", moveNumber: 3, category: "life_and_death", pointLoss: 9, takenBack: 0 }, "tactics");
    expect(p.recentMistakes.map((m) => [m.moveNumber, m.category, m.takenBack])).toEqual([
      [3, "life_and_death", 0],
      [3, "shape", undefined],
    ]);
    expect(p.mistakeCounts).toMatchObject({ tactics: 0, life_and_death: 1, shape: 1 });
  });
});

describe("mistake threshold", () => {
  const mistakes = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ moveNumber: 2 * i + 1, move: "E5", pointLoss: 5, bestMove: "D4", category: "other" as const, categorySource: "heuristic" as const }));

  it("rises by 0.5 after a 9x9 game with more than 6 teaching moments, up to 6", () => {
    const p = defaultProfile();
    const update = applyGame(p, game({ summary: { moves: 24, mistakes: mistakes(7), totalPointLoss: 35 } }));
    expect(update.threshold).toEqual({ from: 4, to: 4.5, reason: "7 teaching moments in one 9×9 game" });
    expect(p.mistakeThreshold).toBe(4.5);
    expect(p.thresholdHistory).toEqual([{ ts: 1000, gameId: "g1", from: 4, to: 4.5, reason: "7 teaching moments in one 9×9 game" }]);
    p.mistakeThreshold = 6;
    expect(applyGame(p, game({ summary: { moves: 24, mistakes: mistakes(7), totalPointLoss: 35 } })).threshold).toBeUndefined();
  });

  it("drops by 0.5 after three games at it averaging under 1.5 points per move, down to 2", () => {
    const p = defaultProfile();
    expect(applyGame(p, game({ gameId: "a", loss: 1 })).threshold).toBeUndefined();
    expect(applyGame(p, game({ gameId: "b", loss: 1 })).threshold).toBeUndefined();
    expect(applyGame(p, game({ gameId: "c", loss: 1 })).threshold).toMatchObject({ from: 4, to: 3.5 });
    // The next lowering waits for three games at the new threshold.
    expect(applyGame(p, game({ gameId: "d", loss: 1, threshold: 3.5 })).threshold).toBeUndefined();
    expect(applyGame(p, game({ gameId: "e", loss: 1, threshold: 3.5 })).threshold).toBeUndefined();
    expect(applyGame(p, game({ gameId: "f", loss: 1, threshold: 3.5 })).threshold).toMatchObject({ from: 3.5, to: 3 });
    expect(p.recentGames.at(-1)).toEqual({ ts: 1000, gameId: "f", size: 9, humanMoves: 12, avgPointLoss: 1, mistakes: 0, threshold: 3.5 });

    const careless = defaultProfile();
    for (const id of ["a", "b", "c"]) applyGame(careless, game({ gameId: id, loss: 2 }));
    expect(careless.mistakeThreshold).toBe(4);

    const low = { ...defaultProfile(), mistakeThreshold: 2 };
    for (const id of ["a", "b", "c"]) applyGame(low, game({ gameId: id, loss: 0.5, threshold: 2 }));
    expect(low.mistakeThreshold).toBe(2);
  });
});

describe("mistake tallies", () => {
  it("counts heuristic categories at game end and lets tutor tags replace them", () => {
    const p = defaultProfile();
    applyGame(p, {
      ...game(),
      summary: {
        moves: 24,
        totalPointLoss: 20,
        mistakes: [
          { moveNumber: 9, move: "C3", pointLoss: 6, bestMove: "D4", category: "shape", categorySource: "heuristic" },
          { moveNumber: 3, move: "E5", pointLoss: 5, bestMove: "D4", category: "life_and_death", categorySource: "tutor" },
          { moveNumber: 15, move: "G7", pointLoss: 4, bestMove: "D4", category: "endgame", categorySource: "heuristic" },
        ],
      },
    });
    // The tutor's tag was counted when it was made.
    expect(p.mistakeCounts).toMatchObject({ shape: 1, endgame: 1, life_and_death: 0 });
    expect(p.recentMistakes.map((m) => m.moveNumber)).toEqual([15, 9]);

    applyTag(p, { ts: 2000, gameId: "g1", moveNumber: 9, category: "direction", pointLoss: 6, note: "toward thickness" }, "shape");
    expect(p.mistakeCounts).toMatchObject({ shape: 0, direction: 1 });
    expect(p.recentMistakes.map((m) => [m.moveNumber, m.category])).toEqual([
      [9, "direction"],
      [15, "endgame"],
    ]);
    expect(p.practiced.direction).toBe(1);
  });

  it("keeps at most 50 recent mistakes", () => {
    const p = defaultProfile();
    for (let i = 1; i <= 60; i++) applyTag(p, { ts: i, gameId: "g", moveNumber: i, category: "other", pointLoss: 5 });
    expect(p.recentMistakes).toHaveLength(50);
    expect(p.recentMistakes[0]!.moveNumber).toBe(60);
    expect(p.mistakeCounts.other).toBe(60);
  });

  it("counts solved problems and marks a problem's category as practiced either way", () => {
    const p = { ...defaultProfile(), gamesPlayed: 4 };
    applyProblemResult(p, "tactics", true);
    applyProblemResult(p, "shape", false);
    expect(p.problemsSolved).toBe(1);
    expect(p.practiced).toEqual({ tactics: 4, shape: 4 });
    // A practiced category gets no coverage boost, so focus moves elsewhere.
    expect(recommendFocus({ ...p, practiced: { ...p.practiced, life_and_death: 4 } }).category).not.toBe("life_and_death");
  });
});

describe("recommendFocus", () => {
  const ALL: MistakeCategory[] = ["life_and_death", "capturing_race", "opening", "direction", "shape", "endgame", "tactics", "other"];

  /** A profile with `games` recorded games (g1 oldest) and the given mistakes. */
  function profile(games: number, mistakes: [gameIndex: number, MistakeCategory][], practicedAll = true): Profile {
    const p = defaultProfile();
    p.gamesPlayed = games;
    p.recentGames = Array.from({ length: games }, (_, i) => ({ ts: i, gameId: `g${i + 1}`, size: 9, humanMoves: 20, avgPointLoss: 1, mistakes: 0, threshold: 4 }));
    p.recentMistakes = mistakes
      .map(([g, category], i) => ({ ts: g * 100 + i, gameId: `g${g}`, moveNumber: i + 1, category, pointLoss: 5 }))
      .sort((a, b) => b.ts - a.ts);
    if (practicedAll) p.practiced = Object.fromEntries(ALL.map((c) => [c, games]));
    return p;
  }

  it("starts a newcomer with a game", () => {
    const focus = recommendFocus(defaultProfile());
    expect(focus).toMatchObject({ category: "life_and_death", suggestion: "game" });
    expect(focus.reason).toMatch(/No mistakes recorded yet/);
  });

  it("picks the category that keeps coming back, and suggests problems for a local one", () => {
    const focus = recommendFocus(profile(4, [[3, "shape"], [4, "shape"], [4, "direction"], [1, "opening"]]));
    expect(focus.category).toBe("shape");
    expect(focus.suggestion).toBe("problems");
    expect(focus.reason).toMatch(/shape keeps costing points: 2 mistakes in the last 3 games, 2 of the last 4 recorded/);
    // Direction is better learned in games.
    expect(recommendFocus(profile(4, [[3, "direction"], [4, "direction"]])).suggestion).toBe("game");
  });

  it("doesn't say a category keeps costing points when the last 3 games had none of it", () => {
    const old: [number, MistakeCategory][] = Array.from({ length: 8 }, () => [2, "opening"]);
    const focus = recommendFocus(profile(5, old));
    expect(focus.category).toBe("opening");
    expect(focus.reason).not.toMatch(/keeps costing/);
    expect(focus.reason).toBe("opening cost the most points in earlier games (8 of the last 8 recorded mistakes), with none in the last 3 games.");
  });

  it("weights recent games over old ones", () => {
    expect(recommendFocus(profile(8, [[1, "shape"], [1, "shape"], [8, "tactics"]])).category).toBe("tactics");
  });

  it("boosts a category that hasn't been worked on, for balance", () => {
    const p = profile(8, [[1, "opening"]]);
    p.practiced = { ...p.practiced, endgame: undefined };
    delete p.practiced.endgame;
    const focus = recommendFocus(p);
    expect(focus.category).toBe("endgame");
    expect(focus.suggestion).toBe("game");
    expect(focus.reason).toMatch(/endgame hasn't been worked on yet/);
    // A real pattern still beats the boost.
    expect(recommendFocus({ ...p, recentMistakes: profile(8, [[7, "opening"], [8, "opening"]]).recentMistakes }).category).toBe("opening");
  });

  it("never recommends 'other'", () => {
    expect(recommendFocus(profile(3, [[1, "other"], [2, "other"], [3, "other"]])).category).not.toBe("other");
  });
});

describe("mistakeKey", () => {
  it("names a mistake the same way for tallies, problem sources and the migration", () => {
    expect(mistakeKey({ gameId: "20261016-120049", moveNumber: 55 })).toBe("20261016-120049#55");
    expect(mistakeKey({ gameId: "g1", moveNumber: 3, takenBack: 0 })).toBe("g1#3#t0");
    // A stored problem source and a profile entry for the same move match (older data has no `takenBack`).
    const source = { gameId: "g1", moveNumber: 3, played: "C3" };
    const entry = { ts: 1, gameId: "g1", moveNumber: 3, category: "shape" as const, pointLoss: 5 };
    expect(mistakeKey(source)).toBe(mistakeKey(entry));
    expect(mistakeKey({ ...entry, takenBack: 0 })).not.toBe(mistakeKey(entry));
    expect(mistakeKey({ gameId: "g1", moveNumber: 13 })).not.toBe(mistakeKey({ gameId: "g11", moveNumber: 3 }));
  });

  it("lets a tag replace only the same game's entry", () => {
    const p = defaultProfile();
    p.recentMistakes = [
      { ts: 1, gameId: "g1", moveNumber: 3, category: "shape", pointLoss: 5 },
      { ts: 1, gameId: "g2", moveNumber: 3, category: "shape", pointLoss: 5 },
    ];
    applyTag(p, { ts: 2, gameId: "g1", moveNumber: 3, category: "tactics", pointLoss: 5 }, "shape");
    expect(p.recentMistakes.map((m) => [m.gameId, m.category])).toEqual([
      ["g1", "tactics"],
      ["g2", "shape"],
    ]);
  });
});
