// Validates the move-quality rank estimate against the real KataGo: its human-SL bot plays the
// learner's side of short 9x9 games at known ranks against a fixed opponent, and the estimate must
// tell the ranks apart and land near them. Skipped when `katago` is not on PATH. Prints the estimates.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GoGame } from "../../src/engine/index.ts";
import { estimateRank, positionFor, rankSamples } from "../../src/server/estimate.ts";
import { KataGo } from "../../src/server/katago.ts";
import { tryFromGtp } from "../../src/shared/coords.ts";
import { ratingToRank } from "../../src/shared/rank.ts";
import type { GameSettings, MoveRecord } from "../../src/shared/types.ts";
import { hasKataGo } from "./fakes.ts";

/** A seeded RNG (mulberry32), so the bots' sampled moves repeat run to run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const settings: GameSettings = { size: 9, komi: 7, humanColor: "B", botRank: "12k", handicap: 0 };
const OPPONENT = "12k";
const MAX_PLIES = 70;
const GAMES_PER_RANK = 2;

describe.skipIf(!hasKataGo())("rank estimate (real KataGo)", () => {
  const kg = new KataGo({ random: seeded(20261017) });
  const estimates: Record<string, number[]> = {};

  /** One game: the human-SL bot at `rank` plays Black (the learner's side) against the opponent. */
  async function play(rank: string): Promise<MoveRecord[]> {
    const game = new GoGame(settings.size, settings.komi, settings.handicap);
    while (!game.isOver && game.moves.length < MAX_PLIES) {
      const color = game.toPlay;
      const gtp = await kg.botMove(positionFor(settings, game.moves.map((r) => r.move)), color === "B" ? rank : OPPONENT, { maxVisits: 1 });
      const point = gtp === "pass" ? null : tryFromGtp(gtp, settings.size);
      if (!point || !game.play({ color, point }).ok) game.pass();
    }
    return game.moves;
  }

  beforeAll(async () => {
    await kg.start();
  }, 600_000);

  afterAll(async () => {
    await kg.stop();
    console.log("rank estimates by true rank (rating, 20k = 10):", JSON.stringify(estimates));
  });

  for (const rank of ["18k", "5k"]) {
    it(`estimates ${rank} games`, async () => {
      for (let g = 0; g < GAMES_PER_RANK; g++) {
        const moves = await play(rank);
        const estimate = await estimateRank(kg, rankSamples(settings, moves), { hints: 0, takeBacks: 0, rethinks: 0 });
        expect(estimate).not.toBeNull();
        (estimates[rank] ??= []).push(estimate!.rating);
        console.log(`${rank} game ${g + 1}: ${estimate!.moves} moves -> ${estimate!.rating} (${ratingToRank(estimate!.rating)})`);
      }
    }, 300_000);
  }

  it("ranks the 5k games clearly above the 18k ones, near their true ranks", () => {
    const weak = estimates["18k"] ?? [];
    const strong = estimates["5k"] ?? [];
    expect(weak).toHaveLength(GAMES_PER_RANK);
    expect(strong).toHaveLength(GAMES_PER_RANK);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // Every 5k game above every 18k game, by 6+ ranks on average.
    expect(Math.min(...strong)).toBeGreaterThan(Math.max(...weak));
    expect(mean(strong) - mean(weak)).toBeGreaterThanOrEqual(6);
    // Near the true ranks: one 9x9 game's estimate wanders a few ranks (validation runs: 18k games
    // read 20k–15k, 5k games 6k–4k with the opening skipped), and the weak end leans to the 20k floor.
    for (const r of weak) expect(r).toBeLessThanOrEqual(17); // 18k (12): 20k … 13k
    for (const r of strong) {
      expect(r).toBeGreaterThanOrEqual(20); // 5k (25): 10k … 2d
      expect(r).toBeLessThanOrEqual(31);
    }
  });
});
