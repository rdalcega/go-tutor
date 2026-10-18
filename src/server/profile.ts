// Learner memory: rank adaptation after each game, mistake categories (heuristic, overridden by the
// tutor's tags), the adaptive mistake threshold, and what to teach next. Pure functions over the
// Profile; the controller loads and saves it.

import { GoGame, getCell, groupAt, neighbors, opponent } from "../engine/index.ts";
import { moveGtp, movePoint, pointKey, tryFromGtp } from "../shared/coords.ts";
import { clampRating, rankToRating, ratingToRank } from "../shared/rank.ts";
import { categoryLabel, plural, round1, round2 } from "../shared/text.ts";
import { sizeText, thresholdMultiplier } from "../shared/threshold.ts";
import type {
  AssistCounts,
  Board,
  Color,
  FocusRecommendation,
  GameResult,
  GameSettings,
  GameSummary,
  Gtp,
  MistakeCategory,
  Move,
  MoveRecord,
  Point,
  Profile,
  RankEstimate,
  RatingChange,
  TakenBackMove,
} from "../shared/types.ts";

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

/** Games with fewer human moves than this don't change the rating. */
export const MIN_RATED_MOVES = 10;
/** KataGo's weakest human-SL profile, 20k, on the rank scale. */
export const MIN_BOT_RATING = rankToRating("20k");
export const MAX_BOT_RATING = rankToRating("9d");
export const MAX_HANDICAP = 4;
/** Rank gap that makes the stronger side's expected score 1 / (1 + 10^-1) ≈ 0.91. */
const RANK_SPREAD = 3;
/** Rating step for an even game won (or lost): K/2 in Elo terms. Large early, small once settled. */
const STEP_EARLY = 1.5;
const STEP_LATE = 0.5;
const EARLY_GAMES = 5;

/**
 * Rough worth of one handicap stone in ranks. On 19×19 a stone is about a rank; on smaller boards
 * each stone is a bigger share of the board.
 */
export function stoneRanks(size: number): number {
  return size <= 9 ? 1.5 : size <= 13 ? 1.25 : 1;
}

/** Expected score (0..1) of a player rated `rating` against an opponent of strength `opponent`. */
export function expectedScore(rating: number, opponent: number): number {
  return 1 / (1 + 10 ** ((opponent - rating) / RANK_SPREAD));
}

/** The bot's effective strength on the rank scale: its rank, minus handicap stones given to the learner. */
export function botStrength(settings: Pick<GameSettings, "botRank" | "handicap" | "size" | "humanColor">): number {
  const stones = settings.handicap >= 2 ? settings.handicap * stoneRanks(settings.size) : 0;
  const bot = rankToRating(settings.botRank);
  // Handicap stones are Black's: they help the learner when the learner is Black.
  return settings.humanColor === "B" ? bot - stones : bot + stones;
}

/**
 * Rated games so far: `ratingHistory` entries with a `delta`. Profiles from before rating
 * adaptation logged every finished game (short ones too) without one, and those games never moved
 * the rating, so they don't shrink the step.
 */
export function ratedGames(profile: Pick<Profile, "ratingHistory">): number {
  return profile.ratingHistory.filter((e) => e.delta !== undefined).length;
}

/** Rating step after `ratedGames` rated games: 1.5 for the first five, then down to 0.5. */
export function ratingStep(ratedGames: number): number {
  if (ratedGames < EARLY_GAMES) return STEP_EARLY;
  return Math.max(STEP_LATE, STEP_EARLY - 0.25 * (ratedGames - EARLY_GAMES + 1));
}

/**
 * The bot for a rating, so the learner wins about half the time: the nearest human-SL rank (20k … 9d).
 * Below 20k the bot stays at 20k and the learner takes 9×9 handicap stones (2–4) when that is the
 * nearer match for their strength.
 */
export function botFor(rating: number): { botRank: string; handicap: number } {
  const rounded = Math.round(rating);
  if (rounded >= MIN_BOT_RATING) return { botRank: ratingToRank(Math.min(rounded, MAX_BOT_RATING)), handicap: 0 };
  let handicap = 0;
  let gap = Math.abs(MIN_BOT_RATING - rating);
  for (let stones = 2; stones <= MAX_HANDICAP; stones++) {
    const g = Math.abs(MIN_BOT_RATING - stones * stoneRanks(9) - rating);
    if (g < gap) {
      gap = g;
      handicap = stones;
    }
  }
  return { botRank: ratingToRank(MIN_BOT_RATING), handicap };
}

