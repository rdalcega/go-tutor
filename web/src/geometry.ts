// Pure helpers for the board UI: layout math, coordinates, eval color coding.
// No DOM access here so everything can be unit tested.

import { gameBefore } from "../../src/engine/game.ts";
import { GTP_COLUMNS, movePoint } from "../../src/shared/coords.ts";
import { ratingToRank } from "../../src/shared/rank.ts";
import { categoryLabel, comeBackText } from "../../src/shared/text.ts";
import type { Board, Color, GameSettings, MistakeCategory, MoveRecord, Point, ProblemView, Profile } from "../../src/shared/types.ts";

export interface BoardLayout {
  size: number;
  /** Board edge length in CSS pixels. */
  cssSize: number;
  /** Distance between adjacent lines in CSS pixels. */
  cell: number;
  /** Distance from the canvas edge to the first line (room for coordinates). */
  margin: number;
}

/** Margin in cells on each side of the grid: half a stone plus room for labels. */
export const MARGIN_CELLS = 1.15;

export function computeLayout(cssSize: number, size: number): BoardLayout {
  const cell = cssSize / (size - 1 + 2 * MARGIN_CELLS);
  return { size, cssSize, cell, margin: cell * MARGIN_CELLS };
}

export function pointToPixel(layout: BoardLayout, p: Point): { x: number; y: number } {
  return { x: layout.margin + p.x * layout.cell, y: layout.margin + p.y * layout.cell };
}

/** The intersection under a CSS-pixel position, or null when off the grid or too far from any point. */
export function pixelToPoint(layout: BoardLayout, px: number, py: number): Point | null {
  const fx = (px - layout.margin) / layout.cell;
  const fy = (py - layout.margin) / layout.cell;
  // `+ 0` normalizes -0 from rounding small negative offsets at the top/left edge.
  const x = Math.round(fx) + 0;
  const y = Math.round(fy) + 0;
  if (x < 0 || y < 0 || x >= layout.size || y >= layout.size) return null;
  // Accept clicks within a stone's radius of the intersection.
  if (Math.hypot(fx - x, fy - y) > 0.5) return null;
  return { x, y };
}

export function columnLabel(x: number): string {
  return GTP_COLUMNS[x] ?? "?";
}

/** Row label as shown on the board: row 1 is the bottom line. */
export function rowLabel(y: number, size: number): string {
  return String(size - y);
}

export type LossLevel = "good" | "inaccuracy" | "mistake";

/** Color coding for a move's point loss: green < 1, amber < 4, red >= 4. */
export function lossLevel(pointLoss: number): LossLevel {
  if (pointLoss < 1) return "good";
  if (pointLoss < 4) return "inaccuracy";
  return "mistake";
}

export function formatLoss(pointLoss: number): string {
  return pointLoss < 0.05 ? "0.0" : `−${pointLoss.toFixed(1)}`;
}

/** Human moves in order, with their eval when it has arrived. */
export function humanMoves(moves: MoveRecord[], humanColor: Color): MoveRecord[] {
  return moves.filter((m) => m.move.color === humanColor);
}

/** The most recent human move (evaluated or not). */
export function lastHumanMove(moves: MoveRecord[], humanColor: Color): MoveRecord | null {
  for (let i = moves.length - 1; i >= 0; i--) {
    const m = moves[i]!;
    if (m.move.color === humanColor) return m;
  }
  return null;
}

/**
 * Sparkline coordinates for a series of point losses in a w×h box. Higher loss is drawn lower
 * (the line dips on mistakes). The vertical scale is at least `minScale` points so a game of
 * small losses does not look dramatic.
 */
export function sparklinePoints(
  values: number[],
  w: number,
  h: number,
  minScale = 8,
  pad = 3,
): { x: number; y: number }[] {
  if (values.length === 0) return [];
  const max = Math.max(minScale, ...values);
  const step = values.length > 1 ? (w - 2 * pad) / (values.length - 1) : 0;
  return values.map((v, i) => ({
    x: values.length > 1 ? pad + i * step : w / 2,
    y: pad + (Math.min(v, max) / max) * (h - 2 * pad),
  }));
}

/**
 * The board as it was before move `moveNumber` (1-based) and the last stone placed before it, for
 * a variation drawn there (`Overlay.variation.fromMove`). Null when the moves don't get that far.
 */
