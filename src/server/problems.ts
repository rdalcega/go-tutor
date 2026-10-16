// Practice problems: built from the learner's own mistakes when a game ends, plus a built-in
// starter set (builtin-problems.ts), scheduled with Leitner boxes and judged against KataGo.
// Pure functions over StoredProblem; the controller (game.ts) makes the KataGo calls and store.ts
// reads and writes data/problems.json.

import { createHash } from "node:crypto";
import { GoGame, emptyBoard, positionKey, setCell } from "../engine/index.ts";
import { toGtp, tryFromGtp } from "../shared/coords.ts";
import type {
  Board,
  Color,
  FocusRecommendation,
  Gtp,
  MistakeCategory,
  ProblemListItem,
  ProblemsResponse,
} from "../shared/types.ts";
import { BUILTIN_PROBLEMS, type BuiltinProblem } from "./builtin-problems.ts";
import { TRUSTED_CANDIDATE_VISITS, type Analysis, type Position } from "./katago.ts";

/** A move within this many points of KataGo's best counts as a correct answer. */
export const ANSWER_MARGIN = 1.0;
/** Attempts before the answer is shown. */
export const MAX_ATTEMPTS = 2;
export const MAX_BOX = 5;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/**
 * How long until a problem is due again after a result, by Leitner box (index = box). Box 1 comes
 * back within the session; a problem solved first try five times in a row waits three weeks.
 */
export const BOX_INTERVALS: readonly number[] = [0, 10 * MINUTE, DAY, 3 * DAY, 7 * DAY, 21 * DAY];
/** A mistake's candidates with fewer visits than this in total are re-analyzed before answers are taken from them. */
export const THIN_VISITS = 200;
/** Visits for that re-analysis. */
export const DEEP_VISITS = 1000;

/** One problem in data/problems.json. */
export interface StoredProblem {
  id: string;
  kind: "game" | "builtin";
  /** What a built-in problem teaches (for the tutor). */
  title?: string;
  size: number;
  komi: number;
  /** The position: every stone on the board, as GTP. */
  stones: { B: Gtp[]; W: Gtp[] };
  toPlay: Color;
  prompt: string;
  category: MistakeCategory;
  /** Accepted answers: KataGo's moves within ANSWER_MARGIN of its best, plus moves later found to be as good. */
  answers: Gtp[];
  /** KataGo's best move and line when the problem was made (game problems). */
  bestMove?: Gtp;
  bestPv?: Gtp[];
  /** Points the learner's move lost in the game. */
  difficulty?: number;
  source?: { gameId: string; moveNumber: number; played: Gtp };
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

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** A board from a diagram: one string per row, top row first, cells X / O / . (spaces ignored). */
export function boardFromDiagram(rows: readonly string[]): Board {
  const size = rows.length;
  const board = emptyBoard(size);
  rows.forEach((row, y) => {
    const cells = row.replace(/\s+/g, "");
    if (cells.length !== size) throw new Error(`Diagram row ${y + 1} has ${cells.length} cells, expected ${size}: "${row}"`);
    [...cells].forEach((c, x) => {
      if (c === "X") setCell(board, { x, y }, "B");
      else if (c === "O") setCell(board, { x, y }, "W");
      else if (c !== ".") throw new Error(`Diagram row ${y + 1} has an unknown cell "${c}"`);
    });
  });
  return board;
}

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
  const board = problemBoard(p);
  const stones: { color: Color; point: { x: number; y: number } }[] = [];
  board.forEach((row, y) => row.forEach((c, x) => c && stones.push({ color: c, point: { x, y } })));
  return new GoGame(p.size, p.komi, 0, { stones, toPlay: p.toPlay });
}

