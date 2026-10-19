// Lessons: when a big point stays open while the learner plays elsewhere, each move elsewhere is a
// new mistake with the same answer. Such a run of a game's mistakes is one oversight, so one lesson:
// it counts once in the profile, takes one category, and its practice problems are variants that
// share one schedule. Also the practice picker, which picks lessons (not problems) and keeps a set
// varied. Pure functions over boards, summaries and StoredProblem; the controller (game.ts) calls them.

import { gameBefore, gameFromLine } from "../engine/index.ts";
import { movePoint, tryFromGtp } from "../shared/coords.ts";
import { schedule, type ProblemResult } from "../shared/schedule.ts";
import type { Board, GameSettings, GameSummary, Gtp, LessonInfo, MistakeCategory, MistakeRef, MistakeRun, MoveRecord, TakenBackMove } from "../shared/types.ts";
import { acceptedAnswers, compareRank, gameSource, problemBoard, rank, recategorize, type StoredProblem } from "./problems.ts";

type SummaryMistake = GameSummary["mistakes"][number];

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** One mistake as runs see it: the board before it and its accepted answers. */
export interface RunItem {
  board: Board;
  answers: readonly Gtp[];
}

/** Move order: by move number; at one move, the taken-back first tries in order, then the move that stayed. */
export function compareRefs(a: MistakeRef, b: MistakeRef): number {
  return a.moveNumber - b.moveNumber || (a.takenBack ?? Number.MAX_SAFE_INTEGER) - (b.takenBack ?? Number.MAX_SAFE_INTEGER);
}

export function sameRef(a: MistakeRef, b: MistakeRef): boolean {
  return a.moveNumber === b.moveNumber && a.takenBack === b.takenBack;
}

/** Nothing was played on `answer` or on a point next to it (diagonals included) between the two boards. */
export function areaUnchanged(a: Board, b: Board, answer: Gtp): boolean {
  const size = a.length;
  const point = tryFromGtp(answer, size);
  if (!point || b.length !== size) return false;
  for (let y = point.y - 1; y <= point.y + 1; y++) {
    for (let x = point.x - 1; x <= point.x + 1; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      if ((a[y]![x] ?? null) !== (b[y]![x] ?? null)) return false;
    }
  }
  return true;
}

/**
 * Runs among a game's mistakes, given in move order: a mistake joins a run when it shares an
 * answer with the run's last mistake and the area around that answer hasn't changed since; the run
 * keeps the answers all of its mistakes share. `touched(from, to, answer)` says whether a move between
 * two items was played on or next to the answer (a capture can put the same stones back). Only runs of two or more are returned, as indices
 * into `items`, with the answer they share (the first mistake's best one).
 */
export function findRuns(
  items: readonly RunItem[],
  touched: (from: number, to: number, answer: Gtp) => boolean = () => false,
): { answer: Gtp; members: number[] }[] {
  const runs: { members: number[]; answers: Gtp[] }[] = [];
  items.forEach((item, i) => {
    for (const run of runs) {
      const lastIndex = run.members[run.members.length - 1]!;
      const last = items[lastIndex]!;
      const shared = run.answers.filter((a) => item.answers.includes(a) && areaUnchanged(last.board, item.board, a) && !touched(lastIndex, i, a));
      if (shared.length) {
        run.members.push(i);
        run.answers = shared;
        return;
      }
    }
    runs.push({ members: [i], answers: [...item.answers] });
  });
  return runs.filter((r) => r.members.length > 1).map((r) => ({ answer: r.answers[0]!, members: r.members }));
}

/** The mistake of a run that counts in the profile: a tutor-tagged one (the last in move order), else the worst. */
export function runLead(mistakes: readonly SummaryMistake[]): MistakeRef {
  const tagged = mistakes.filter((m) => m.categorySource === "tutor");
  const lead = tagged.length ? tagged[tagged.length - 1]! : mistakes.reduce((worst, m) => (m.pointLoss > worst.pointLoss ? m : worst));
  return ref(lead);
}

function ref(m: MistakeRef): MistakeRef {
  return { moveNumber: m.moveNumber, ...(m.takenBack !== undefined && { takenBack: m.takenBack }) };
}

