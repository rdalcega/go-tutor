// Generated practice problems. KataGo plays itself with its human-style (human-SL) net, the weaker
// side at the learner's rank and the other side 5 ranks stronger; the weaker side's big, clear,
// local mistakes become one-move problems: the board just before the mistake, Black to play (the
// colors are swapped when the mistake was White's), find the move it should have played. Problems
// come in batches of 20 across 9×9, 13×13 and 19×19, and the next batch starts once the learner
// has mastered most of the newest one.
//
// `ProblemGenerator` runs inside the server, in the background, one KataGo query at a time at the
// lowest priority. It waits while the learner is active (`mayRun`), and `noteActivity` cancels its
// query in flight, so a game or problem never waits behind it. Its progress lives in
// data/generation.json, written after every self-play move, so a restart resumes the batch.
// Pure helpers first (quotas, ranks, the filters, difficulty, the trigger), then the generator.

import { GoGame, gameFromLine, opponent, toAscii, type IllegalReason } from "../engine/index.ts";
import { tryFromGtp } from "../shared/coords.ts";
import { ratingToRank, toHumanSLProfile } from "../shared/rank.ts";
import { freshSchedule } from "../shared/schedule.ts";
import { colorName, round1, round2 } from "../shared/text.ts";
import {
  BOARD_SIZES,
  type Board,
  type BoardSize,
  type Color,
  type GenerationBatchStatus,
  type GenerationSizeStatus,
  type GenerationStatus,
  type Gtp,
  type MoveRecord,
  type Point,
} from "../shared/types.ts";
import { UserError, nextNumber, type Clock, type TutorEventInput } from "./common.ts";
import { ESTIMATE_RANKS, ESTIMATE_RATINGS } from "./estimate.ts";
import {
  GENERATION_PRIORITY,
  TRUSTED_CANDIDATE_VISITS,
  abortError,
  chooseBotMove,
  humanMoveProbability,
  humanPolicyOptions,
  isAbortError,
  moveEvalFrom,
  type Analysis,
  type AnalyzeOptions,
  type Engine,
  type Position,
} from "./katago.ts";
import {
  acceptedAnswers,
  addProblems,
  candidatesFromAnalysis,
  generatedSource,
  hasKoBan,
  isLegacyBuiltin,
  positionHash,
  problemGame,
  problemPosition,
  promptFor,
  stonesOf,
  type Candidate,
  type StoredProblem,
} from "./problems.ts";
import { MAX_BOT_RATING, MIN_BOT_RATING, classifyPlayed, flippedChains, ownershipFlipped } from "./profile.ts";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Problems per batch, split 7/7/6 across the sizes (`batchQuotas`). */
export const BATCH_SIZE = 20;
/** Which size gets 6 in batch 1, 2, 3, … (then it repeats): the most expensive size first. */
const SHORT_SIZE_ORDER: readonly BoardSize[] = [19, 13, 9];
export const GENERATED_KOMI = 7;
/** The first batch's self-play ranks. */
export const FIRST_BATCH_RANKS = { weaker: "20k", stronger: "15k" } as const;
/** The stronger side plays this many ranks above the weaker one. */
export const RANK_GAP = 5;
/** A problem in this Leitner box or higher counts as mastered (solved on the first try at least twice). */
export const MASTERED_BOX = 3;
/** Share of the newest batch's problems that must be mastered to start the next batch (15 of 20). */
export const MASTERY_SHARE = 0.75;
/** Difficulties from the learner's rank to this many ranks stronger are preferred. */
export const DIFFICULTY_BAND = 4;
/** A clear problem has at most this many accepted answers. */
export const MAX_ANSWERS = 3;
/** "Local": the best move is within this many lines (in both directions) of one of the last two moves. */
export const LOCAL_DISTANCE = 2;
/** Mistakes from this move number on (the first 4 moves are never problems). */
export const FIRST_CANDIDATE_MOVE = 5;
/** Visits for the deeper re-analysis of a candidate's position, and of the position after its mistake. */
export const CONFIRM_VISITS = 1600;
export const CONFIRM_AFTER_VISITS = 800;
/** The answers' combined human-SL probability that sets the difficulty rank. */
export const DIFFICULTY_CROSSING = 0.5;
/**
 * A qualifying problem outside the preferred difficulty band waits in its size's reserve; once more
 * than this many wait there, the one closest to the band is accepted. So the band is a preference:
 * when a size's mistakes are mostly harder (or easier) than the learner, the closest of them still
 * fill the batch, at the cost of this many unused problems per size.
 */
export const RESERVE_SIZE = 2;

/**
 * Per board size: the screening visits for every self-play position, the point loss that makes a
 * mistake "big" (checked on the screening analysis, then confirmed deeper), how much worse the best
 * move that isn't an answer must be ("clear"), and where the self-play game stops.
 */
export interface SizeSettings {
  screenVisits: number;
  minLoss: number;
  minWrongGap: number;
  /** The game stops after this many moves (or two passes): candidates come only from these. */
  maxMoves: number;
}

export const SIZE_SETTINGS: Record<BoardSize, SizeSettings> = {
  9: { screenVisits: 200, minLoss: 4, minWrongGap: 3, maxMoves: 120 },
  13: { screenVisits: 200, minLoss: 6, minWrongGap: 4, maxMoves: 150 },
  19: { screenVisits: 200, minLoss: 8, minWrongGap: 5, maxMoves: 150 },
};

