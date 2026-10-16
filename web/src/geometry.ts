// Pure helpers for the board UI: layout math, coordinates, eval color coding.
// No DOM access here so everything can be unit tested.

import { GoGame } from "../../src/engine/game.ts";
import { GTP_COLUMNS, toGtp } from "../../src/shared/coords.ts";
import type { Board, Color, GameSettings, GameView, MoveRecord, Point } from "../../src/shared/types.ts";

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

export function samePoint(a: Point | null | undefined, b: Point | null | undefined): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y;
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

export function moveLabel(record: MoveRecord, size: number): string {
  return "point" in record.move ? toGtp(record.move.point, size) : "pass";
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
    const game = GoGame.fromMoves(settings.size, settings.komi, settings.handicap, moves.slice(0, moveNumber - 1).map((r) => r.move));
    const last = game.lastMove;
    return { board: game.board, lastMove: last && "point" in last.move ? last.move.point : null };
  } catch {
    return null;
  }
}

/**
 * Whether Try again can take a move back: the game is on, the moment's move is still on the board
 * (a tutor's rethink already took it back), and there is a human move to undo.
 */
export function canRetry(v: GameView): boolean {
  const human = v.settings?.humanColor;
  if (!human || v.status === "finished" || v.result) return false;
  if (v.moment && v.moment.state !== "resolved" && v.moment.moveNumber > v.moves.length) return false;
  return lastHumanMove(v.moves, human) !== null;
}

/** Whole seconds remaining until `deadline` (ms epoch), never negative. */
export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** Exponential reconnect delay: 500ms, 1s, 2s … capped at `max`. */
export function backoffDelay(attempt: number, base = 500, max = 10_000): number {
  return Math.min(max, base * 2 ** Math.max(0, attempt));
}
