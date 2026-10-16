// Small wording helpers shared by the server, the tutor CLI and the browser.

import type { Color, GameResult, MistakeCategory, TutorLevel } from "./types.ts";

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
