// Practice problems: built from the learner's own mistakes when a game ends, and generated from
// KataGo's self-play (generate.ts), scheduled with Leitner boxes and judged against KataGo.
// Mostly pure functions over StoredProblem; `generateProblems` makes the KataGo calls for a
// finished game through the controller (game.ts), and store.ts reads and writes data/problems.json.

import { createHash } from "node:crypto";
import { GoGame, emptyBoard, gameBefore, gameFromLine, opponent, positionKey, setCell } from "../engine/index.ts";
import { toGtp, tryFromGtp } from "../shared/coords.ts";
import { MAX_BOX } from "../shared/schedule.ts";
import { colorName, round1 } from "../shared/text.ts";
import type {
  Board,
  Color,
  FocusRecommendation,
  GameSettings,
  GameSummary,
  GeneratedProblemInfo,
  GenerationStatus,
  Gtp,
  MistakeCategory,
  MoveRecord,
  ProblemKind,
  ProblemListItem,
  ProblemsResponse,
  TakenBackMove,
} from "../shared/types.ts";
import { BACKGROUND_PRIORITY, TRUSTED_CANDIDATE_VISITS, type Analysis, type AnalyzeOptions, type Position } from "./katago.ts";
import { mistakeKey } from "./profile.ts";

export { BOX_INTERVALS, MAX_BOX, resultOf, schedule, type ProblemResult } from "../shared/schedule.ts";

/** A move within this many points of KataGo's best counts as a correct answer. */
export const ANSWER_MARGIN = 1.0;
/** Attempts before the answer is shown. */
export const MAX_ATTEMPTS = 2;
/** A mistake's candidates with fewer visits than this in total are re-analyzed before answers are taken from them. */
export const THIN_VISITS = 200;
/** Visits for that re-analysis. */
export const DEEP_VISITS = 1000;

/** Where a problem from the learner's game comes from. `takenBack`: a first attempt that was taken back (its index in the game's `takenBack`). */
export interface GameProblemSource {
  kind?: "game";
  gameId: string;
  moveNumber: number;
  played: Gtp;
  takenBack?: number;
}

/** Where a generated problem comes from: a mistake by the weaker side of a self-play game (generate.ts). */
export interface GeneratedProblemSource extends GeneratedProblemInfo {
  kind: "generated";
  /** On the rank scale (20k = 10), unrounded: where the answers' human-SL probability crosses 50%. */
  difficultyRating: number;
  /** The mistake in the self-play game: its move number and the move played (in the problem's coordinates). */
  moveNumber: number;
  played: Gtp;
  /** The mistake was White's: every stone's color was swapped so Black is to play. */
  swapped: boolean;
}

/** One problem in data/problems.json. */
export interface StoredProblem {
  id: string;
  kind: ProblemKind;
  size: number;
  komi: number;
  /** The position: every stone on the board, as GTP. */
  stones: { B: Gtp[]; W: Gtp[] };
  toPlay: Color;
  prompt: string;
  category: MistakeCategory;
  /** Accepted answers: KataGo's moves within ANSWER_MARGIN of its best, plus moves later found to be as good. */
  answers: Gtp[];
  /** KataGo's best move and line when the problem was made. */
  bestMove?: Gtp;
  bestPv?: Gtp[];
  /** Points the mistake lost: the learner's move in their game, or the weaker side's in self-play. */
  difficulty?: number;
  source?: GameProblemSource | GeneratedProblemSource;
  /** Hash of the position and side to move; one problem per position. */
  hash: string;
  createdAt: number;
  /** Leitner box 1–5 and when the problem is next due (ms epoch). */
  box: number;
  due: number;
  /** Times shown to a result, and times solved. */
  seen: number;
  solves: number;
  lastResult?: "first_try" | "solved" | "failed";
  lastSeen?: number;
}

export interface Candidate {
  move: Gtp;
  /** Score lead for the side to move after this move. */
  lead: number;
  visits: number;
  pv: Gtp[];
}

/** The learner's game and move a problem comes from, or undefined for a generated problem. */
export function gameSource(p: Pick<StoredProblem, "source">): GameProblemSource | undefined {
  return p.source && p.source.kind !== "generated" ? p.source : undefined;
}