// ---------------------------------------------------------------------------
// After a game
// ---------------------------------------------------------------------------

export const MIN_THRESHOLD = 2;
export const MAX_THRESHOLD = 6;
/**
 * A 9×9 game with more teaching moments than this interrupts too often: raise the threshold. Other
 * sizes scale the limit like the threshold (`maxMoments`: 9 on 13×13, 12 on 19×19).
 */
const MAX_MOMENTS_9X9 = 6;
/**
 * Average loss per human move over the last 3 games below this: lower the threshold. Each game's
 * average is first divided by its board's threshold multiplier, so it is on the 9×9 scale.
 */
const LOW_AVG_LOSS = 1.5;
/** Mistakes kept in `recentMistakes` (the migration keeps the same window). */
export const RECENT_MISTAKES_CAP = 50;
const RECENT_GAMES_CAP = 20;

export interface FinishedGame {
  gameId: string;
  ts: number;
  settings: GameSettings;
  result: GameResult;
  moves: MoveRecord[];
  /** The human moves that were taken back (their first attempts). */
  takenBack?: readonly TakenBackMove[];
  /** With categories filled in (tutor tags, else heuristics), taken-back mistakes included. */
  summary: GameSummary;
  /** The profile's (9×9) mistake threshold the game was played with; its board's is `thresholdFor(threshold, size)`. */
  threshold: number;
}

/** Whether a finished game moves the rating: played to a result, with 10+ human moves. */
export function isRated(game: Pick<FinishedGame, "result" | "moves" | "settings">): boolean {
  return game.result.reason !== "abandon" && game.moves.filter((r) => r.move.color === game.settings.humanColor).length >= MIN_RATED_MOVES;
}

export interface GameUpdate {
  rating: RatingChange;
  threshold?: { from: number; to: number; reason: string };
}

/** Whether `gameId` was already applied to the profile (it is in the rating history, the recent games or waiting for its estimate). */
export function gameApplied(profile: Profile, gameId: string): boolean {
  return profile.ratingHistory.some((e) => e.gameId === gameId) || profile.recentGames.some((g) => g.gameId === gameId) || isEstimating(profile, gameId);
}

/** Whether `gameId` is a finished rated game whose rank estimate hasn't been applied yet. */
export function isEstimating(profile: Pick<Profile, "estimating">, gameId: string): boolean {
  return profile.estimating?.includes(gameId) ?? false;
}

/** Marks a finished game as waiting for its rank estimate (at the end of the list, once). */
export function markEstimating(profile: Profile, gameId: string): void {
  profile.estimating = [...(profile.estimating ?? []).filter((id) => id !== gameId), gameId];
}

/** The game's rank estimate is in (or never will be): it no longer waits. */
export function clearEstimating(profile: Profile, gameId: string): void {
  const rest = (profile.estimating ?? []).filter((id) => id !== gameId);
  if (rest.length) profile.estimating = rest;
  else delete profile.estimating;
}

/** The recorded rating change of a game already in the rating history, or null. */
function recordedChange(profile: Profile, gameId: string): RatingChange | null {
  const entry = profile.ratingHistory.find((e) => e.gameId === gameId && e.delta !== undefined);
  if (!entry) return null;
  return {
    before: round2(entry.rating - entry.delta!),
    after: entry.rating,
    rated: true,
    nextBotRank: profile.botRank,
    nextHandicap: profile.handicap,
    ...(entry.estimate && { estimate: entry.estimate }),
  };
}

/**
 * Which mistake: the game, the move number and, for a taken-back first attempt, its index in
 * `SavedGame.takenBack`. Profile tallies, problem sources and the migration all use it.
 */
export function mistakeKey(m: { gameId: string; moveNumber: number; takenBack?: number }): string {
  return `${m.gameId}#${m.moveNumber}${m.takenBack !== undefined ? `#t${m.takenBack}` : ""}`;
}

/** No help yet: the start of a game's `AssistCounts`. */
export function noAssistance(): AssistCounts {
  return { hints: 0, takeBacks: 0, rethinks: 0 };
}

type SummaryMistake = GameSummary["mistakes"][number];