/**
 * The runs among a finished game's mistakes (`mistakes`: the summary's), each mistake judged in
 * the position before it with KataGo's candidates from the game. A mistake that can't be replayed
 * is left out of every run.
 */
export function gameRuns(
  game: { settings: Pick<GameSettings, "size" | "komi" | "handicap">; moves: readonly MoveRecord[]; takenBack?: readonly TakenBackMove[] },
  mistakes: readonly SummaryMistake[],
): MistakeRun[] {
  const ordered = [...mistakes].sort(compareRefs);
  const items: (RunItem & { mistake: SummaryMistake })[] = [];
  for (const m of ordered) {
    const first = m.takenBack !== undefined ? game.takenBack?.[m.takenBack] : undefined;
    if (m.takenBack !== undefined && !first) continue;
    const record = first ? first.record : game.moves[m.moveNumber - 1];
    if (!record?.eval) continue;
    try {
      const before = first ? gameFromLine(game.settings, first.before) : gameBefore(game.settings, game.moves, m.moveNumber);
      items.push({ mistake: m, board: before.board, answers: acceptedAnswers(record.eval.candidates, m.move) });
    } catch {
      continue;
    }
  }
  // A move of the game between two mistakes on or next to the answer: the area changed, even if it looks the same again.
  const touched = (from: number, to: number, answer: Gtp): boolean => {
    const point = tryFromGtp(answer, game.settings.size);
    if (!point) return true;
    const end = items[to]!.mistake.moveNumber - 1;
    for (let i = items[from]!.mistake.moveNumber - 1; i < end; i++) {
      const p = movePoint(game.moves[i]?.move);
      if (p && Math.abs(p.x - point.x) <= 1 && Math.abs(p.y - point.y) <= 1) return true;
    }
    return false;
  };
  return findRuns(items, touched).map(({ answer, members }) => {
    const ms = members.map((i) => items[i]!.mistake);
    return { answer, mistakes: ms.map(ref), lead: runLead(ms) };
  });
}

/** The run a mistake belongs to, if any. */
export function runOf(summary: Pick<GameSummary, "runs"> | null | undefined, m: MistakeRef): MistakeRun | undefined {
  return summary?.runs?.find((r) => r.mistakes.some((x) => sameRef(x, m)));
}

// The texts of runs and lessons live in src/shared/text.ts (the tutor CLI uses them too).
export { lessonText, mistakeRunText, runText } from "../shared/text.ts";

// ---------------------------------------------------------------------------
// Lessons in practice
// ---------------------------------------------------------------------------

/** The lesson a problem belongs to: its lesson's id, or its own id when it stands alone. */
export function lessonKey(p: Pick<StoredProblem, "id" | "lesson">): string {
  return p.lesson?.id ?? p.id;
}

function sourceRef(p: StoredProblem): MistakeRef {
  const s = gameSource(p);
  return { moveNumber: s?.moveNumber ?? 0, ...(s?.takenBack !== undefined && { takenBack: s.takenBack }) };
}

/** Problems in move order (of the mistakes they come from), then by id. */
export function byMoveOrder(a: StoredProblem, b: StoredProblem): number {
  return compareRefs(sourceRef(a), sourceRef(b)) || a.id.localeCompare(b.id);
}

/** A problem's lesson: all its variants in move order (just the problem when it stands alone). */
export function variantsOf(problems: readonly StoredProblem[], p: Pick<StoredProblem, "id" | "lesson">): StoredProblem[] {
  const key = lessonKey(p);
  const found = problems.filter((q) => lessonKey(q) === key).sort(byMoveOrder);
  return found.length ? found : (problems.filter((q) => q.id === p.id) as StoredProblem[]);
}

/** What views, events and lists show of a problem's lesson, or undefined when it stands alone. */
export function lessonInfo(problems: readonly StoredProblem[], p: StoredProblem): LessonInfo | undefined {
  if (!p.lesson) return undefined;
  const variants = variantsOf(problems, p);
  if (variants.length < 2) return undefined;
  const source = gameSource(p);
  const index = variants.findIndex((v) => v.id === p.id);
  return {
    id: p.lesson.id,
    variant: index + 1,
    variants: variants.length,
    gameId: source?.gameId ?? "",
    answer: p.lesson.answer,
    fromMove: gameSource(variants[0]!)?.moveNumber ?? 0,
    toMove: gameSource(variants[variants.length - 1]!)?.moveNumber ?? 0,
  };
}