/** A generated problem's self-play source, or undefined for a problem from the learner's game. */
export function generatedSource(p: Pick<StoredProblem, "source">): GeneratedProblemSource | undefined {
  return p.source?.kind === "generated" ? p.source : undefined;
}

/** What views, events and lists show of a generated problem's origin. */
export function generatedInfo(p: Pick<StoredProblem, "source">): GeneratedProblemInfo | undefined {
  const s = generatedSource(p);
  return s && { batchId: s.batchId, difficultyRank: s.difficultyRank, weakerRank: s.weakerRank, strongerRank: s.strongerRank };
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** The stones on a board as GTP lists, in a stable order. */
export function stonesOf(board: Board): { B: Gtp[]; W: Gtp[] } {
  const size = board.length;
  const out: { B: Gtp[]; W: Gtp[] } = { B: [], W: [] };
  board.forEach((row, y) => row.forEach((c, x) => c && out[c].push(toGtp({ x, y }, size))));
  return out;
}

export function problemBoard(p: Pick<StoredProblem, "size" | "stones">): Board {
  const board = emptyBoard(p.size);
  for (const color of ["B", "W"] as const) {
    for (const gtp of p.stones[color]) {
      const point = tryFromGtp(gtp, p.size);
      if (!point) throw new Error(`Problem stone "${gtp}" is not on a ${p.size}×${p.size} board`);
      setCell(board, point, color);
    }
  }
  return board;
}

/** The rules engine at the problem position, with the learner to move. */
export function problemGame(p: Pick<StoredProblem, "size" | "komi" | "stones" | "toPlay">): GoGame {
  return GoGame.fromBoard(problemBoard(p), p.toPlay, p.komi);
}

/** The problem position for KataGo, with `moves` played from it (alternating, the learner first). */
export function problemPosition(p: Pick<StoredProblem, "size" | "komi" | "stones" | "toPlay">, moves: Gtp[] = []): Position {
  const other = opponent(p.toPlay);
  return {
    size: p.size,
    komi: p.komi,
    rules: "chinese",
    initialStones: [...p.stones.B.map((g) => ["B", g] as [Color, Gtp]), ...p.stones.W.map((g) => ["W", g] as [Color, Gtp])],
    initialPlayer: p.toPlay,
    moves: moves.map((m, i) => [i % 2 === 0 ? p.toPlay : other, m]),
  };
}

/** Identifies a position and side to move, so the same position never becomes two problems. */
export function positionHash(board: Board, toPlay: Color): string {
  return createHash("sha1").update(`${board.length}|${toPlay}|${positionKey(board)}`).digest("hex").slice(0, 16);
}

/**
 * The built-in starter problems this app used to ship (ids "b-…", kind "builtin"), which generated
 * problems replaced. The startup migration (generate.ts) removes them from problems.json.
 */
export function isLegacyBuiltin(p: { id?: unknown; kind?: unknown }): boolean {
  return p.kind === "builtin";
}

// ---------------------------------------------------------------------------
// Problems from the learner's mistakes
// ---------------------------------------------------------------------------

const PROMPTS: Record<MistakeCategory, string> = {
  life_and_death: "One of the groups here is fighting for its life. Find the move that settles it in your favor.",
  capturing_race: "Two groups are racing to capture each other. Find the move that wins the race.",
  tactics: "Stones can be captured or saved here. Find the sharpest move.",
  opening: "It's the opening. Find the biggest point on the board.",
  direction: "Which area matters most right now? Find the move that plays in the right direction.",
  shape: "Find the move with good shape, the one that keeps your stones strong and connected.",
  endgame: "It's the endgame. Find the biggest move left.",
  other: "Find the best move.",
};

export function promptFor(category: MistakeCategory, toPlay: Color): string {
  return `${colorName(toPlay)} to play. ${PROMPTS[category]}`;
}

/** Whether a mistake's stored candidates are too shallow to trust for the answers. */
export function candidatesThin(candidates: readonly Pick<Candidate, "visits">[]): boolean {
  return candidates.length < 2 || candidates.reduce((sum, c) => sum + c.visits, 0) < THIN_VISITS;
}

export function candidatesFromAnalysis(a: Analysis): Candidate[] {
  return a.moveInfos.map((m) => ({ move: m.move, lead: m.scoreLead, visits: m.visits, pv: m.pv }));
}

/**
 * KataGo's moves within ANSWER_MARGIN of its best (never a pass, never the move that was the
 * mistake). Besides the best, only moves searched with TRUSTED_CANDIDATE_VISITS count: a barely
 * searched move's lead is too rough to call it as good as the best.
 */
export function acceptedAnswers(candidates: readonly Candidate[], played?: Gtp): Gtp[] {
  const best = candidates[0];
  if (!best) return [];
  return candidates
    .filter((c) => (c === best || c.visits >= TRUSTED_CANDIDATE_VISITS) && c.lead >= best.lead - ANSWER_MARGIN && c.move !== "pass" && c.move !== played)
    .map((c) => c.move);
}

/** A human mistake from a finished game, with the position before it. */
export interface MistakeSnapshot {
  gameId: string;
  moveNumber: number;
  played: Gtp;
  pointLoss: number;
  category: MistakeCategory;
  size: number;
  komi: number;
  /** The board before the move, and the learner's color. */
  board: Board;
  toPlay: Color;
  /** KataGo's candidates in that position, best first. */
  candidates: Candidate[];
  /** A taken-back first attempt: its index in the game's `takenBack`. */
  takenBack?: number;
}

/** A practice problem from a mistake, or null when there is nothing to find (KataGo would pass, or no answer). */
export function problemFromMistake(m: MistakeSnapshot, id: string, now: number): StoredProblem | null {
  const best = m.candidates[0];
  if (!best || best.move === "pass") return null;
  const answers = acceptedAnswers(m.candidates, m.played);
  if (answers.length === 0) return null;
  return {
    id,
    kind: "game",
    size: m.size,
    komi: m.komi,
    stones: stonesOf(m.board),
    toPlay: m.toPlay,
    prompt: promptFor(m.category, m.toPlay),
    category: m.category,
    answers,
    bestMove: best.move,
    bestPv: best.pv.slice(0, 8),
    difficulty: round1(m.pointLoss),
    source: { gameId: m.gameId, moveNumber: m.moveNumber, played: m.played, ...(m.takenBack !== undefined && { takenBack: m.takenBack }) },
    hash: positionHash(m.board, m.toPlay),
    createdAt: now,
    box: 1,
    due: now,
    seen: 0,
    solves: 0,
  };
}

/** The next free id for a problem from a game: p1, p2, … */
export function nextProblemId(problems: readonly Pick<StoredProblem, "id">[]): string {
  const max = Math.max(0, ...problems.map((p) => Number(/^p(\d+)$/.exec(p.id)?.[1] ?? 0)));
  return `p${max + 1}`;
}

/** Adds new problems, skipping any whose position (or, from the learner's game, source move: `mistakeKey`) is already a problem. */
export function addProblems(problems: StoredProblem[], fresh: readonly StoredProblem[]): StoredProblem[] {
  const keyOf = (p: StoredProblem) => {
    const source = gameSource(p);
    return source ? mistakeKey(source) : null;
  };
  const hashes = new Set(problems.map((p) => p.hash));
  const sources = new Set(problems.flatMap((p) => keyOf(p) ?? []));
  const added: StoredProblem[] = [];
  for (const p of fresh) {
    const source = keyOf(p);
    if (hashes.has(p.hash) || (source && sources.has(source))) continue;
    hashes.add(p.hash);
    if (source) sources.add(source);
    problems.push(p);
    added.push(p);
  }
  return added;
}

/**
 * Some empty point is illegal only because of ko (positional superko): the position depends on its
 * history, which a problem drops. Not just the immediate single-stone retake: a superko ban can
 * fall elsewhere. A full scan, but it runs once per mistake at game end.
 */
export function hasKoBan(game: GoGame): boolean {
  return game.board.some((row, y) => row.some((cell, x) => cell === null && game.illegalReason({ x, y }) === "ko"));
}

/** What `generateProblems` needs from the controller. */
export interface ProblemMaker {
  /** A deeper KataGo analysis of a position, or null while KataGo isn't ready. */
  analyze(position: Position, opts: AnalyzeOptions): Promise<Analysis> | null;
  /** Queries KataGo runs at once. */
  concurrency: number;
  now(): number;
  log(msg: string): void;
  /** The game's summary as it is now: the tutor may have tagged a mistake while KataGo was busy. */
  currentSummary(): GameSummary | null | undefined;
  /** Loads the stored problems, lets `change` add to them, and saves them. */
  updateProblems<T>(change: (problems: StoredProblem[]) => T): T;
}

/**
 * Turns each mistake of a finished game into a practice problem and returns the ones added: the
 * position before it, the learner to play, and KataGo's candidates within ANSWER_MARGIN of its
 * best as the answers. A mistake whose stored candidates are thin is analyzed again, deeper,
 * first. So is one where a ko ban applied: the problem position has no move history, so the
 * immediate recapture is legal there and the game's candidates (a ko threat, say) no longer
 * answer it; without that analysis there is no problem.
 */
export async function generateProblems(
  game: { gameId: string; settings: GameSettings; moves: readonly MoveRecord[]; summary: GameSummary; takenBack?: readonly TakenBackMove[] },
  maker: ProblemMaker,
): Promise<StoredProblem[]> {
  const { gameId, settings, moves } = game;
  const snapshots: MistakeSnapshot[] = [];
  const koBanned = new Set<MistakeSnapshot>();
  for (const m of game.summary.mistakes) {
    // A taken-back first attempt was played in its own position, which later take-backs may have changed.
    const first = m.takenBack !== undefined ? game.takenBack?.[m.takenBack] : undefined;
    if (m.takenBack !== undefined && !first) continue;
    const record = first ? first.record : moves[m.moveNumber - 1];
    const evaluation = record?.eval;
    if (!record || !evaluation) continue;
    let before: GoGame;
    try {
      before = first ? gameFromLine(settings, first.before) : gameBefore(settings, moves, m.moveNumber);
    } catch {
      continue;
    }
    const snapshot: MistakeSnapshot = {
      gameId,
      moveNumber: m.moveNumber,
      played: m.move,
      pointLoss: evaluation.pointLoss,
      category: m.category ?? "other",
      size: settings.size,
      komi: settings.komi,
      board: before.board,
      toPlay: record.move.color,
      candidates: evaluation.candidates.map((c) => ({ move: c.move, lead: c.lead, visits: c.visits, pv: c.pv })),
      ...(m.takenBack !== undefined && { takenBack: m.takenBack }),
    };
    snapshots.push(snapshot);
    if (hasKoBan(before)) koBanned.add(snapshot);
  }
  const deepen = async (s: MistakeSnapshot): Promise<void> => {
    try {
      const position = problemPosition({ size: s.size, komi: s.komi, stones: stonesOf(s.board), toPlay: s.toPlay });
      // Nobody waits on it: the next game's queries go first.
      const analysis = maker.analyze(position, { maxVisits: DEEP_VISITS, priority: BACKGROUND_PRIORITY });
      if (analysis) {
        s.candidates = candidatesFromAnalysis(await analysis);
        return;
      }
    } catch (err) {
      maker.log(`deeper analysis for a problem from ${gameId} move ${s.moveNumber} failed: ${(err as Error).message}`);
    }
    if (koBanned.has(s)) s.candidates = []; // the game's answers belong to a position the problem can't show
  };
  // As many at once as KataGo runs, so they don't queue up ahead of the next game's analyses.
  const queue = snapshots.filter((s) => koBanned.has(s) || candidatesThin(s.candidates));
  const workers = Math.max(1, Math.min(queue.length, maker.concurrency));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) await deepen(s);
    }),
  );
  try {
    const now = maker.now();
    const current = maker.currentSummary() ?? game.summary;
    for (const s of snapshots) s.category = current.mistakes.find((m) => m.moveNumber === s.moveNumber && m.takenBack === s.takenBack)?.category ?? s.category;
    return maker.updateProblems((problems) => {
      const fresh: StoredProblem[] = [];
      for (const s of snapshots) {
        const problem = problemFromMistake(s, nextProblemId([...problems, ...fresh]), now);
        if (problem) fresh.push(problem);
      }
      return addProblems(problems, fresh);
    });
  } catch (err) {
    maker.log(`saving practice problems from ${gameId} failed: ${(err as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Spaced repetition
// ---------------------------------------------------------------------------

// Leitner boxes: src/shared/schedule.ts (BOX_INTERVALS, MAX_BOX, resultOf, schedule).

/**
 * Selection order: problems in the focus category first (the learner's own before generated ones),
 * then the learner's own problems, then generated ones; within a group, lower boxes and older due
 * times first.
 */
function rank(p: StoredProblem, focus: MistakeCategory | undefined): [number, number, number, number] {
  const group = p.category === focus ? (p.kind === "game" ? 0 : 1) : p.kind === "game" ? 2 : 3;
  return [group, p.box, p.due, p.createdAt];
}

function compareRank(a: [number, number, number, number], b: [number, number, number, number]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/** Problems in selection order: due ones first (by rank), then the rest by due time. */
export function orderProblems(problems: readonly StoredProblem[], now: number, focus?: MistakeCategory): StoredProblem[] {
  const due = problems.filter((p) => p.due <= now).sort((a, b) => compareRank(rank(a, focus), rank(b, focus)) || a.id.localeCompare(b.id));
  const later = problems.filter((p) => p.due > now).sort((a, b) => a.due - b.due || compareRank(rank(a, focus), rank(b, focus)) || a.id.localeCompare(b.id));
  return [...due, ...later];
}

/**
 * The problem next_problem shows: the first due one in selection order. When nothing is due, the
 * one due soonest (an early review), so practice never dead-ends. `exclude` (the problem just
 * shown) is skipped while there is anything else.
 */
export function pickNextProblem(
  problems: readonly StoredProblem[],
  opts: { now: number; focus?: MistakeCategory; exclude?: string },
): { problem: StoredProblem; early: boolean } | null {
  const pool = problems.length > 1 ? problems.filter((p) => p.id !== opts.exclude) : problems;
  const first = orderProblems(pool, opts.now, opts.focus)[0];
  return first ? { problem: first, early: first.due > opts.now } : null;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export function listItem(p: StoredProblem, now: number): ProblemListItem {
  const source = gameSource(p);
  const generated = generatedInfo(p);
  return {
    id: p.id,
    kind: p.kind,
    size: p.size,
    category: p.category,
    toPlay: p.toPlay,
    prompt: p.prompt,
    answers: p.answers,
    box: p.box,
    due: p.due,
    isDue: p.due <= now,
    seen: p.seen,
    solves: p.solves,
    ...(p.lastResult && { lastResult: p.lastResult }),
    ...(source && { source: { gameId: source.gameId, moveNumber: source.moveNumber } }),
    ...(p.difficulty !== undefined && { difficulty: p.difficulty }),
    ...(generated && { generated }),
  };
}

/** GET /api/problems. */
export function problemsResponse(problems: readonly StoredProblem[], now: number, focus: FocusRecommendation, generation?: GenerationStatus): ProblemsResponse {
  const ordered = orderProblems(problems, now, focus.category);
  const due = ordered.filter((p) => p.due <= now);
  const byBox = Array.from({ length: MAX_BOX }, (_, i) => problems.filter((p) => p.box === i + 1).length);
  const dueByCategory: Partial<Record<MistakeCategory, number>> = {};
  for (const p of due) dueByCategory[p.category] = (dueByCategory[p.category] ?? 0) + 1;
  return {
    problems: ordered.map((p) => listItem(p, now)),
    counts: {
      total: problems.length,
      due: due.length,
      fromGames: problems.filter((p) => p.kind === "game").length,
      generated: problems.filter((p) => p.kind === "generated").length,
      byBox,
      dueByCategory,
    },
    focus,
    ...(generation && { generation }),
  };
}
