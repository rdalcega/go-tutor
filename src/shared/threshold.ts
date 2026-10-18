// The mistake threshold by board size, shared by the server, the tutor CLI and the browser.
//
// Profile.mistakeThreshold is the 9×9 value. Points lost per mistake grow with the board, so each
// size scales it: 4 points on 9×9 is 6 on 13×13 and 8 on 19×19.

import { round2 } from "./text.ts";
import { BOARD_SIZES, type BoardSize, type GameSettings, type GameSummary, type Profile } from "./types.ts";

/** How much each board size scales the 9×9 mistake threshold. */
export const THRESHOLD_MULTIPLIERS: Readonly<Record<BoardSize, number>> = { 9: 1, 13: 1.5, 19: 2 };

/** The multiplier for a board size. */
export function thresholdMultiplier(size: BoardSize): number {
  return THRESHOLD_MULTIPLIERS[size];
}

/** The mistake threshold in points on a `size` board, from the 9×9 threshold `base` (up to two decimals). */
export function thresholdFor(base: number, size: BoardSize): number {
  return round2(base * thresholdMultiplier(size));
}

/** A threshold in points as text: 4, 4.5, 6.75 (exact; thresholds have at most two decimals). */
export function thresholdNum(n: number): string {
  return String(round2(n));
}

/** The 9×9 threshold `base` on every board: "4 pts on 9×9 (6 on 13×13, 8 on 19×19)". */
export function thresholdText(base: number): string {
  const [first, ...rest] = BOARD_SIZES.map((size) => ({ pts: thresholdNum(thresholdFor(base, size)), on: sizeText(size) }));
  return `${first!.pts} pts on ${first!.on} (${rest.map((t) => `${t.pts} on ${t.on}`).join(", ")})`;
}

/**
 * The mistake threshold a game was played with, on its board: its summary's, else (a game finished
 * before thresholds scaled by size, which used the profile's threshold on every size) its
 * recent-games entry's or the profile's 9×9 `base`, unscaled; a game without a summary (unfinished)
 * gets `base` scaled to its board.
 */
export function playedThreshold(
  g: { id: string | null; settings: Pick<GameSettings, "size">; summary?: Pick<GameSummary, "threshold"> | null },
  base = 4,
  recentGames: Profile["recentGames"] = [],
): number {
  if (g.summary?.threshold !== undefined) return g.summary.threshold;
  if (g.summary) return recentGames.find((r) => r.gameId === g.id)?.threshold ?? base;
  return thresholdFor(base, g.settings.size);
}

/** "13×13". */
export function sizeText(size: number): string {
  return `${size}×${size}`;
}
