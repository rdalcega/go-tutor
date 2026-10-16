// Small wording helpers shared by the server, the tutor CLI and the browser.

import type { Color, GameResult, MistakeCategory } from "./types.ts";

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
