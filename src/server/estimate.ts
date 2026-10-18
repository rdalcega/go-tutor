// Rank estimate from move quality: how likely the learner's own moves are under KataGo's human-SL
// model at a ladder of ranks. Each unassisted human move is scored against the human policy of the
// position at every rank profile; the rank whose policy explains the moves best (maximum
// likelihood, interpolated between profiles) is the game's estimate. Mostly pure; `estimateRank`
// makes the KataGo queries.

import { GoGame, movesFromLine } from "../engine/index.ts";
import { moveGtp, toGtp } from "../shared/coords.ts";
import { rankToRating } from "../shared/rank.ts";
import { round2 } from "../shared/text.ts";
import type { AssistCounts, GameSettings, Gtp, Move, MoveRecord, RankEstimate, TakenBackMove } from "../shared/types.ts";
import { BACKGROUND_PRIORITY, humanMoveProbability, humanPolicyOptions, type Analysis, type AnalyzeOptions, type Position } from "./katago.ts";

/** The human-SL profiles the likelihood is measured at, weakest first. */
export const ESTIMATE_RANKS = ["20k", "18k", "15k", "12k", "10k", "8k", "5k", "3k", "1k", "1d", "3d", "5d", "9d"] as const;
export const ESTIMATE_RATINGS: readonly number[] = ESTIMATE_RANKS.map(rankToRating);
/** A move's probability is floored here, so one move the model finds absurd doesn't decide the fit. */
export const POLICY_FLOOR = 1e-3;
/**
 * The first moves of a game are left out (moves up to this number: on 9×9 each side's first two).
 * Every rank opens much the same way on a small board, so they say little about strength, and one
 * unusual opening move swung a 5k bot's 9×9 game from 5k to 1d in the validation runs.
 */
export function openingSkip(size: number): number {
  return size <= 9 ? 4 : size <= 13 ? 8 : 16;
}
/** A game needs this many unassisted moves for an estimate of its own. */
export const MIN_ESTIMATE_MOVES = 5;

/** One move to score: the position before it and the move played there (by the side to move). */
export interface RankSample {
  position: Position;
  move: Gtp;
}

/** The KataGo position after `moves` from the game's settings (handicap stones included). */
export function positionFor(settings: Pick<GameSettings, "size" | "komi" | "handicap">, moves: readonly Move[]): Position {
  const start = new GoGame(settings.size, settings.komi, settings.handicap);
  return {
    size: settings.size,
    komi: settings.komi,
    rules: "chinese",
    moves: moves.map((m) => [m.color, moveGtp(m, settings.size)]),
    initialStones: start.initialStones.map((s) => [s.color, toGtp(s.point, settings.size)]),
    initialPlayer: start.initialPlayer,
  };
}

/** Whether a human move counts for the estimate: it got no help, and it isn't a pass or an opening move. */
export function countsForEstimate(record: MoveRecord, size: number): boolean {
  return !record.assist?.length && !("pass" in record.move) && record.number > openingSkip(size);
}

/**
 * The learner's unassisted moves of a game as samples: the final moves and the taken-back ones
 * (each played in its own position), without passes, opening moves or any move played with help.
 */
export function rankSamples(settings: GameSettings, moves: readonly MoveRecord[], takenBack: readonly TakenBackMove[] = []): RankSample[] {
  const samples: RankSample[] = [];
  moves.forEach((r, i) => {
    if (r.move.color !== settings.humanColor || !countsForEstimate(r, settings.size)) return;
    samples.push({ position: positionFor(settings, moves.slice(0, i).map((m) => m.move)), move: moveGtp(r.move, settings.size) });
  });
  for (const t of takenBack) {
    if (!countsForEstimate(t.record, settings.size)) continue;
    try {
      samples.push({ position: positionFor(settings, movesFromLine(settings, t.before)), move: moveGtp(t.record.move, settings.size) });
    } catch {
      // A line that doesn't name points on this board: leave the move out.
    }
  }
  return samples;
}