/** Fields the variants of a lesson share. */
const SHARED = ["box", "due", "lastResult", "missedAt"] as const;

/** Copy the lesson's shared schedule (and category, with its prompt) from `from` to every other variant (mutates). */
export function syncLesson(problems: readonly StoredProblem[], from: StoredProblem): void {
  if (!from.lesson) return;
  for (const v of variantsOf(problems, from)) {
    if (v === from) continue;
    for (const k of SHARED) {
      if (from[k] === undefined) delete v[k];
      else (v as unknown as Record<string, unknown>)[k] = Array.isArray(from[k]) ? [...(from[k] as number[])] : from[k];
    }
    if (v.category !== from.category) recategorize(v, from.category);
  }
}

/**
 * Make `members` (problems from one game) the variants of one lesson missing `answer` (mutates):
 * the first in move order names it. They take the most urgent schedule among them (the lowest box,
 * the earliest due, the latest result, every miss) and `category` (default: the first variant's).
 */
export function linkLesson(members: readonly StoredProblem[], answer: Gtp, category?: MistakeCategory): void {
  if (members.length < 2) return;
  const sorted = [...members].sort(byMoveOrder);
  const lead = sorted[0]!;
  const latest = sorted.reduce((a, b) => ((b.lastSeen ?? -Infinity) > (a.lastSeen ?? -Infinity) ? b : a));
  const missedAt = [...new Set(sorted.flatMap((p) => p.missedAt ?? []))].sort((a, b) => a - b).slice(-MISSES_KEPT);
  lead.box = Math.min(...sorted.map((p) => p.box));
  lead.due = Math.min(...sorted.map((p) => p.due));
  if (latest.lastResult) lead.lastResult = latest.lastResult;
  else delete lead.lastResult;
  if (missedAt.length) lead.missedAt = missedAt;
  else delete lead.missedAt;
  if (category && category !== lead.category) recategorize(lead, category);
  for (const p of sorted) p.lesson = { id: lead.id, answer };
  syncLesson(sorted, lead);
}

/**
 * Link the problems made from a game's runs into lessons (mutates; problems already in a lesson, or
 * whose answers no longer include the run's point, are left alone). A run with fewer than two problems (some mistakes made none) stays as it is. Returns
 * the lessons made, as their variants.
 */
export function linkGameLessons(problems: readonly StoredProblem[], gameId: string, runs: readonly MistakeRun[]): StoredProblem[][] {
  const made: StoredProblem[][] = [];
  for (const run of runs) {
    const members = run.mistakes.flatMap((m) => {
      const p = problems.find((q) => {
        const s = gameSource(q);
        return s?.gameId === gameId && s.moveNumber === m.moveNumber && s.takenBack === m.takenBack;
      });
      // A deeper analysis made for the problem may have dropped the run's point from its answers.
      return p && !p.lesson && p.answers.includes(run.answer) ? [p] : [];
    });
    if (members.length < 2) continue;
    linkLesson(members, run.answer);
    made.push(members);
  }
  return made;
}

/** A gap without any problem shown longer than this starts a new practice session. */
export const SESSION_GAP_MS = 2 * 60 * 60_000;
/** A lesson missed twice in one session isn't due again before this long. */
export const LATER_SESSION_MS = 24 * 60 * 60_000;
/** Misses kept per lesson. */
export const MISSES_KEPT = 3;

/**
 * When the practice session going on at `now` started: going back from `now` through the times
 * problems were shown, as long as no gap is longer than SESSION_GAP_MS.
 */
export function sessionStart(problems: readonly Pick<StoredProblem, "lastSeen" | "missedAt">[], now: number): number {
  const times = problems.flatMap((p) => [...(p.lastSeen !== undefined ? [p.lastSeen] : []), ...(p.missedAt ?? [])]).filter((t) => t <= now);
  times.sort((a, b) => b - a);
  let start = now;
  for (const t of times) {
    if (start - t > SESSION_GAP_MS) break;
    start = Math.min(start, t);
  }
  return start;
}