/** The problem position for KataGo, with `moves` played from it (alternating, the learner first). */
export function problemPosition(p: Pick<StoredProblem, "size" | "komi" | "stones" | "toPlay">, moves: Gtp[] = []): Position {
  const other: Color = p.toPlay === "B" ? "W" : "B";
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

// ---------------------------------------------------------------------------
// Built-in problems
// ---------------------------------------------------------------------------

export function builtinProblem(def: BuiltinProblem): StoredProblem {
  const board = boardFromDiagram(def.board);
  return {
    id: def.id,
    kind: "builtin",
    title: def.title,
    size: board.length,
    komi: 7,
    stones: stonesOf(board),
    toPlay: def.toPlay,
    prompt: def.prompt,
    category: def.category,
    answers: [...def.answers],
    hash: positionHash(board, def.toPlay),
    createdAt: 0,
    box: 1,
    due: 0,
    seen: 0,
    solves: 0,
  };
}

/**
 * The stored problems with the built-in set merged in: a built-in's position, prompt and answers
 * come from the source file (plus any answers found since), its progress from the stored copy.
 * Built-ins no longer in the source are dropped.
 */
export function withBuiltins(stored: readonly StoredProblem[], defs: readonly BuiltinProblem[] = BUILTIN_PROBLEMS): StoredProblem[] {
  const byId = new Map(stored.map((p) => [p.id, p]));
  const builtins = defs.map((def) => {
    const fresh = builtinProblem(def);
    const old = byId.get(def.id);
    if (!old) return fresh;
    const { box, due, seen, solves, lastResult, lastSeen } = old;
    return {
      ...fresh,
      box,
      due,
      seen,
      solves,
      ...(lastResult && { lastResult }),
      ...(lastSeen !== undefined && { lastSeen }),
      answers: [...new Set([...fresh.answers, ...(old.answers ?? [])])],
    };
  });
  return [...stored.filter((p) => p.kind !== "builtin"), ...builtins];
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
  return `${toPlay === "B" ? "Black" : "White"} to play. ${PROMPTS[category]}`;
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
    difficulty: Math.round(m.pointLoss * 10) / 10,
    source: { gameId: m.gameId, moveNumber: m.moveNumber, played: m.played },
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

/** Adds new problems, skipping any whose position (or source move) is already a problem. */
export function addProblems(problems: StoredProblem[], fresh: readonly StoredProblem[]): StoredProblem[] {
  const hashes = new Set(problems.map((p) => p.hash));
  const sources = new Set(problems.flatMap((p) => (p.source ? [`${p.source.gameId}#${p.source.moveNumber}`] : [])));
  const added: StoredProblem[] = [];
  for (const p of fresh) {
    const source = p.source ? `${p.source.gameId}#${p.source.moveNumber}` : null;
    if (hashes.has(p.hash) || (source && sources.has(source))) continue;
    hashes.add(p.hash);
    if (source) sources.add(source);
    problems.push(p);
    added.push(p);
  }
  return added;
}

// ---------------------------------------------------------------------------
// Spaced repetition
// ---------------------------------------------------------------------------

export type ProblemResult = "first_try" | "solved" | "failed";

export function resultOf(solved: boolean, attempts: number): ProblemResult {
  return !solved ? "failed" : attempts <= 1 ? "first_try" : "solved";
}

/**
 * Leitner scheduling (mutates): solved first try moves the problem up a box, solved on a later try
 * keeps its box, failing sends it back to box 1. It is due again after its box's interval.
 */
export function schedule(p: StoredProblem, result: ProblemResult, now: number): void {
  if (result === "first_try") p.box = Math.min(MAX_BOX, p.box + 1);
  else if (result === "failed") p.box = 1;
  p.box = Math.max(1, Math.min(MAX_BOX, p.box));
  p.due = now + BOX_INTERVALS[p.box]!;
  p.seen++;
  if (result !== "failed") p.solves++;
  p.lastResult = result;
  p.lastSeen = now;
}

/**
 * Selection order: problems in the focus category first (the learner's own before built-ins), then
 * the learner's own problems, then built-ins; within a group, lower boxes and older due times first.
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
  return {
    id: p.id,
    kind: p.kind,
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
    ...(p.source && { source: { gameId: p.source.gameId, moveNumber: p.source.moveNumber } }),
    ...(p.difficulty !== undefined && { difficulty: p.difficulty }),
  };
}

/** GET /api/problems. */
export function problemsResponse(problems: readonly StoredProblem[], now: number, focus: FocusRecommendation): ProblemsResponse {
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
      builtin: problems.filter((p) => p.kind === "builtin").length,
      byBox,
      dueByCategory,
    },
    focus,
  };
}