// ---------------------------------------------------------------------------
// Persistence (data/generation.json)
// ---------------------------------------------------------------------------

/** Why a candidate mistake didn't become a problem. */
export type RejectReason =
  | "ko"
  | "duplicate"
  | "pass"
  | "not_confirmed"
  | "no_answer"
  | "too_many_answers"
  | "unclear"
  | "not_local"
  | "illegal"
  /** An answer of a problem already taken from the same game: the weaker side missing the same point again. */
  | "repeat";

/** One board size's work in a batch: for the report, `tutor generate --status` and tuning the filters. */
export interface SizeStats {
  found: number;
  /** Self-play games finished, moves played, and KataGo time spent (ms) on this size. */
  games: number;
  moves: number;
  ms: number;
  /** The weaker side's moves screened, the big ones examined further, and why examined ones were dropped. */
  screened: number;
  candidates: number;
  rejected: Partial<Record<RejectReason, number>>;
  /** Qualifying problems outside the difficulty band, kept in reserve. */
  reserved: number;
}

export interface GeneratedBatch {
  id: string;
  number: number;
  weakerRank: string;
  strongerRank: string;
  trigger: GenerationBatchStatus["trigger"];
  /** The preferred difficulty, on the rank scale: [the learner's rank, 4 ranks stronger]. */
  band: [number, number];
  quotas: Record<BoardSize, number>;
  createdAt: number;
  finishedAt?: number;
  problemIds: string[];
  stats: Record<BoardSize, SizeStats>;
}

/** The self-play game in progress: every move in it has been screened. */
export interface SelfPlayGame {
  size: BoardSize;
  /** The side whose mistakes become problems. */
  weaker: Color;
  moves: Gtp[];
  /** The answers of the problems taken from this game (accepted or in reserve), so a missed point counts once. */
  answers?: Gtp[];
}

export interface BatchProgress {
  batchId: string;
  game: SelfPlayGame | null;
  /** Qualifying problems outside the difficulty band (ids not yet assigned), at most RESERVE_SIZE per size. */
  reserve: StoredProblem[];
}

export interface GenerationFile {
  version: 1;
  /** Oldest first; the last one is in progress while `progress` is set. */
  batches: GeneratedBatch[];
  progress: BatchProgress | null;
}

export function emptyGeneration(): GenerationFile {
  return { version: 1, batches: [], progress: null };
}

/**
 * Restores the file's one invariant (mutating it): `progress` belongs to the newest batch, which is
 * the one in progress while it is unfinished. A damaged file (progress for a batch that isn't the
 * newest, or none for an unfinished newest batch) is repaired: the unfinished batch is resumed from
 * a fresh game, or the stray progress dropped. Returns what was repaired, for the log, or null.
 */
export function normalizeGeneration(file: GenerationFile): string | null {
  const last = file.batches.at(-1);
  const unfinished = last && !last.finishedAt ? last : null;
  const named = file.progress?.batchId ?? null;
  if (named === (unfinished?.id ?? null)) return null;
  file.progress = unfinished ? { batchId: unfinished.id, game: null, reserve: [] } : null;
  return unfinished ? `progress for ${named ?? "no batch"} replaced: resuming ${unfinished.id}` : `progress for unknown ${named} dropped`;
}

function perSize<T>(make: (size: BoardSize) => T): Record<BoardSize, T> {
  return { 9: make(9), 13: make(13), 19: make(19) };
}

function emptyStats(): SizeStats {
  return { found: 0, games: 0, moves: 0, ms: 0, screened: 0, candidates: 0, rejected: {}, reserved: 0 };
}

// ---------------------------------------------------------------------------
// Batches and the trigger
// ---------------------------------------------------------------------------

/** Batch `n`'s problems per size: 7/7/6, the 6 rotating 19×19, 13×13, 9×9, 19×19, … */
export function batchQuotas(n: number): Record<BoardSize, number> {
  const short = SHORT_SIZE_ORDER[(n - 1) % SHORT_SIZE_ORDER.length]!;
  const base = Math.floor(BATCH_SIZE / BOARD_SIZES.length) + 1;
  return perSize((size) => (size === short ? BATCH_SIZE - base * (BOARD_SIZES.length - 1) : base));
}

/** The learner's rating as a whole rank on KataGo's human-SL scale (20k … 9d). */
function learnerBotRating(rating: number): number {
  return Math.min(MAX_BOT_RATING, Math.max(MIN_BOT_RATING, Math.round(rating)));
}

/** Self-play ranks for a learner rated `rating`: the weaker side at their rank (20k … 9d), the other 5 ranks stronger (capped at 9d). */
export function batchRanks(rating: number): { weaker: string; stronger: string } {
  const weaker = learnerBotRating(rating);
  return { weaker: ratingToRank(weaker), stronger: ratingToRank(Math.min(MAX_BOT_RATING, weaker + RANK_GAP)) };
}

/** The preferred difficulty for a learner rated `rating`: their rank to DIFFICULTY_BAND ranks stronger. */
export function difficultyBand(rating: number): [number, number] {
  const low = learnerBotRating(rating);
  return [low, Math.min(MAX_BOT_RATING, low + DIFFICULTY_BAND)];
}

/** How far (in ranks) a difficulty is outside the band; 0 inside it. */
export function bandDistance(rating: number, band: readonly [number, number]): number {
  return rating < band[0] ? band[0] - rating : rating > band[1] ? rating - band[1] : 0;
}

