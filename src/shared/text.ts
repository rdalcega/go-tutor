// Small wording helpers shared by the server, the tutor CLI and the browser.

import { ratingToRank } from "./rank.ts";
import type { AssistCounts, Color, GameResult, JudgeMode, MistakeCategory, RankEstimate, TutorLevel } from "./types.ts";

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

/** "3 hints, 2 take-backs, 1 tutor take-back" (zero counts left out), or "no help". */
export function assistText(a: AssistCounts): string {
  const count = (n: number, word: string) => (n ? [`${n} ${word}${n === 1 ? "" : "s"}`] : []);
  const parts = [...count(a.hints, "hint"), ...count(a.takeBacks, "take-back"), ...count(a.rethinks, "tutor take-back")];
  return parts.length ? parts.join(", ") : "no help";
}

/** The estimated rank: "18k", or "20k or weaker" at the bottom of KataGo's human profiles. */
export function estimateRankText(e: Pick<RankEstimate, "rating" | "floor">): string {
  return e.floor ? "20k or weaker" : ratingToRank(e.rating);
}

/** "Rank estimate 18k from 34 unassisted moves (3 hints, 2 take-backs)": a game's estimate and the help left out of it. */
export function rankEstimateText(e: RankEstimate): string {
  const help = assistText(e);
  return `Rank estimate ${estimateRankText(e)} from ${e.moves} unassisted move${e.moves === 1 ? "" : "s"}${help === "no help" ? "" : ` (${help})`}`;
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