/** Summed log-probability of the moves under each profile. `probs[i][j]`: move i's probability under profile j. */
export function logLikelihoods(probs: readonly (readonly number[])[], profiles: number, floor = POLICY_FLOOR): number[] {
  const ll = new Array<number>(profiles).fill(0);
  for (const row of probs) for (let j = 0; j < profiles; j++) ll[j]! += Math.log(Math.max(floor, row[j] ?? 0));
  return ll;
}

/**
 * Where the log-likelihood curve peaks, on the rank scale: the best profile, moved toward its better
 * neighbor by a parabola through the best and its two neighbors (unevenly spaced), clamped to them.
 * At either end of the range it is that end.
 */
export function peakRating(ratings: readonly number[], ll: readonly number[]): number {
  let best = 0;
  for (let j = 1; j < ll.length; j++) if (ll[j]! > ll[best]!) best = j;
  if (best === 0 || best === ll.length - 1) return ratings[best]!;
  const [x0, x1, x2] = [ratings[best - 1]!, ratings[best]!, ratings[best + 1]!];
  const [y0, y1, y2] = [ll[best - 1]!, ll[best]!, ll[best + 1]!];
  const denom = (x1 - x0) * (y1 - y2) - (x1 - x2) * (y1 - y0);
  if (denom === 0) return x1;
  const vertex = x1 - 0.5 * (((x1 - x0) ** 2) * (y1 - y2) - ((x1 - x2) ** 2) * (y1 - y0)) / denom;
  return Math.min(x2, Math.max(x0, vertex));
}

/** The maximum-likelihood rank for these move probabilities (one row per move, one column per profile), or null without moves. */
export function fitRank(probs: readonly (readonly number[])[], ratings: readonly number[] = ESTIMATE_RATINGS): { rating: number; floor: boolean } | null {
  if (probs.length === 0) return null;
  const rating = round2(peakRating(ratings, logLikelihoods(probs, ratings.length)));
  return { rating, floor: rating <= ratings[0]! };
}

/** What the estimate needs from KataGo. */
export interface PolicyEngine {
  analyze(pos: Position, opts?: AnalyzeOptions): Promise<Analysis>;
  concurrency?: number;
}

/**
 * The human-SL probability of each sample's move at each profile: one query per position and
 * profile, one visit each (only the policy is read), a few at a time and below every other query
 * in priority, so a game in progress never waits behind them.
 */
export async function movePolicies(engine: PolicyEngine, samples: readonly RankSample[], ranks: readonly string[] = ESTIMATE_RANKS): Promise<number[][]> {
  const probs = samples.map(() => new Array<number>(ranks.length).fill(0));
  const jobs = samples.flatMap((_, i) => ranks.map((_, j) => [i, j] as const));
  // Once one query fails the estimate is lost: the other workers stop taking jobs.
  let failed = false;
  const run = async (): Promise<void> => {
    for (let job = jobs.shift(); job && !failed; job = jobs.shift()) {
      const [i, j] = job;
      const sample = samples[i]!;
      try {
        const analysis = await engine.analyze(sample.position, humanPolicyOptions(ranks[j]!, { priority: BACKGROUND_PRIORITY }));
        probs[i]![j] = humanMoveProbability(analysis, sample.move, sample.position.size);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  // Twice KataGo's concurrency keeps it busy without filling its queue.
  const workers = Math.max(1, Math.min(jobs.length, 2 * (engine.concurrency ?? 1)));
  await Promise.all(Array.from({ length: workers }, run));
  return probs;
}

/**
 * The game's rank estimate from its unassisted moves, or null with fewer than MIN_ESTIMATE_MOVES of
 * them (too few to say anything). Throws when KataGo fails.
 */
export async function estimateRank(engine: PolicyEngine, samples: readonly RankSample[], help: AssistCounts): Promise<RankEstimate | null> {
  if (samples.length < MIN_ESTIMATE_MOVES) return null;
  const fit = fitRank(await movePolicies(engine, samples));
  if (!fit) return null;
  return { rating: fit.rating, floor: fit.floor, moves: samples.length, ...help };
}