/** A summary entry for an evaluated human move: a final move, or a taken-back first attempt (`takenBack`: its index). */
export function mistakeEntry(record: MoveRecord, size: number, category: MistakeCategory | undefined, tagged: boolean, takenBack?: number): SummaryMistake {
  return {
    moveNumber: record.number,
    move: moveGtp(record.move, size),
    pointLoss: round1(record.eval!.pointLoss),
    bestMove: record.eval!.bestMove,
    ...(category && { category, categorySource: tagged ? ("tutor" as const) : ("heuristic" as const) }),
    ...(takenBack !== undefined && { takenBack }),
  };
}

/**
 * The taken-back first attempts that were mistakes (point loss >= `threshold`) as summary entries,
 * each with the tutor's tag, else `heuristic(t)` (which may work it out and keep it on `t`).
 */
export function firstAttemptMistakes(
  takenBack: readonly TakenBackMove[],
  size: number,
  threshold: number,
  heuristic: (t: TakenBackMove) => MistakeCategory | undefined = (t) => t.heuristic,
): SummaryMistake[] {
  return takenBack.flatMap((t, i) => {
    if (!t.record.eval || t.record.eval.pointLoss < threshold) return [];
    const tagged = t.tag?.category;
    return [mistakeEntry(t.record, size, tagged ?? heuristic(t), !!tagged, i)];
  });
}

/** Mistakes worst first (sorts in place). */
export function worstFirst(mistakes: SummaryMistake[]): SummaryMistake[] {
  return mistakes.sort((a, b) => b.pointLoss - a.pointLoss);
}

/** Every human move of a game: the moves on the board and the taken-back first attempts. */
function humanRecords(moves: readonly MoveRecord[], humanColor: Color, takenBack: readonly TakenBackMove[]): MoveRecord[] {
  return [...moves.filter((r) => r.move.color === humanColor), ...takenBack.map((t) => t.record)];
}

/** A game's total point loss: every human move on the board plus every taken-back first attempt. */
export function totalPointLoss(moves: readonly MoveRecord[], humanColor: Color, takenBack: readonly TakenBackMove[]): number {
  return round1(humanRecords(moves, humanColor, takenBack).reduce((sum, r) => sum + (r.eval?.pointLoss ?? 0), 0));
}

/** The evaluated human moves of a game (first attempts included) and their average loss, as `recentGames` records them; null when none was evaluated. */
export function lossStats(moves: readonly MoveRecord[], humanColor: Color, takenBack: readonly TakenBackMove[]): { humanMoves: number; avgPointLoss: number } | null {
  const evaluated = humanRecords(moves, humanColor, takenBack).filter((r) => r.eval);
  if (evaluated.length === 0) return null;
  return { humanMoves: evaluated.length, avgPointLoss: round2(evaluated.reduce((sum, r) => sum + r.eval!.pointLoss, 0) / evaluated.length) };
}

/**
 * Applies a finished game to the profile (mutating it): heuristic mistake categories (tutor tags
 * were counted when they were made; taken-back first attempts count too), recent-game stats and the
 * threshold. The rating waits for the game's rank estimate (`applyEstimate`): a rated game is
 * marked `estimating` and its change comes back `pending`. A game already applied (the profile was
 * saved but the game wasn't, and it was finished again after a restart) changes nothing; its
 * recorded rating change is returned.
 */
