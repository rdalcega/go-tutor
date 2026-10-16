// Learner memory: rank adaptation after each game, mistake categories (heuristic, overridden by the
// tutor's tags), the adaptive mistake threshold, and what to teach next. Pure functions over the
// Profile; the controller loads and saves it.

import { GoGame, getCell, groupAt, neighbors, opponent } from "../engine/index.ts";
import { movePoint, pointKey, tryFromGtp } from "../shared/coords.ts";
import { clampRating, rankToRating, ratingToRank } from "../shared/rank.ts";
import { categoryLabel } from "../shared/text.ts";
import type {
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
  RatingChange,
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
/** A 9×9 game with more teaching moments than this interrupts too often: raise the threshold. */
const MAX_MOMENTS_9X9 = 6;
/** Average loss per human move over the last 3 games below this: lower the threshold. */
const LOW_AVG_LOSS = 1.5;
const RECENT_MISTAKES_CAP = 50;
const RECENT_GAMES_CAP = 20;

export interface FinishedGame {
  gameId: string;
  ts: number;
  settings: GameSettings;
  result: GameResult;
  moves: MoveRecord[];
  /** With categories filled in (tutor tags, else heuristics). */
  summary: GameSummary;
  /** The mistake threshold the game was played with. */
  threshold: number;
}

export interface GameUpdate {
  rating: RatingChange;
  threshold?: { from: number; to: number; reason: string };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Whether `gameId` was already applied to the profile (it is in the rating history or the recent games). */
export function gameApplied(profile: Profile, gameId: string): boolean {
  return profile.ratingHistory.some((e) => e.gameId === gameId) || profile.recentGames.some((g) => g.gameId === gameId);
}

/**
 * Applies a finished game to the profile (mutating it): rating and next bot, heuristic mistake
 * categories (tutor tags were counted when they were made), recent-game stats and the threshold.
 * A game already applied (the profile was saved but the game wasn't, and it was finished again
 * after a restart) changes nothing; its recorded rating change is returned.
 */
export function applyGame(profile: Profile, game: FinishedGame): GameUpdate {
  const { settings, result, summary } = game;
  if (gameApplied(profile, game.gameId)) {
    const entry = profile.ratingHistory.find((e) => e.gameId === game.gameId && e.delta !== undefined);
    const after = entry?.rating ?? profile.rating;
    const before = entry ? round2(entry.rating - entry.delta!) : profile.rating;
    return { rating: { before, after, rated: !!entry, nextBotRank: profile.botRank, nextHandicap: profile.handicap ?? 0 } };
  }
  const human = game.moves.filter((r) => r.move.color === settings.humanColor);
  profile.gamesPlayed++;

  // Rating.
  const before = profile.rating;
  const rated = result.reason !== "abandon" && human.length >= MIN_RATED_MOVES;
  if (rated) {
    const score = result.winner === null ? 0.5 : result.winner === settings.humanColor ? 1 : 0;
    const delta = 2 * ratingStep(ratedGames(profile)) * (score - expectedScore(before, botStrength(settings)));
    profile.rating = round2(clampRating(before + delta));
    profile.ratingHistory.push({
      ts: game.ts,
      gameId: game.gameId,
      rating: profile.rating,
      botRank: settings.botRank,
      won: score === 1,
      handicap: settings.handicap,
      delta: round2(profile.rating - before),
    });
  }
  const next = botFor(profile.rating);
  profile.botRank = next.botRank;
  profile.handicap = next.handicap;

  // Mistakes the tutor didn't tag count under their heuristic category.
  const added = summary.mistakes
    .filter((m) => m.categorySource === "heuristic" && m.category)
    .sort((a, b) => b.moveNumber - a.moveNumber)
    .map((m) => ({ ts: game.ts, gameId: game.gameId, moveNumber: m.moveNumber, category: m.category!, pointLoss: m.pointLoss }));
  for (const m of added) profile.mistakeCounts[m.category] = (profile.mistakeCounts[m.category] ?? 0) + 1;
  const replaced = new Set(added.map((m) => m.moveNumber));
  profile.recentMistakes = [...added, ...profile.recentMistakes.filter((m) => m.gameId !== game.gameId || !replaced.has(m.moveNumber))].slice(
    0,
    RECENT_MISTAKES_CAP,
  );

  // Game stats and the threshold.
  const evaluated = human.filter((r) => r.eval);
  if (evaluated.length > 0) {
    const loss = evaluated.reduce((sum, r) => sum + r.eval!.pointLoss, 0);
    profile.recentGames.push({
      ts: game.ts,
      gameId: game.gameId,
      size: settings.size,
      humanMoves: evaluated.length,
      avgPointLoss: round2(loss / evaluated.length),
      mistakes: summary.mistakes.length,
      threshold: game.threshold,
    });
    profile.recentGames = profile.recentGames.slice(-RECENT_GAMES_CAP);
  }
  const threshold = adaptThreshold(profile, game);
  if (threshold) profile.thresholdHistory.push({ ts: game.ts, gameId: game.gameId, ...threshold });

  return {
    rating: { before, after: profile.rating, rated, nextBotRank: next.botRank, nextHandicap: next.handicap },
    ...(threshold && { threshold }),
  };
}

/** One gentle step of the mistake threshold, or nothing. Mutates profile.mistakeThreshold. */
function adaptThreshold(profile: Profile, game: FinishedGame): GameUpdate["threshold"] {
  const from = profile.mistakeThreshold;
  const moments = game.summary.mistakes.length;
  if (game.settings.size === 9 && moments > MAX_MOMENTS_9X9 && from < MAX_THRESHOLD) {
    profile.mistakeThreshold = Math.min(MAX_THRESHOLD, from + 0.5);
    return { from, to: profile.mistakeThreshold, reason: `${moments} teaching moments in one 9×9 game` };
  }
  // Lower only after three games at the current threshold, so it moves at most every third game.
  const last = profile.recentGames.slice(-3);
  if (last.length < 3 || from <= MIN_THRESHOLD || last.some((g) => g.threshold !== from)) return undefined;
  const moves = last.reduce((n, g) => n + g.humanMoves, 0);
  const avg = last.reduce((sum, g) => sum + g.avgPointLoss * g.humanMoves, 0) / moves;
  if (avg >= LOW_AVG_LOSS) return undefined;
  profile.mistakeThreshold = Math.max(MIN_THRESHOLD, from - 0.5);
  return { from, to: profile.mistakeThreshold, reason: `average loss ${avg.toFixed(1)} pts per move over the last 3 games` };
}

/**
 * The tutor tagged a mistake: count it under `category`, replacing whatever it was counted as
 * before (`previous`: an earlier tag, or the heuristic once the game ended). Mutates the profile.
 */
export function applyTag(
  profile: Profile,
  tag: { ts: number; gameId: string; moveNumber: number; category: MistakeCategory; pointLoss: number; note?: string },
  previous?: MistakeCategory,
): void {
  if (previous) profile.mistakeCounts[previous] = Math.max(0, (profile.mistakeCounts[previous] ?? 0) - 1);
  profile.mistakeCounts[tag.category] = (profile.mistakeCounts[tag.category] ?? 0) + 1;
  profile.recentMistakes = [tag, ...profile.recentMistakes.filter((m) => m.gameId !== tag.gameId || m.moveNumber !== tag.moveNumber)].slice(
    0,
    RECENT_MISTAKES_CAP,
  );
  // A tutor tag means the category was discussed: that counts as working on it.
  profile.practiced = { ...profile.practiced, [tag.category]: profile.gamesPlayed };
}

/** A practice problem ended (solved, or the answer was shown): count the solve and mark the category as worked on. Mutates the profile. */
export function applyProblemResult(profile: Profile, category: MistakeCategory, solved: boolean): void {
  if (solved) profile.problemsSolved = (profile.problemsSolved ?? 0) + 1;
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

/** Group average ownership must swing at least this much, changing sign, for a life-and-death change. */
const STATUS_SWING = 1;
const STATUS_MIN = 0.3;

interface Chain {
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
function chainOwnership(chain: Chain, ownership: number[], size: number): number {
  const sign = chain.color === "B" ? 1 : -1;
  const sum = chain.stones.reduce((s, p) => s + (ownership[p.y * size + p.x] ?? 0), 0);
  return (sign * sum) / chain.stones.length;
}

/** Some group of 2+ stones went from alive to dead (or dead to alive) because of the move. */
function lifeStatusChanged(ctx: MistakeContext): boolean {
  const { ownershipBefore: before, ownershipAfter: after, size } = ctx;
  if (!before || !after || before.length !== size * size || after.length !== size * size) return false;
  return chains(ctx.boardBefore).some((chain) => {
    if (chain.stones.length < 2) return false;
    const b = chainOwnership(chain, before, size);
    const a = chainOwnership(chain, after, size);
    return Math.sign(a) !== Math.sign(b) && Math.abs(a) >= STATUS_MIN && Math.abs(b) >= STATUS_MIN && Math.abs(a - b) >= STATUS_SWING;
  });
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

/** Categories worth a focus, in the order a 9×9 beginner benefits from them (ties go to the earlier one). */
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
    const at = profile.practiced?.[c];
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
      reason: `No mistakes recorded yet. A game shows KataGo where points go; ${label} is a good first topic on 9×9.`,
      suggestion: "game",
    };
  }
  const suggestion = w >= PROBLEMS_SCORE && PROBLEM_FRIENDLY.has(best) && profile.gamesPlayed >= 2 ? "problems" : "game";
  if (w >= boost(best) && total > 0) {
    // "Keeps costing" only when it still does: older mistakes alone get their own wording.
    const reason =
      recent > 0
        ? `${label} keeps costing points: ${recent} mistake${recent === 1 ? "" : "s"} in the last 3 games, ${total} of the last ${profile.recentMistakes.length} recorded.`
        : `${label} cost the most points in earlier games (${total} of the last ${profile.recentMistakes.length} recorded mistakes), with none in the last 3 games.`;
    return { category: best, reason, suggestion };
  }
  const since = profile.practiced?.[best];
  const when = since === undefined ? "hasn't been worked on yet" : `hasn't been worked on for ${profile.gamesPlayed - since} games`;
  return {
    category: best,
    reason: `No category stands out (${total} recent ${label} mistake${total === 1 ? "" : "s"}); ${label} ${when}, so it keeps practice balanced.`,
    suggestion,
  };
}