/**
 * A problem's result counts for its lesson (mutates): the problem is scheduled (Leitner box), and a
 * second miss in the same session pushes the lesson to a later day. Every variant takes the new
 * schedule. Returns the problem as stored now, or undefined when it isn't in `problems`.
 */
export function recordLessonResult(problems: readonly StoredProblem[], id: string, result: ProblemResult, now: number): StoredProblem | undefined {
  const p = problems.find((q) => q.id === id);
  if (!p) return undefined;
  const start = sessionStart(problems, now);
  schedule(p, result, now);
  if (result === "failed") {
    p.missedAt = [...(p.missedAt ?? []), now].slice(-MISSES_KEPT);
    if (p.missedAt.filter((t) => t >= start).length >= 2) p.due = Math.max(p.due, now + LATER_SESSION_MS);
  }
  syncLesson(problems, p);
  return p;
}

/**
 * The variant of a lesson to show: one never shown first (in move order), else the one shown
 * longest ago; `avoid` (the problem just shown) only when there is no other.
 */
export function pickVariant(variants: readonly StoredProblem[], avoid?: string): StoredProblem | undefined {
  const pool = variants.length > 1 ? variants.filter((v) => v.id !== avoid) : variants;
  return [...pool].sort((a, b) => (a.lastSeen ?? -Infinity) - (b.lastSeen ?? -Infinity) || byMoveOrder(a, b))[0];
}

/** A problem shown in the current practice set (since the learner pressed Practice). */
export interface SetEntry {
  id: string;
  lesson: string;
  /** The learner's game it comes from (none for a generated problem). */
  gameId?: string;
  category: MistakeCategory;
}

export function setEntry(p: StoredProblem): SetEntry {
  const gameId = gameSource(p)?.gameId;
  return { id: p.id, lesson: lessonKey(p), ...(gameId && { gameId }), category: p.category };
}

interface Unit {
  key: string;
  variants: StoredProblem[];
  /** The schedule the variants share (the first variant's). */
  head: StoredProblem;
}


function units(problems: readonly StoredProblem[]): Unit[] {
  const map = new Map<string, StoredProblem[]>();
  for (const p of problems) {
    const key = lessonKey(p);
    const list = map.get(key);
    if (list) list.push(p);
    else map.set(key, [p]);
  }
  return [...map].map(([key, variants]) => {
    variants.sort(byMoveOrder);
    return { key, variants, head: variants[0]! };
  });
}

/**
 * The problem next_problem shows. Lessons, not problems, are picked: due ones in selection order
 * (problems.ts `rank`, of the lesson's first variant), keeping the set varied while anything else is due: not the lesson or the game of the
 * problem just shown, and the focus category at most about half of the set. When nothing is due,
 * the lesson due soonest (an early review), so practice never dead-ends. Then the lesson's variant
 * (pickVariant).
 */
export function pickNextProblem(
  problems: readonly StoredProblem[],
  opts: { now: number; focus?: MistakeCategory; set?: readonly SetEntry[] },
): { problem: StoredProblem; early: boolean } | null {
  const set = opts.set ?? [];
  const last = set[set.length - 1];
  const all = units(problems);
  const due = all.filter((u) => u.head.due <= opts.now).sort((a, b) => compareRank(rank(a.head, opts.focus), rank(b.head, opts.focus)) || a.key.localeCompare(b.key));
  const later = all.filter((u) => u.head.due > opts.now).sort((a, b) => a.head.due - b.head.due || a.key.localeCompare(b.key));
  const otherLesson = (u: Unit) => !last || u.key !== last.lesson;
  const otherGame = (u: Unit) => !last?.gameId || gameSource(u.head)?.gameId !== last.gameId;
  const focusShown = set.filter((e) => e.category === opts.focus).length;
  // Showing it keeps the focus category at no more than half of the set.
  const focusRoom = (u: Unit) => u.head.category !== opts.focus || focusShown * 2 < set.length + 1;
  const unit =
    due.find((u) => otherLesson(u) && otherGame(u) && focusRoom(u)) ??
    due.find((u) => otherLesson(u) && otherGame(u)) ??
    due.find(otherLesson) ??
    later.find(otherLesson) ??
    due[0] ??
    later[0];
  if (!unit) return null;
  const problem = pickVariant(unit.variants, last?.id)!;
  return { problem, early: unit.head.due > opts.now };
}