export function applyGame(profile: Profile, game: FinishedGame): GameUpdate {
  const { settings, summary } = game;
  const unchanged = (rated: boolean, pending: boolean): RatingChange => ({
    before: profile.rating,
    after: profile.rating,
    rated,
    ...(pending && { pending }),
    nextBotRank: profile.botRank,
    nextHandicap: profile.handicap,
  });
  if (gameApplied(profile, game.gameId)) {
    // Its estimate may still be waiting (only a rated game gets one).
    const pending = isEstimating(profile, game.gameId);
    return { rating: recordedChange(profile, game.gameId) ?? unchanged(pending, pending) };
  }
  profile.gamesPlayed++;
  const rated = isRated(game);
  if (rated) markEstimating(profile, game.gameId);

  // Mistakes the tutor didn't tag count under their heuristic category.
  const added = summary.mistakes
    .filter((m) => m.categorySource === "heuristic" && m.category)
    .sort((a, b) => b.moveNumber - a.moveNumber)
    .map((m) => ({
      ts: game.ts,
      gameId: game.gameId,
      moveNumber: m.moveNumber,
      category: m.category!,
      pointLoss: m.pointLoss,
      ...(m.takenBack !== undefined && { takenBack: m.takenBack }),
    }));
  for (const m of added) profile.mistakeCounts[m.category] = (profile.mistakeCounts[m.category] ?? 0) + 1;
  const replaced = new Set(added.map(mistakeKey));
  profile.recentMistakes = [...added, ...profile.recentMistakes.filter((m) => !replaced.has(mistakeKey(m)))].slice(
    0,
    RECENT_MISTAKES_CAP,
  );

  // Game stats and the threshold, first attempts included.
  const stats = lossStats(game.moves, settings.humanColor, game.takenBack ?? []);
  if (stats) {
    profile.recentGames.push({ ts: game.ts, gameId: game.gameId, size: settings.size, ...stats, mistakes: summary.mistakes.length, threshold: game.threshold });
    profile.recentGames = profile.recentGames.slice(-RECENT_GAMES_CAP);
  }
  const threshold = adaptThreshold(profile, game);
  if (threshold) profile.thresholdHistory.push({ ts: game.ts, gameId: game.gameId, ...threshold });

  return { rating: unchanged(rated, rated), ...(threshold && { threshold }) };
}

/** Each older game's rank estimate weighs this much less than the next newer one's (times its moves). */
export const ESTIMATE_DECAY = 0.8;
/** Weight of the win/loss (Elo) signal against the move-quality estimate, for a game played without help. */
export const ELO_WEIGHT = 0.2;

/**
 * The learner's strength from move quality: the games' rank estimates, each weighted by its
 * unassisted moves and by ESTIMATE_DECAY per newer estimated game. Null without any estimate.
 * A floor estimate ("20k or weaker") is only an upper bound: given `belowFloor` (what the results
 * say, the Elo rating) it counts as the lower of the two, so a learner below 20k can stay there.
 */
export function combinedEstimate(history: Profile["ratingHistory"], belowFloor?: number): number | null {
  const estimated = history.filter((e) => e.estimate && e.estimate.moves > 0);
  let weights = 0;
  let sum = 0;
  estimated.forEach((e, i) => {
    const w = ESTIMATE_DECAY ** (estimated.length - 1 - i) * e.estimate!.moves;
    const { rating, floor } = e.estimate!;
    weights += w;
    sum += w * (floor && belowFloor !== undefined ? Math.min(rating, belowFloor) : rating);
  });
  return weights > 0 ? sum / weights : null;
}

/** A rated game's rank estimate (null when it had too few unassisted moves, or KataGo couldn't tell). */
export interface EstimatedGame {
  gameId: string;
  ts: number;
  settings: GameSettings;
  result: GameResult;
  /** Human moves on the board at the end, and how many of them had help. */
  humanMoves: number;
  assistedMoves: number;
  estimate: RankEstimate | null;
}

/**
 * The rating after a rated game (mutating the profile; rating model 2). The move-quality estimate
 * over the recent games (`combinedEstimate`, this one included) decides, and the game's result adds
 * a light Elo nudge: weight ELO_WEIGHT, shrunk by the share of the learner's moves that had help,
 * toward the old rating plus the Elo change (expected score `expectedScore` against the bot's
 * strength, step `ratingStep`). Without any estimate yet, the Elo change alone. A floor estimate
 * ("20k or weaker") counts as at most the Elo rating, so below 20k the results decide. Records the
 * game in `ratingHistory`, clears its `estimating` mark and sets the next bot. A game already
 * recorded changes nothing. It never sets `ratingModel`: only the migration does.
 */
export function applyEstimate(profile: Profile, game: EstimatedGame): RatingChange {
  clearEstimating(profile, game.gameId);
  const recorded = recordedChange(profile, game.gameId);
  if (recorded) return recorded;
  const { settings, result, estimate } = game;
  const before = profile.rating;
  const score = result.winner === null ? 0.5 : result.winner === settings.humanColor ? 1 : 0;
  const elo = before + 2 * ratingStep(ratedGames(profile)) * (score - expectedScore(before, botStrength(settings)));
  const entry: Profile["ratingHistory"][number] = {
    ts: game.ts,
    gameId: game.gameId,
    rating: before,
    botRank: settings.botRank,
    won: score === 1,
    handicap: settings.handicap,
    delta: 0,
    ...(estimate && { estimate }),
  };
  const quality = combinedEstimate([...profile.ratingHistory, entry], elo);
  const helped = game.humanMoves > 0 ? Math.min(1, game.assistedMoves / game.humanMoves) : 0;
  const w = ELO_WEIGHT * (1 - helped);
  const after = round2(clampRating(quality === null ? elo : (1 - w) * quality + w * elo));
  entry.rating = after;
  entry.delta = round2(after - before);
  profile.ratingHistory.push(entry);
  profile.rating = after;
  const next = botFor(after);
  profile.botRank = next.botRank;
  profile.handicap = next.handicap;
  return { before, after, rated: true, nextBotRank: next.botRank, nextHandicap: next.handicap, ...(estimate && { estimate }) };
}