export function positionBefore(
  moves: MoveRecord[],
  settings: GameSettings,
  moveNumber: number,
): { board: Board; lastMove: Point | null } | null {
  if (!Number.isInteger(moveNumber) || moveNumber < 1 || moveNumber > moves.length) return null;
  try {
    const game = gameBefore(settings, moves, moveNumber);
    return { board: game.board, lastMove: movePoint(game.lastMove?.move) };
  } catch {
    return null;
  }
}

/** Whole seconds remaining until `deadline` (ms epoch), never negative. */
export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * Sparkline coordinates for ratings in a w×h box: higher ratings are drawn higher. The vertical
 * range is at least `minRange` ranks so small wobbles stay small.
 */
export function ratingSparkPoints(values: number[], w: number, h: number, minRange = 2, pad = 4): { x: number; y: number }[] {
  if (values.length === 0) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const range = Math.max(minRange, hi - lo);
  const mid = (lo + hi) / 2;
  const step = values.length > 1 ? (w - 2 * pad) / (values.length - 1) : 0;
  return values.map((v, i) => ({
    x: values.length > 1 ? pad + i * step : w / 2,
    y: h / 2 - ((v - mid) / range) * (h - 2 * pad),
  }));
}

/** The `n` categories with the most mistakes, most first, as readable labels ("life and death 3"). */
export function topCategories(counts: Partial<Record<MistakeCategory, number>>, n = 2): string[] {
  return (Object.entries(counts) as [MistakeCategory, number][])
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([cat, c]) => `${categoryLabel(cat)} ${c}`);
}

/** The bot the next game defaults to, e.g. "19k" or "20k +2 stones". */
export function nextBotText(profile: Pick<Profile, "botRank" | "handicap">): string {
  return profile.handicap >= 2 ? `${profile.botRank} +${profile.handicap} stones` : profile.botRank;
}

/** What a finished game did to the rating, from the profile's history; null when it didn't count. */
export function ratingChangeFor(profile: Profile, gameId: string): { before: string; after: string; delta: number } | null {
  const entry = profile.ratingHistory.find((h) => h.gameId === gameId);
  if (!entry) return null;
  const delta = entry.delta ?? 0;
  return { before: ratingToRank(entry.rating - delta), after: ratingToRank(entry.rating), delta };
}

/** The problem card's title: category, and where the problem comes from. */
export function problemHeading(p: ProblemView): string {
  const from = p.source ? `from your game, move ${p.source.moveNumber}` : "classic problem";
  return `${categoryLabel(p.category, { capitalize: true })} · ${from}`;
}

/** "2 attempts left", "1 attempt left", or "" once the problem is over. */
export function attemptsLeftText(p: ProblemView): string {
  if (p.revealed) return "";
  const left = Math.max(0, p.maxAttempts - p.attempts);
  return `${left} attempt${left === 1 ? "" : "s"} left`;
}

/**
 * What the problem card says about the latest attempt, from KataGo's verdict: correct (and what
 * the board shows), wrong with tries left, or the answer once out of attempts. Null before any attempt.
 * Once the problem is over it also says when it comes back (spaced repetition), from `now`.
 */
export function problemResult(p: ProblemView, now = Date.now()): { text: string; tone: "good" | "bad" } | null {
  const a = p.lastAttempt;
  if (!a) return null;
  const loss = a.pointLoss !== null ? ` loses about ${a.pointLoss.toFixed(1)} points` : " isn't it";
  const again = p.revealed && p.nextDue !== undefined ? ` You'll see this one again ${comeBackText(p.nextDue, now)}.` : "";
  if (a.correct) {
    const first = p.attempts === 1 ? " on the first try" : "";
    const also = p.answer && p.answer.move !== a.move ? ` KataGo's favorite is ${p.answer.move}, and yours is about as good.` : "";
    return { text: `Correct${first}: ${a.move}.${also} The numbered stones show how play goes on.${again}`, tone: "good" };
  }
  if (!p.revealed) return { text: `${a.move}${loss}. Look again and try another move.`, tone: "bad" };
  const answer = p.answer ? ` The answer is ${p.answer.move}; the numbered stones show KataGo's line.` : "";
  return { text: `${a.move}${loss}.${answer}${again}`, tone: "bad" };
}

/** Exponential reconnect delay: 500ms, 1s, 2s … capped at `max`. */
export function backoffDelay(attempt: number, base = 500, max = 10_000): number {
  return Math.min(max, base * 2 ** Math.max(0, attempt));
}
