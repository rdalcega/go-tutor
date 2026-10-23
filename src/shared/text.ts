// Small wording helpers shared by the server, the tutor CLI and the browser.

import { PRACTICE_MISS_LIMIT } from "./schedule.ts";
import { ratingToRank } from "./rank.ts";
import type { AssistCounts, Color, GameResult, JudgeMode, LessonInfo, MistakeCategory, MistakeRun, RankEstimate, TutorLevel } from "./types.ts";

/** "Black" or "White". */
export function colorName(c: Color): string {
  return c === "B" ? "Black" : "White";
}

/** "life and death", or "Life and death" with `capitalize`. */
export function categoryLabel(c: MistakeCategory, opts: { capitalize?: boolean } = {}): string {
  const words = c.replace(/_/g, " ");
  return opts.capitalize ? words.charAt(0).toUpperCase() + words.slice(1) : words;
}

/** Rounded to one decimal. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Rounded to two decimals. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "1 mistake", "3 mistakes". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Whole seconds from `now` until `deadline` (ms epoch), rounded up so a wait still running never reads 0; never negative. */
export function secondsUntil(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** "Black (you) wins by 4.5 points", "White wins by resignation", "a draw", "game abandoned". */
export function formatScore(result: GameResult, humanColor?: Color): string {
  const who = (c: Color) => colorName(c) + (humanColor ? (c === humanColor ? " (you)" : " (bot)") : "");
  if (result.reason === "abandon") return "game abandoned";
  if (!result.winner) return "a draw";
  if (result.reason === "resign") return `${who(result.winner)} wins by resignation`;
  return `${who(result.winner)} wins by ${Math.abs(result.margin)} points`;
}

/** The tutor levels in words: the UI's label and description, and what the tutor CLI tells the tutor. */
export const TUTOR_LEVEL_TEXT: Record<TutorLevel, { label: string; learner: string; tutor: string }> = {
  silent: {
    label: "Silent",
    learner: "No pauses or comments during games. Hints and your questions are still answered; the review comes after the game.",
    tutor: "no teaching moments; stay quiet during the game, answer only a USER or HINT line with one say; review after GAME_END",
  },
  point_out: {
    label: "Point out",
    learner: "Pauses at big mistakes and explains them, but never takes your move back.",
    tutor: "explain mistakes, don't take moves back (rethink is refused)",
  },
  coach: {
    label: "Coach",
    learner: "Pauses at big mistakes, explains them, and may take a move back so you can find a better one.",
    tutor: "full coaching: say, show, mark, and rethink to let them find the move",
  },
};

/** The chat line announcing the learner's new tutor level: "Tutor help: Coach. Pauses at …". */
export function tutorLevelChangedText(level: TutorLevel): string {
  const text = TUTOR_LEVEL_TEXT[level];
  return `Tutor help: ${text.label}. ${text.learner}`;
}

/** The judge modes in words: the UI's label and description, and what the tutor CLI tells the tutor. */
export const JUDGE_MODE_TEXT: Record<JudgeMode, { label: string; learner: string; tutor: string }> = {
  optimal: {
    label: "Optimal",
    learner: "Each move is scored against KataGo's best move.",
    tutor: "moves are scored, and moments opened, against KataGo's best move",
  },
  at_level: {
    label: "At level",
    learner:
      "Each move is scored against the move a player one rank above you would most likely play, so the game pauses only for mistakes a slightly stronger player wouldn't make. The review and practice problems still use KataGo's best move.",
    tutor:
      "moves are scored, and moments opened, against the move a player one rank up would most likely play (the MOMENT line names it); the review, mistakes and problems still use KataGo's best",
  },
};

/** The chat line announcing the learner's new judge mode: "Judging moves: At level (17k). Each move …". */
export function judgeModeChangedText(mode: JudgeMode, rank?: string): string {
  const text = JUDGE_MODE_TEXT[mode];
  return `Judging moves: ${text.label}${mode === "at_level" && rank ? ` (${rank})` : ""}. ${text.learner}`;
}

/**
 * Which try at its move number the taken-back move `takenBack[index]` was: 1 for the first one
 * taken back there, 2 for the next, … Stable, since `SavedGame.takenBack` only grows.
 */
export function takenBackTry(takenBack: readonly { moveNumber: number }[], index: number): number {
  const n = takenBack[index]?.moveNumber;
  return takenBack.slice(0, index + 1).filter((t) => t.moveNumber === n).length;
}

/** "first try #2": a taken-back try by its number at its move (what `tag --taken-back 2` takes). */
export function takenBackTryText(n: number): string {
  return `first try #${n}`;
}

/**
 * "A2 stayed the biggest point from move 57 to 69 (5 mistakes, one lesson)": a run of mistakes that
 * all missed one point (src/server/lessons.ts). Tries at one move read "through 3 tries at move 57".
 */
export function runText(answer: string, fromMove: number, toMove: number, count: number): string {
  return `${answer} stayed the biggest point ${runSpanText(fromMove, toMove, count)} (${count} mistakes, one lesson)`;
}

/** "from move 57 to 69", or "through 3 tries at move 57" for a run of tries at one move. */
export function runSpanText(fromMove: number, toMove: number, count: number): string {
  return fromMove === toMove ? `through ${count} tries at move ${fromMove}` : `from move ${fromMove} to ${toMove}`;
}

/** `runText` of a game's run (GameSummary.runs). */
export function mistakeRunText(run: MistakeRun): string {
  const first = run.mistakes[0]!;
  const last = run.mistakes[run.mistakes.length - 1]!;
  return runText(run.answer, first.moveNumber, last.moveNumber, run.mistakes.length);
}

/** `runText` of the lesson a practice problem is a variant of (without its point while the view leaves it out). */
export function lessonText(info: LessonInfo): string {
  if (info.answer) return runText(info.answer, info.fromMove, info.toMove, info.variants);
  return `the same point stayed the biggest ${runSpanText(info.fromMove, info.toMove, info.variants)} (${info.variants} mistakes, one lesson)`;
}

/** "3 hints, 1 question, 2 take-backs, 1 tutor take-back" (zero counts left out), or "no help". */
export function assistText(a: AssistCounts): string {
  const count = (n: number, word: string) => (n ? [plural(n, word)] : []);
  const parts = [...count(a.hints, "hint"), ...count(a.questions ?? 0, "question"), ...count(a.takeBacks, "take-back"), ...count(a.rethinks, "tutor take-back")];
  return parts.length ? parts.join(", ") : "no help";
}

/** The estimated rank: "18k", or "20k or weaker" at the bottom of KataGo's human profiles. */
export function estimateRankText(e: Pick<RankEstimate, "rating" | "floor">): string {
  return e.floor ? "20k or weaker" : ratingToRank(e.rating);
}

/** "Rank estimate 18k from 34 unassisted moves (3 hints, 2 take-backs)": a game's estimate and the help left out of it. */
export function rankEstimateText(e: RankEstimate): string {
  const help = assistText(e);
  return `Rank estimate ${estimateRankText(e)} from ${plural(e.moves, "unassisted move")}${help === "no help" ? "" : ` (${help})`}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When something due at `due` comes back, from `now`: "in about 10 minutes", "tomorrow", "in 3 days", "in 3 weeks". */
export function comeBackText(due: number, now: number): string {
  const ms = Math.max(0, due - now);
  if (ms < 1.5 * MINUTE) return "in a minute or so";
  if (ms < 90 * MINUTE) return `in about ${Math.round(ms / MINUTE)} minutes`;
  if (ms < 20 * HOUR) return `in about ${Math.round(ms / HOUR)} hours`;
  const days = Math.round(ms / DAY);
  if (days <= 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  return `in ${Math.round(days / 7)} weeks`;
}

/**
 * Why practice waits while it is closed after too many misses (`until`: when it opens), for the
 * learner's chat, the Practice button and the refusal of a picked problem.
 */
export function practiceBreakText(until: number): string {
  return (
    `Practice is taking a break until ${clockTime(until)}: ${PRACTICE_MISS_LIMIT} problems missed is enough for one go, ` +
    `and more of the same wouldn't stick. The ones you missed come first when it opens.`
  );
}

/** "15:40": a time of day, in the local time zone. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