/**
 * Teaching moments in one game above which it interrupted too often: 6 on 9×9, scaled like the
 * threshold (9 on 13×13, 12 on 19×19). A bigger board's game is longer, so it may pause a little
 * more often, but scaling by its length (moves or area: about 27 on 19×19) would let a game stop
 * far too often before the threshold reacts, and would never react to a short or resigned game.
 */
export function maxMoments(size: GameSettings["size"]): number {
  return Math.round(MAX_MOMENTS_9X9 * thresholdMultiplier(size));
}

/**
 * One gentle step of the mistake threshold, or nothing. Mutates profile.mistakeThreshold, the 9×9
 * value, so every board size moves together.
 */
function adaptThreshold(profile: Profile, game: FinishedGame): GameUpdate["threshold"] {
  const from = profile.mistakeThreshold;
  const moments = game.summary.mistakes.length;
  const { size } = game.settings;
  if (moments > maxMoments(size) && from < MAX_THRESHOLD) {
    profile.mistakeThreshold = Math.min(MAX_THRESHOLD, from + 0.5);
    return { from, to: profile.mistakeThreshold, reason: `${moments} teaching moments in one ${sizeText(size)} game` };
  }
  // Lower only after three games at the current threshold, so it moves at most every third game.
  const last = profile.recentGames.slice(-3);
  if (last.length < 3 || from <= MIN_THRESHOLD || last.some((g) => g.threshold !== from)) return undefined;
  // Each game's loss on the 9×9 scale: a 19×19 move that loses 2 points is like a 9×9 move losing 1.
  const moves = last.reduce((n, g) => n + g.humanMoves, 0);
  const avg = last.reduce((sum, g) => sum + (g.avgPointLoss * g.humanMoves) / thresholdMultiplier(g.size), 0) / moves;
  if (avg >= LOW_AVG_LOSS) return undefined;
  profile.mistakeThreshold = Math.max(MIN_THRESHOLD, from - 0.5);
  const scaled = last.some((g) => thresholdMultiplier(g.size) !== 1) ? " (scaled to 9×9)" : "";
  return { from, to: profile.mistakeThreshold, reason: `average loss ${avg.toFixed(1)} pts per move${scaled} over the last 3 games` };
}

/**
 * The tutor tagged a mistake: count it under `category`, replacing whatever it was counted as
 * before (`previous`: an earlier tag, or the heuristic once the game ended). Mutates the profile.
 */
export function applyTag(
  profile: Profile,
  tag: { ts: number; gameId: string; moveNumber: number; category: MistakeCategory; pointLoss: number; note?: string; takenBack?: number },
  previous?: MistakeCategory,
): void {
  if (previous) profile.mistakeCounts[previous] = Math.max(0, (profile.mistakeCounts[previous] ?? 0) - 1);
  profile.mistakeCounts[tag.category] = (profile.mistakeCounts[tag.category] ?? 0) + 1;
  profile.recentMistakes = [tag, ...profile.recentMistakes.filter((m) => mistakeKey(m) !== mistakeKey(tag))].slice(
    0,
    RECENT_MISTAKES_CAP,
  );
  // A tutor tag means the category was discussed: that counts as working on it.
  profile.practiced = { ...profile.practiced, [tag.category]: profile.gamesPlayed };
}

/** A practice problem ended (solved, or the answer was shown): count the solve and mark the category as worked on. Mutates the profile. */
export function applyProblemResult(profile: Profile, category: MistakeCategory, solved: boolean): void {
  if (solved) profile.problemsSolved++;
  profile.practiced = { ...profile.practiced, [category]: profile.gamesPlayed };
}