/** "20k–16k". */
export function bandText(band: readonly [number, number]): string {
  return `${ratingToRank(band[0])}–${ratingToRank(band[1])}`;
}

/** The batch's problems that are mastered (Leitner box MASTERED_BOX or higher). */
export function masteredCount(problems: readonly StoredProblem[], batchId: string): number {
  return problems.filter((p) => generatedSource(p)?.batchId === batchId && p.box >= MASTERED_BOX).length;
}

/** Mastered problems that start the next batch: 15 of a batch of 20. */
export function masteryNeeded(batchProblems: number): number {
  return Math.ceil(batchProblems * MASTERY_SHARE);
}

/**
 * Which batch to start now, if any: the first one when there is none, the next one when the newest
 * is finished and enough of its problems (still stored) are mastered. Never while one is in progress.
 */
export function nextBatchTrigger(file: GenerationFile, problems: readonly StoredProblem[]): "first" | "mastery" | null {
  if (file.progress) return null;
  const last = file.batches.at(-1);
  if (!last) return "first";
  if (!last.finishedAt) return null;
  const total = problems.filter((p) => generatedSource(p)?.batchId === last.id).length;
  return total > 0 && masteredCount(problems, last.id) >= masteryNeeded(total) ? "mastery" : null;
}

/** The next problem id for a generated problem: gen1, gen2, … */
export function nextGeneratedId(problems: readonly Pick<StoredProblem, "id">[]): string {
  return `gen${nextNumber(problems.map((p) => p.id), "gen")}`;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** The board with every stone's color swapped (so the side to play can be Black). */
export function swapColors(board: Board): Board {
  return board.map((row) => row.map((c) => (c === null ? null : opponent(c))));
}

function chebyshev(a: Point, b: Point): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Points whose fate the mistake changed, from KataGo's ownership (Black's view) before and after it:
 * every stone of a group whose average ownership flips (`flippedChains`, the rule that spots a
 * life-and-death mistake in the learner's games), and every empty point whose ownership flips.
 */
export function flippedPoints(board: Board, before: readonly number[], after: readonly number[]): Point[] {
  const size = board.length;
  if (before.length !== size * size || after.length !== size * size) return [];
  const out = flippedChains(board, before, after).flatMap((c) => c.stones);
  board.forEach((row, y) =>
    row.forEach((cell, x) => {
      if (cell === null && ownershipFlipped(before[y * size + x]!, after[y * size + x]!)) out.push({ x, y });
    }),
  );
  return out;
}

/**
 * Whether the best move is local: within LOCAL_DISTANCE lines of one of the last two moves, or on
 * or next to a point whose fate the mistake changed (`flippedPoints`).
 */
export function isLocal(best: Point, recent: readonly Point[], flips: readonly Point[]): boolean {
  return recent.some((r) => chebyshev(best, r) <= LOCAL_DISTANCE) || flips.some((f) => chebyshev(best, f) <= 1);
}

/**
 * How much worse than KataGo's best the best move that isn't an answer is (a pass counts), among
 * the moves it searched well; Infinity when it searched nothing else well.
 */
export function wrongGap(candidates: readonly Candidate[], answers: readonly Gtp[]): number {
  const best = candidates[0];
  if (!best) return 0;
  const others = candidates.filter((c) => c.visits >= TRUSTED_CANDIDATE_VISITS && !answers.includes(c.move));
  return others.length ? best.lead - Math.max(...others.map((c) => c.lead)) : Infinity;
}

/**
 * The difficulty on the rank scale: where the answers' combined human-SL probability (`probs`, one
 * per rank in `ratings`, weakest first) first reaches DIFFICULTY_CROSSING, interpolated linearly
 * between the two profiles around it. At or below the weakest profile it is that profile (`floor`);
 * when no profile reaches it, the strongest (`ceiling`).
 */
export function difficultyRating(probs: readonly number[], ratings: readonly number[] = ESTIMATE_RATINGS): { rating: number; floor: boolean; ceiling: boolean } {
  const at = probs.findIndex((p) => p >= DIFFICULTY_CROSSING);
  if (at === 0) return { rating: ratings[0]!, floor: true, ceiling: false };
  if (at < 0) return { rating: ratings.at(-1)!, floor: false, ceiling: true };
  const [p0, p1] = [probs[at - 1]!, probs[at]!];
  const [r0, r1] = [ratings[at - 1]!, ratings[at]!];
  const rating = r0 + ((DIFFICULTY_CROSSING - p0) / (p1 - p0)) * (r1 - r0);
  return { rating: round2(rating), floor: false, ceiling: false };
}

/** A mistake by the weaker side that screening found big, with what the filters need. */
export interface CandidateInput {
  size: BoardSize;
  /** The mistake's move number and the move (a board point). */
  moveNumber: number;
  played: Gtp;
  /** The rules engine just before the mistake, with the game's history (for ko). */
  before: GoGame;
  /** The two moves before the mistake (passes left out). */
  recent: Gtp[];
  /** The screening analyses before and after the mistake (ownership included). */
  screenBefore: Analysis;
  screenAfter: Analysis;
}

/** A problem ready to store, but for its id and batch. */
export interface CandidateProblem {
  size: BoardSize;
  stones: StoredProblem["stones"];
  hash: string;
  category: StoredProblem["category"];
  answers: Gtp[];
  bestMove: Gtp;
  bestPv: Gtp[];
  /** Points the mistake loses in the deeper analysis. */
  pointLoss: number;
  difficultyRating: number;
  moveNumber: number;
  played: Gtp;
  swapped: boolean;
}

/** What the deeper analysis measured, for the log and for tuning the filters. */
export interface CandidateMetrics {
  /** Points the mistake loses in the deeper analysis. */
  loss: number;
  answers: number;
  /** `wrongGap` (Infinity: KataGo searched nothing else well). */
  gap: number;
  local: boolean;
}

export type Verdict = { ok: true; problem: CandidateProblem; metrics: CandidateMetrics } | { ok: false; reason: RejectReason; metrics?: CandidateMetrics };

/** What examining a candidate needs: KataGo (priority and cancelling already applied), and the problems' position hashes. */
export interface ExamineContext {
  analyze(pos: Position, opts: AnalyzeOptions): Promise<Analysis>;
  knownHashes: ReadonlySet<string>;
}

/**
 * Turns a big mistake into a problem, or says which filter dropped it: no ko ban (the problem drops
 * the history), a new position, KataGo's best isn't a pass, the loss confirmed by a deeper analysis
 * of the problem position (Black to play, colors swapped if the mistake was White's, which also
 * changes who the komi helps), at most MAX_ANSWERS answers with the best wrong move clearly worse,
 * and a local best move. Then its category (the same heuristic as the learner's mistakes) and
 * difficulty (`difficultyRating` of the answers under the human-SL profiles).
 */
export async function examineCandidate(input: CandidateInput, ctx: ExamineContext): Promise<Verdict> {
  const { size, played, before } = input;
  const settings = SIZE_SETTINGS[size];
  if (hasKoBan(before)) return { ok: false, reason: "ko" };
  const mover = before.toPlay;
  const swapped = mover === "W";
  const board = swapped ? swapColors(before.board) : before.board;
  const hash = positionHash(board, "B");
  if (ctx.knownHashes.has(hash)) return { ok: false, reason: "duplicate" };
  const setup = { size, komi: GENERATED_KOMI, stones: stonesOf(board), toPlay: "B" as const };

  const deep = await ctx.analyze(problemPosition(setup), { maxVisits: CONFIRM_VISITS, includeOwnership: true });
  const best = deep.moveInfos[0];
  if (!best || best.move === "pass") return { ok: false, reason: "pass" };
  const replay = problemGame(setup);
  const point = tryFromGtp(played, size);
  const trial = point ? problemGame(setup).play({ color: "B", point }) : null;
  if (!point || !trial?.ok) return { ok: false, reason: "illegal" };
  const after = await ctx.analyze(problemPosition(setup, [played]), { maxVisits: CONFIRM_AFTER_VISITS, includeOwnership: true });
  const evaluation = moveEvalFrom(deep, after, played);
  const candidates = candidatesFromAnalysis(deep);
  const answers = acceptedAnswers(candidates, played);
  const recent = input.recent.flatMap((g) => tryFromGtp(g, size) ?? []);
  const { ownership: ownBefore } = input.screenBefore;
  const { ownership: ownAfter } = input.screenAfter;
  const flips = ownBefore && ownAfter ? flippedPoints(before.board, ownBefore, ownAfter) : [];
  const metrics: CandidateMetrics = {
    loss: round1(evaluation.pointLoss),
    answers: answers.length,
    gap: round1(wrongGap(candidates, answers)),
    local: isLocal(tryFromGtp(best.move, size)!, recent, flips),
  };
  const reason: RejectReason | null =
    metrics.loss < settings.minLoss
      ? "not_confirmed"
      : answers.length === 0
        ? "no_answer"
        : answers.length > MAX_ANSWERS
          ? "too_many_answers"
          : metrics.gap < settings.minWrongGap
            ? "unclear"
            : !metrics.local
              ? "not_local"
              : null;
  if (reason) return { ok: false, reason, metrics };

  const record: MoveRecord = { ...trial.record, number: input.moveNumber, eval: evaluation };
  const category = classifyPlayed(replay, record, settings.minLoss, deep, after);
  const probs = await answerPolicies(ctx, problemPosition(setup), answers);
  return {
    ok: true,
    problem: {
      size,
      stones: setup.stones,
      hash,
      category,
      answers,
      bestMove: best.move,
      bestPv: best.pv.slice(0, 8),
      pointLoss: metrics.loss,
      difficultyRating: difficultyRating(probs).rating,
      moveNumber: input.moveNumber,
      played,
      swapped,
    },
    metrics,
  };
}

/** The answers' combined human-SL probability in the position at each of ESTIMATE_RANKS (weakest first). */
async function answerPolicies(ctx: ExamineContext, position: Position, answers: readonly Gtp[]): Promise<number[]> {
  const probs: number[] = [];
  for (const rank of ESTIMATE_RANKS) {
    const analysis = await ctx.analyze(position, humanPolicyOptions(rank));
    probs.push(answers.reduce((sum, a) => sum + humanMoveProbability(analysis, a, position.size), 0));
  }
  return probs;
}

/** The stored problem for a candidate accepted into `batch`. */
export function storedProblem(c: CandidateProblem, batch: Pick<GeneratedBatch, "id" | "weakerRank" | "strongerRank">, id: string, now: number): StoredProblem {
  return {
    id,
    kind: "generated",
    size: c.size,
    komi: GENERATED_KOMI,
    stones: c.stones,
    toPlay: "B",
    prompt: promptFor(c.category, "B"),
    category: c.category,
    answers: c.answers,
    bestMove: c.bestMove,
    bestPv: c.bestPv,
    difficulty: c.pointLoss,
    source: {
      kind: "generated",
      batchId: batch.id,
      weakerRank: batch.weakerRank,
      strongerRank: batch.strongerRank,
      difficultyRank: ratingToRank(Math.round(c.difficultyRating)),
      difficultyRating: c.difficultyRating,
      moveNumber: c.moveNumber,
      played: c.played,
      swapped: c.swapped,
    },
    hash: c.hash,
    createdAt: now,
    ...freshSchedule(now),
  };
}

// ---------------------------------------------------------------------------
// Removing the old built-in problems
// ---------------------------------------------------------------------------

/** What the startup migration needs of the store. */
export interface ProblemFiles {
  loadProblems(): StoredProblem[];
  saveProblems(problems: readonly StoredProblem[]): void;
  backup(paths: readonly string[], now?: number): string;
}

/**
 * At startup, once: problems.json loses the built-in starter problems (generated problems replaced
 * them), keeping the learner's own problems and their schedules. It is backed up first. Running it
 * again changes nothing.
 */
export function removeLegacyBuiltins(store: ProblemFiles, now: number): { removed: number; backupDir: string | null } {
  const problems = store.loadProblems();
  const keep = problems.filter((p) => !isLegacyBuiltin(p));
  if (keep.length === problems.length) return { removed: 0, backupDir: null };
  const backupDir = store.backup(["problems.json"], now);
  store.saveProblems(keep);
  return { removed: problems.length - keep.length, backupDir };
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/** How often a waiting generator checks whether it may use KataGo again. */
export const POLL_MS = 1000;
/** Wait after a failed step (KataGo crashed or restarting), doubling up to RETRY_MAX_MS. */
const RETRY_MS = 5000;
const RETRY_MAX_MS = 5 * 60_000;

export interface GeneratorDeps {
  engine: Pick<Engine, "analyze">;
  store: { loadGeneration(): GenerationFile; saveGeneration(state: GenerationFile): void; loadProblems(): StoredProblem[] };
  clock: Clock;
  log(msg: string): void;
  /** The learner's rating now (Profile.rating), for the next batch's ranks and difficulty band. */
  rating(): number;
  /** Whether KataGo is free for the generator: it is ready and the learner isn't using it. */
  mayRun(): boolean;
  /** Loads the stored problems, lets `change` add to them, saves them and reports them to `problemsChanged` (the controller's). */
  updateProblems<T>(change: (problems: StoredProblem[]) => T): T;
  /** The status changed (a problem found, a batch started or finished, waiting or running). */
  changed(): void;
  emit(event: TutorEventInput): void;
  /** A line in the learner's chat. */
  system(text: string): void;
  /** Receives one line per examined candidate (its verdict and measurements), for tuning the filters. */
  debug?(msg: string): void;
  /** Problems per size for batch `n` (default `batchQuotas`); a size with 0 is skipped. For tests. */
  quotas?(n: number): Record<BoardSize, number>;
}

/** Problem generation in the server's background. See the top of the file. */
export class ProblemGenerator {
  private file: GenerationFile;
  private enabled = false;
  private running = false;
  /** KataGo is working for the generator right now (not waiting for the learner). */
  private active = false;
  /** Cancels the step in flight when the learner needs KataGo. */
  private abort: AbortController | null = null;
  /** The current game replayed, and the screening analysis of its position after `count` moves. */
  private replay: { game: SelfPlayGame; rules: GoGame } | null = null;
  private prev: { count: number; analysis: Analysis } | null = null;
  /** The stored problems as of their last change (the controller's `updateProblems` reports every one). */
  private problems: readonly StoredProblem[] = [];
  /** Mastered problems of the newest finished batch, and its problems still stored. */
  private mastery = { mastered: 0, problems: 0 };
  private failures = 0;
  private wakeUp: (() => void) | null = null;

  constructor(private readonly deps: GeneratorDeps) {
    this.file = deps.store.loadGeneration();
    const repaired = normalizeGeneration(this.file);
    if (repaired) deps.log(`problem generation: ${repaired} (generation.json was inconsistent)`);
    this.problemsChanged(deps.store.loadProblems());
  }

  /** Start generating: resume the batch in progress, or start the next one if it is due. */
  start(): void {
    this.enabled = true;
    this.checkTrigger();
    this.kick();
  }

  /** Stop after the step in flight (its query is cancelled). */
  stop(): void {
    this.enabled = false;
    this.abort?.abort();
    this.wake();
  }

  /** The learner needs KataGo: cancel the query in flight; the step runs again once they are idle. */
  noteActivity(): void {
    this.abort?.abort();
  }

  /** Something `mayRun` reads changed (KataGo became ready, the learner went idle): check again now. */
  wake(): void {
    this.wakeUp?.();
  }

  /** The stored problems changed: keep them, and the newest finished batch's mastery count, current. */
  problemsChanged(problems: readonly StoredProblem[]): void {
    this.problems = problems;
    const last = this.file.batches.filter((b) => b.finishedAt).at(-1);
    this.mastery = last
      ? { mastered: masteredCount(problems, last.id), problems: problems.filter((p) => generatedSource(p)?.batchId === last.id).length }
      : { mastered: 0, problems: 0 };
  }

  /** After a problem result and at startup: start the next batch if it is due (the first one, or the newest one mastered). */
  checkTrigger(): void {
    if (!this.enabled) return;
    const trigger = nextBatchTrigger(this.file, this.problems);
    if (trigger) this.startBatch(trigger);
  }

  /** `tutor generate --now`: start the next batch even if the trigger hasn't fired. */
  startNow(): GenerationBatchStatus {
    const current = this.currentBatch();
    if (current) throw new UserError(`A batch is already being generated: ${current.id}, ${this.found(current)}/${this.target(current)} problems so far.`);
    const batch = this.startBatch(this.file.batches.length === 0 ? "first" : "manual");
    return this.batchStatus(batch);
  }

  status(): GenerationStatus {
    const current = this.currentBatch();
    const finished = this.file.batches.filter((b) => b.finishedAt);
    const last = finished.at(-1);
    return {
      state: !current ? "idle" : this.active ? "generating" : "waiting",
      current: current ? this.batchStatus(current) : null,
      last: last ? { ...this.batchStatus(last), problems: this.mastery.problems, mastered: this.mastery.mastered, needed: masteryNeeded(this.mastery.problems) } : null,
      batches: finished.length,
    };
  }

  /** The batches so far, oldest first (for the report and tests). */
  get batches(): readonly GeneratedBatch[] {
    return this.file.batches;
  }

  /** Resolves when the generator has stopped running (for tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running) await new Promise<void>((r) => setImmediate(r));
  }

  /** The batch in progress: the newest one while `progress` is set (`normalizeGeneration` keeps them in step). */
  private currentBatch(): GeneratedBatch | null {
    return this.file.progress ? (this.file.batches.at(-1) ?? null) : null;
  }

  private found(batch: GeneratedBatch): number {
    return BOARD_SIZES.reduce((n, s) => n + batch.stats[s].found, 0);
  }

  private target(batch: GeneratedBatch): number {
    return BOARD_SIZES.reduce((n, s) => n + batch.quotas[s], 0);
  }

  private batchStatus(batch: GeneratedBatch): GenerationBatchStatus {
    const sizes: GenerationSizeStatus[] = BOARD_SIZES.map((size) => ({
      size,
      found: batch.stats[size].found,
      target: batch.quotas[size],
      games: batch.stats[size].games,
      minutes: Math.round(batch.stats[size].ms / 6000) / 10,
    }));
    return {
      id: batch.id,
      number: batch.number,
      weakerRank: batch.weakerRank,
      strongerRank: batch.strongerRank,
      trigger: batch.trigger,
      found: this.found(batch),
      target: this.target(batch),
      sizes,
      band: bandText(batch.band),
      createdAt: batch.createdAt,
      ...(batch.finishedAt !== undefined && { finishedAt: batch.finishedAt }),
    };
  }

  private startBatch(trigger: GeneratedBatch["trigger"]): GeneratedBatch {
    const number = (this.file.batches.at(-1)?.number ?? 0) + 1;
    const rating = this.deps.rating();
    const ranks = trigger === "first" ? FIRST_BATCH_RANKS : batchRanks(rating);
    const batch: GeneratedBatch = {
      id: `batch${number}`,
      number,
      weakerRank: ranks.weaker,
      strongerRank: ranks.stronger,
      trigger,
      band: difficultyBand(rating),
      quotas: (this.deps.quotas ?? batchQuotas)(number),
      createdAt: this.deps.clock.now(),
      problemIds: [],
      stats: perSize(emptyStats),
    };
    this.file.batches.push(batch);
    this.file.progress = { batchId: batch.id, game: null, reserve: [] };
    this.forgetReplay();
    this.save();
    const status = this.batchStatus(batch);
    this.deps.log(`problem generation: ${batch.id} started (${trigger}), ${batch.weakerRank} vs ${batch.strongerRank}, difficulty band ${status.band}`);
    this.deps.emit({ type: "generation", status: "started", batch: status });
    this.deps.system(
      trigger === "first"
        ? "Your practice problems are being made from games KataGo plays against itself, on 9×9, 13×13 and 19×19. They join Practice as they're found."
        : trigger === "mastery"
          ? `You've mastered most of your last practice batch, so ${status.target} new problems are being made at your level (${batch.weakerRank}). They join Practice as they're found.`
          : `${status.target} new practice problems are being made at your level (${batch.weakerRank}). They join Practice as they're found.`,
    );
    this.deps.changed();
    this.kick();
    return batch;
  }

  private finishBatch(batch: GeneratedBatch): void {
    batch.finishedAt = this.deps.clock.now();
    this.file.progress = null;
    this.forgetReplay();
    this.save();
    this.problemsChanged(this.problems); // this batch is the newest finished one now
    const status = this.batchStatus(batch);
    const minutes = BOARD_SIZES.map((s) => `${s}×${s} ${status.sizes.find((x) => x.size === s)!.minutes} min`).join(", ");
    this.deps.log(`problem generation: ${batch.id} finished, ${status.found} problems (${minutes})`);
    this.deps.emit({ type: "generation", status: "finished", batch: status });
    const counts = status.sizes.filter((s) => s.target > 0).map((s) => `${s.found} on ${s.size}×${s.size}`).join(", ");
    this.deps.system(`${status.found} new practice problems are ready (${counts}). Press Practice to try them.`);
    this.deps.changed();
  }

  private save(): void {
    try {
      this.deps.store.saveGeneration(this.file);
    } catch (err) {
      this.deps.log(`saving generation.json failed: ${(err as Error).message}`);
    }
  }

  private kick(): void {
    if (this.running || !this.enabled || !this.file.progress) return;
    this.running = true;
    void this.run().finally(() => {
      this.running = false;
      this.setActive(false);
    });
  }

  private setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.deps.changed();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.deps.clock.setTimeout(() => {
        this.wakeUp = null;
        resolve();
      }, ms);
      this.wakeUp = () => {
        this.deps.clock.clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
    });
  }

  private async run(): Promise<void> {
    while (this.enabled && this.file.progress) {
      if (!this.deps.mayRun()) {
        this.setActive(false);
        await this.sleep(POLL_MS);
        continue;
      }
      this.setActive(true);
      const abort = new AbortController();
      this.abort = abort;
      try {
        await this.step(abort.signal);
        this.failures = 0;
      } catch (err) {
        if (isAbortError(err) || abort.signal.aborted) continue; // the learner needs KataGo: the step runs again later
        const wait = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** this.failures++);
        this.deps.log(`problem generation step failed (${(err as Error).message}); trying again in ${Math.round(wait / 1000)} s`);
        this.setActive(false);
        await this.sleep(wait);
      } finally {
        this.abort = null;
      }
    }
  }

  /** A query for the generator: lowest priority, cancelled with the step. */
  private query(pos: Position, opts: AnalyzeOptions, signal: AbortSignal): Promise<Analysis> {
    if (signal.aborted) return Promise.reject(abortError());
    return this.deps.engine.analyze(pos, { ...opts, priority: GENERATION_PRIORITY, signal });
  }

  /** The self-play position after `moves` (from the empty board). */
  private position(game: SelfPlayGame, moves: readonly Gtp[]): Position {
    const first: Color = "B";
    return { size: game.size, komi: GENERATED_KOMI, rules: "chinese", moves: moves.map((m, i) => [i % 2 === 0 ? first : opponent(first), m]) };
  }

  /** Screening query for a self-play position: the eval (with ownership) and the human-SL policy of the side to move, which picks its move. */
  private screenOptions(game: SelfPlayGame, batch: GeneratedBatch, toPlay: Color): AnalyzeOptions {
    const rank = toPlay === game.weaker ? batch.weakerRank : batch.strongerRank;
    return { maxVisits: SIZE_SETTINGS[game.size].screenVisits, includeOwnership: true, includePolicy: true, overrideSettings: { humanSLProfile: toHumanSLProfile(rank) } };
  }

  /** The next self-play game's size: the one with the largest share of its quota still to find (smaller first on a tie). */
  private nextSize(batch: GeneratedBatch): BoardSize | null {
    let best: BoardSize | null = null;
    let bestShare = 0;
    for (const size of BOARD_SIZES) {
      if (batch.quotas[size] <= 0) continue;
      const share = (batch.quotas[size] - batch.stats[size].found) / batch.quotas[size];
      if (share > bestShare + 1e-9) {
        best = size;
        bestShare = share;
      }
    }
    return best;
  }

  /** The rules engine for the game in progress (replayed after a restart). */
  private rulesFor(game: SelfPlayGame): GoGame {
    if (this.replay?.game === game) return this.replay.rules;
    const rules = gameFromLine({ size: game.size, komi: GENERATED_KOMI, handicap: 0 }, game.moves);
    this.replay = { game, rules };
    return rules;
  }

  /**
   * One step of the batch: start a self-play game, or play its next move, screening the weaker
   * side's last move (and examining it when it is big), or end the game, or finish the batch. Its
   * queries can be cancelled at any point: nothing is kept until the step completes.
   */
  private async step(signal: AbortSignal): Promise<void> {
    const progress = this.file.progress!;
    const batch = this.currentBatch()!;
    let game = progress.game;
    if (!game || batch.stats[game.size].found >= batch.quotas[game.size]) {
      if (game) this.endGame(batch, game);
      const size = this.nextSize(batch);
      if (size === null) return this.finishBatch(batch);
      game = { size, weaker: batch.stats[size].games % 2 === 0 ? "B" : "W", moves: [] };
      progress.game = game;
      this.prev = null;
      this.save();
      return;
    }
    const rules = this.rulesFor(game);
    const settings = SIZE_SETTINGS[game.size];
    const stats = batch.stats[game.size];
    const n = game.moves.length;
    const last = rules.lastMove;
    const screen = last !== null && last.move.color === game.weaker && !("pass" in last.move) && n >= FIRST_CANDIDATE_MOVE;
    // At the move cap the game ends, once the weaker side's last move (if it was theirs) is screened.
    const atCap = n >= settings.maxMoves;
    if (rules.isOver || (atCap && !screen)) {
      this.endGame(batch, game);
      this.save();
      return;
    }
    const started = this.deps.clock.now();
    try {
      const moves = [...game.moves];
      // After a restart the position before the last move hasn't been analyzed in this run.
      const before = screen ? (this.prev?.count === n - 1 ? this.prev.analysis : await this.query(this.position(game, moves.slice(0, -1)), this.screenOptions(game, batch, game.weaker), signal)) : null;
      const now = await this.query(this.position(game, moves), this.screenOptions(game, batch, rules.toPlay), signal);
      let verdict: Verdict | null = null;
      let loss = 0;
      if (before) {
        loss = moveEvalFrom(before, now, moves[n - 1]).pointLoss;
        if (loss >= settings.minLoss) verdict = await this.examine(game, rules, before, now, signal);
      }
      // Nothing is kept before here: a cancelled step runs again from the same position. The next
      // move is played (it can throw) before the verdict is recorded, so a failed step stores nothing.
      if (atCap) {
        this.endGame(batch, game);
      } else {
        const move = chooseBotMove(now, game.size);
        const point = move === "pass" ? null : tryFromGtp(move, game.size);
        const result = point ? rules.play({ color: rules.toPlay, point }) : rules.pass();
        if (!result.ok) throw new Error(`KataGo's move ${move} is illegal here (${result.reason satisfies IllegalReason})`);
        game.moves.push(move);
        stats.moves++;
        this.prev = { count: n, analysis: now };
      }
      if (before) stats.screened++;
      if (verdict?.ok && verdict.problem.answers.some((a) => game.answers?.includes(a))) verdict = { ok: false, reason: "repeat", metrics: verdict.metrics };
      if (verdict) {
        const m = verdict.metrics;
        const measured = m ? `, loss ${m.loss}, answers ${m.answers}, gap ${m.gap}, ${m.local ? "local" : "not local"}` : "";
        const outcome = verdict.ok ? `ok ${verdict.problem.category}, difficulty ${verdict.problem.difficultyRating}` : verdict.reason;
        this.deps.debug?.(`${batch.id} ${game.size}x${game.size} move ${n} ${moves[n - 1]} (${colorName(game.weaker)}): screened ${round1(loss)}${measured} -> ${outcome}`);
        this.record(batch, game, verdict);
      }
      this.save();
    } finally {
      stats.ms += this.deps.clock.now() - started;
    }
  }

  private endGame(batch: GeneratedBatch, game: SelfPlayGame): void {
    batch.stats[game.size].games++;
    if (this.file.progress) this.file.progress.game = null;
    this.forgetReplay();
  }

  /** The replayed game and its last screening analysis no longer apply (a game ended, a batch started or finished). */
  private forgetReplay(): void {
    this.replay = null;
    this.prev = null;
  }

  /** Examine the weaker side's last move (`rules` is after it), which screening found big. */
  private async examine(game: SelfPlayGame, rules: GoGame, screenBefore: Analysis, screenAfter: Analysis, signal: AbortSignal): Promise<Verdict> {
    const n = game.moves.length;
    const progress = this.file.progress!;
    const knownHashes = new Set([...this.problems.map((p) => p.hash), ...progress.reserve.map((p) => p.hash)]);
    return examineCandidate(
      {
        size: game.size,
        moveNumber: n,
        played: game.moves[n - 1]!,
        before: rules.before(n),
        recent: game.moves.slice(Math.max(0, n - 3), n - 1).filter((m) => m !== "pass"),
        screenBefore,
        screenAfter,
      },
      { analyze: (pos, opts) => this.query(pos, opts, signal), knownHashes },
    );
  }

  /**
   * A candidate's verdict: a reject is counted; a problem within the difficulty band joins the
   * practice problems at once, and one outside it waits in its size's reserve, which gives up the
   * problem closest to the band once it holds more than RESERVE_SIZE. Either way its answers count
   * as taken for the rest of the game.
   */
  private record(batch: GeneratedBatch, game: SelfPlayGame, verdict: Verdict): void {
    const size = game.size;
    const stats = batch.stats[size];
    const progress = this.file.progress!;
    stats.candidates++;
    if (!verdict.ok) {
      stats.rejected[verdict.reason] = (stats.rejected[verdict.reason] ?? 0) + 1;
      return;
    }
    game.answers = [...(game.answers ?? []), ...verdict.problem.answers];
    const candidate = storedProblem(verdict.problem, batch, "", this.deps.clock.now());
    if (bandDistance(verdict.problem.difficultyRating, batch.band) === 0) {
      this.accept(batch, candidate);
      return;
    }
    progress.reserve.push(candidate);
    stats.reserved++;
    const waiting = progress.reserve.filter((p) => p.size === size);
    if (waiting.length <= RESERVE_SIZE) return;
    const distance = (p: StoredProblem) => bandDistance(generatedSource(p)!.difficultyRating, batch.band);
    const closest = waiting.reduce((a, b) => (distance(b) < distance(a) ? b : a));
    progress.reserve = progress.reserve.filter((p) => p !== closest);
    this.accept(batch, closest);
  }

  private accept(batch: GeneratedBatch, problem: StoredProblem): void {
    const size = problem.size as BoardSize;
    const now = this.deps.clock.now();
    const added = this.deps.updateProblems((problems) => addProblems(problems, [{ ...problem, id: nextGeneratedId(problems), createdAt: now, due: now }]))[0];
    if (!added) {
      batch.stats[size].rejected.duplicate = (batch.stats[size].rejected.duplicate ?? 0) + 1;
      return;
    }
    batch.problemIds.push(added.id);
    batch.stats[size].found++;
    const source = generatedSource(added)!;
    this.deps.log(
      `problem generation: ${added.id} ${size}×${size} ${added.category}, answers ${added.answers.join(",")}, difficulty ${source.difficultyRank} (${source.difficultyRating}), lost ${added.difficulty}${source.swapped ? ", colors swapped" : ""}\n${toAscii(problemGame(added).board, null)}`,
    );
    this.deps.changed();
  }
}