// ---------------------------------------------------------------------------
// Heuristic mistake categories
// ---------------------------------------------------------------------------

export interface MistakeContext {
  size: number;
  moveNumber: number;
  move: Move;
  /** Stones the move captured. */
  captures: number;
  pointLoss: number;
  /** The mistake threshold in effect; "small" and "large" losses are relative to it. */
  threshold: number;
  bestMove: Gtp;
  /** KataGo's best answer for the opponent after the move, when known. */
  reply?: Gtp;
  boardBefore: Board;
  boardAfter: Board;
  /** KataGo ownership (Black's view, row-major) before and after the move, when known. */
  ownershipBefore?: number[];
  ownershipAfter?: number[];
}

/** Moves up to this number are the opening (9×9: 12, 13×13: 25, 19×19: 54). */
export function openingEnd(size: number): number {
  return Math.round(size * size * 0.15);
}

/** Moves from this number on are the endgame (9×9: 41, 13×13: 85, 19×19: 181). */
export function endgameStart(size: number): number {
  return Math.round(size * size * 0.5);
}

/** Ownership must swing at least this much, changing sign, for a group's (or point's) fate to have flipped. */
const STATUS_SWING = 1;
const STATUS_MIN = 0.3;

/** Whether KataGo's ownership of a group (its average) or a point changed sides for real: both readings clear, and a swing of STATUS_SWING. */
export function ownershipFlipped(before: number, after: number): boolean {
  return Math.sign(after) !== Math.sign(before) && Math.abs(after) >= STATUS_MIN && Math.abs(before) >= STATUS_MIN && Math.abs(after - before) >= STATUS_SWING;
}

export interface Chain {
  color: Color;
  stones: Point[];
  liberties: Set<string>;
}

/** Every chain of stones on the board. */
function chains(board: Board): Chain[] {
  const seen = new Set<string>();
  const out: Chain[] = [];
  board.forEach((row, y) =>
    row.forEach((color, x) => {
      if (!color || seen.has(pointKey({ x, y }))) return;
      const group = groupAt(board, { x, y });
      for (const s of group.stones) seen.add(pointKey(s));
      out.push({ color, stones: group.stones, liberties: group.libertySet });
    }),
  );
  return out;
}

function touches(chain: Chain, other: Chain, size: number): boolean {
  const keys = new Set(other.stones.map(pointKey));
  return chain.stones.some((s) => neighbors(s, size).some((n) => keys.has(pointKey(n))));
}

/** Average ownership of a chain's points from the chain owner's view (+1 = alive and owned). */
function chainOwnership(chain: Chain, ownership: readonly number[], size: number): number {
  const sign = chain.color === "B" ? 1 : -1;
  const sum = chain.stones.reduce((s, p) => s + (ownership[p.y * size + p.x] ?? 0), 0);
  return (sign * sum) / chain.stones.length;
}

/**
 * The chains on `board` whose average ownership (KataGo's, Black's view, row-major) flipped between
 * `before` and `after` (`ownershipFlipped`): groups that died or came to life. None when the
 * ownership arrays don't fit the board.
 */
export function flippedChains(board: Board, before: readonly number[], after: readonly number[]): Chain[] {
  const size = board.length;
  if (before.length !== size * size || after.length !== size * size) return [];
  return chains(board).filter((chain) => ownershipFlipped(chainOwnership(chain, before, size), chainOwnership(chain, after, size)));
}

/** Some group of 2+ stones went from alive to dead (or dead to alive) because of the move. */
function lifeStatusChanged(ctx: MistakeContext): boolean {
  const { ownershipBefore, ownershipAfter } = ctx;
  if (!ownershipBefore || !ownershipAfter) return false;
  return flippedChains(ctx.boardBefore, ownershipBefore, ownershipAfter).some((chain) => chain.stones.length >= 2);
}

/** Adjacent opposing groups both short of liberties (≤ 3), with the played or best move on one of their liberties. */
function isCapturingRace(ctx: MistakeContext, mover: Color, played: Point | null, best: Point | null): boolean {
  const list = chains(ctx.boardBefore);
  const keys = [played, best].filter((p): p is Point => !!p).map(pointKey);
  const low = (c: Chain) => c.stones.length >= 2 && c.liberties.size <= 3;
  return list.some(
    (mine) =>
      mine.color === mover &&
      low(mine) &&
      list.some((theirs) => theirs.color !== mover && low(theirs) && touches(mine, theirs, ctx.size) && keys.some((k) => mine.liberties.has(k) || theirs.liberties.has(k))),
  );
}

/** Stones captured by `color` playing `gtp` on `board`, or 0 if it isn't a legal board move. */
function capturesBy(board: Board, color: Color, gtp: Gtp | undefined): number {
  if (!gtp) return 0;
  const point = tryFromGtp(gtp, board.length);
  if (!point) return 0;
  const result = GoGame.fromBoard(board, color).play({ color, point });
  return result.ok ? result.record.captures.length : 0;
}

/** Captures are involved: the move captured, put its own stones in atari, the best move captured, or the reply captures. */
function involvesCaptures(ctx: MistakeContext, mover: Color, played: Point | null): boolean {
  if (ctx.captures > 0) return true;
  if (played && getCell(ctx.boardAfter, played) && groupAt(ctx.boardAfter, played).liberties === 1) return true;
  return capturesBy(ctx.boardBefore, mover, ctx.bestMove) > 0 || capturesBy(ctx.boardAfter, opponent(mover), ctx.reply) > 0;
}

/** An empty triangle (three own stones in a 2×2 square, the fourth empty) or a clump of four, made by the move. */
export function poorShapeAt(board: Board, p: Point, color: Color): boolean {
  const size = board.length;
  for (const [dx, dy] of [
    [-1, -1],
    [0, -1],
    [-1, 0],
    [0, 0],
  ] as const) {
    const x0 = p.x + dx;
    const y0 = p.y + dy;
    if (x0 < 0 || y0 < 0 || x0 + 1 >= size || y0 + 1 >= size) continue;
    const cells = [board[y0]![x0], board[y0]![x0 + 1], board[y0 + 1]![x0], board[y0 + 1]![x0 + 1]];
    const own = cells.filter((c) => c === color).length;
    const empty = cells.filter((c) => c === null).length;
    if ((own === 3 && empty === 1) || own === 4) return true;
  }
  return false;
}

function manhattan(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * The heuristic category of `record` played on `replay` (the game just before it; the move is
 * played on it), with KataGo's ownership before and after it and its best reply when known.
 * "other" when the move doesn't replay. For final moves and taken-back first attempts alike.
 */
export function classifyPlayed(
  replay: GoGame,
  record: MoveRecord,
  threshold: number,
  before?: { ownership?: number[] },
  after?: { ownership?: number[]; moveInfos: readonly { move: Gtp }[] },
): MistakeCategory {
  const boardBefore = replay.board;
  if (!replay.play(record.move).ok) return "other";
  return classifyMistake({
    size: replay.size,
    moveNumber: record.number,
    move: record.move,
    captures: record.captures.length,
    pointLoss: record.eval?.pointLoss ?? 0,
    threshold,
    bestMove: record.eval?.bestMove ?? "pass",
    reply: after?.moveInfos[0]?.move,
    boardBefore,
    boardAfter: replay.board,
    ...(before?.ownership && { ownershipBefore: before.ownership }),
    ...(after?.ownership && { ownershipAfter: after.ownership }),
  });
}

/**
 * A heuristic category for a mistake, in order: capturing race, life and death (a group's status
 * flips in KataGo's ownership), tactics (captures or atari involved), opening and endgame by move
 * number, shape (a small or local loss with an empty triangle or clump), direction (a large loss
 * with the best move 4+ lines away), else other. The tutor's `tag` overrides it.
 */
export function classifyMistake(ctx: MistakeContext): MistakeCategory {
  const mover = ctx.move.color;
  const played = movePoint(ctx.move);
  const best = tryFromGtp(ctx.bestMove, ctx.size) ?? null;
  if (isCapturingRace(ctx, mover, played, best)) return "capturing_race";
  if (lifeStatusChanged(ctx)) return "life_and_death";
  if (involvesCaptures(ctx, mover, played)) return "tactics";
  if (ctx.moveNumber <= openingEnd(ctx.size)) return "opening";
  if (ctx.moveNumber >= endgameStart(ctx.size)) return "endgame";
  const distance = played && best ? manhattan(played, best) : Infinity;
  if (played && poorShapeAt(ctx.boardAfter, played, mover) && (distance <= 3 || ctx.pointLoss < 2 * ctx.threshold)) return "shape";
  if (distance >= 4 && distance !== Infinity && ctx.pointLoss >= 1.5 * ctx.threshold) return "direction";
  return "other";
}

// ---------------------------------------------------------------------------
// What to teach next
// ---------------------------------------------------------------------------

/** Categories worth a focus, in the order a beginner benefits from them (ties go to the earlier one). */
const FOCUS_ORDER: readonly MistakeCategory[] = ["life_and_death", "capturing_race", "tactics", "opening", "shape", "direction", "endgame"];
/** Local skills that practice problems train well. */
const PROBLEM_FRIENDLY = new Set<MistakeCategory>(["life_and_death", "capturing_race", "tactics", "shape"]);
/** Each older game's mistakes weigh this much less than the next newer game's. */
const GAME_DECAY = 0.75;
/** Coverage boost per game since a category was last worked on, and its cap (one recent mistake weighs 1). */
const BOOST_PER_GAME = 0.1;
const MAX_BOOST = 0.5;
/** Recency-weighted mistakes needed before problems beat playing. */
const PROBLEMS_SCORE = 1.5;

/** Game ids newest first: recorded games, then any older games that only appear in recent mistakes. */
function gamesNewestFirst(profile: Profile): string[] {
  const order = [...profile.recentGames].reverse().map((g) => g.gameId);
  const seen = new Set(order);
  for (const m of profile.recentMistakes) {
    if (!seen.has(m.gameId)) {
      seen.add(m.gameId);
      order.push(m.gameId);
    }
  }
  return order;
}

/**
 * What to teach next: recent mistakes (recency-weighted by game) against balanced coverage
 * (categories not worked on for a while get a small boost). Suggests problems when a local
 * category keeps coming back, else a game.
 */
export function recommendFocus(profile: Profile): FocusRecommendation {
  const order = gamesNewestFirst(profile);
  const rank = new Map(order.map((id, i) => [id, i]));
  const weight = new Map<MistakeCategory, number>();
  const lastThree = new Map<MistakeCategory, number>();
  for (const m of profile.recentMistakes) {
    const age = rank.get(m.gameId) ?? order.length;
    weight.set(m.category, (weight.get(m.category) ?? 0) + GAME_DECAY ** age);
    if (age < 3) lastThree.set(m.category, (lastThree.get(m.category) ?? 0) + 1);
  }
  const boost = (c: MistakeCategory) => {
    const at = profile.practiced[c];
    const since = at === undefined ? Infinity : profile.gamesPlayed - at;
    return Math.min(MAX_BOOST, BOOST_PER_GAME * since);
  };
  let best: MistakeCategory = FOCUS_ORDER[0]!;
  let bestScore = -Infinity;
  for (const c of FOCUS_ORDER) {
    const score = (weight.get(c) ?? 0) + boost(c);
    if (score > bestScore + 1e-9) {
      best = c;
      bestScore = score;
    }
  }

  const label = categoryLabel(best);
  const w = weight.get(best) ?? 0;
  const recent = lastThree.get(best) ?? 0;
  const total = profile.recentMistakes.filter((m) => m.category === best).length;
  if (profile.recentMistakes.length === 0) {
    return {
      category: best,
      reason: `No mistakes recorded yet. A game shows KataGo where points go; ${label} is a good first topic.`,
      suggestion: "game",
    };
  }
  const suggestion = w >= PROBLEMS_SCORE && PROBLEM_FRIENDLY.has(best) && profile.gamesPlayed >= 2 ? "problems" : "game";
  if (w >= boost(best) && total > 0) {
    // "Keeps costing" only when it still does: older mistakes alone get their own wording.
    const reason =
      recent > 0
        ? `${label} keeps costing points: ${plural(recent, "mistake")} in the last 3 games, ${total} of the last ${profile.recentMistakes.length} recorded.`
        : `${label} cost the most points in earlier games (${total} of the last ${profile.recentMistakes.length} recorded mistakes), with none in the last 3 games.`;
    return { category: best, reason, suggestion };
  }
  const since = profile.practiced[best];
  const when = since === undefined ? "hasn't been worked on yet" : `hasn't been worked on for ${profile.gamesPlayed - since} games`;
  return {
    category: best,
    reason: `No category stands out (${plural(total, `recent ${label} mistake`)}); ${label} ${when}, so it keeps practice balanced.`,
    suggestion,
  };
}
