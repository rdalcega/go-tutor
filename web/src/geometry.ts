// Pure helpers for the board UI: layout math, coordinates, eval color coding.
// No DOM access here so everything can be unit tested.

import { gameBefore } from "../../src/engine/game.ts";
import { GTP_COLUMNS, movePoint, samePoint } from "../../src/shared/coords.ts";
import { ratingToRank } from "../../src/shared/rank.ts";
import { categoryLabel, colorName, comeBackText, estimateRankText, plural, rankEstimateText } from "../../src/shared/text.ts";
import { sizeText, thresholdMultiplier, thresholdNum, thresholdText } from "../../src/shared/threshold.ts";
import type {
  Board,
  Color,
  GameSettings,
  GenerationBatchStatus,
  GenerationStatus,
  MistakeCategory,
  MoveRecord,
  Overlay,
  Point,
  ProblemView,
  Profile,
} from "../../src/shared/types.ts";

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

/**
 * Color coding for a move's point loss on a `size` board: red at the mistake `threshold` (on that
 * board) or more, green below 1 point scaled like the threshold (1.5 on 13×13, 2 on 19×19), amber
 * in between. With the defaults: green < 1, amber < 4, red >= 4.
 */
export function lossLevel(pointLoss: number, threshold = 4, size: GameSettings["size"] = 9): LossLevel {
  if (pointLoss < thresholdMultiplier(size)) return "good";
  if (pointLoss < threshold) return "inaccuracy";
  return "mistake";
}

/**
 * The progress card's threshold fact: `points` (the threshold on a `size` board) as "4 pts", and
 * the profile's 9×9 threshold `base` on every board.
 */
export function thresholdFact(points: number, size: GameSettings["size"], base: number): { short: string; long: string } {
  return {
    short: `${thresholdNum(points)} pts`,
    long: `The game pauses for a teaching moment when a move loses this many points or more on ${sizeText(size)}. Bigger boards have bigger mistakes: ${thresholdText(base)}.`,
  };
}

export function formatLoss(pointLoss: number): string {
  return pointLoss < 0.05 ? "0.0" : `−${pointLoss.toFixed(1)}`;
}

/** Human moves in order, with their eval when it has arrived. */
export function humanMoves(moves: MoveRecord[], humanColor: Color): MoveRecord[] {
  return moves.filter((m) => m.move.color === humanColor);
}

/**
 * A pass as the last move of a game (or of a problem's play-out): who passed, and whether it was the second pass in a row, which
 * ends the game. Null when the last move is a stone (or there are no moves). The UI uses it to make
 * the bot's pass obvious: a banner on the board and the status line.
 */
export interface LastPass {
  /** Move number of the pass, so each pass gets its banner once. */
  number: number;
  color: Color;
  by: "bot" | "human";
  /** The other side passed just before: the game is over (its score may not be in yet). */
  final: boolean;
}

export function lastPass(moves: MoveRecord[], humanColor: Color): LastPass | null {
  const last = moves.at(-1);
  if (!last || !("pass" in last.move)) return null;
  const before = moves.at(-2);
  return {
    number: last.number,
    color: last.move.color,
    by: last.move.color === humanColor ? "human" : "bot",
    final: !!before && "pass" in before.move,
  };
}

/** The board banner for the bot's pass ("White passed"), or null when the last move isn't one. */
export function botPassBanner(pass: LastPass | null): string | null {
  if (pass?.by !== "bot") return null;
  return pass.final ? `${colorName(pass.color)} passed too: the game is over` : `${colorName(pass.color)} passed`;
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

/**
 * What a finished game did to the rating, from the profile's history, with the game's rank estimate
 * in words ("Rank estimate 18k from 34 unassisted moves (3 hints)"); null when it didn't count.
 */
export function ratingChangeFor(profile: Profile, gameId: string): { before: string; after: string; delta: number; estimate?: string } | null {
  const entry = profile.ratingHistory.find((h) => h.gameId === gameId);
  if (!entry) return null;
  const delta = entry.delta ?? 0;
  return { before: ratingToRank(entry.rating - delta), after: ratingToRank(entry.rating), delta, ...(entry.estimate && { estimate: rankEstimateText(entry.estimate) }) };
}

/** The progress card's estimate: the latest game's rank and move count ("18k · 34 moves"), and the whole sentence for its tooltip. */
export function latestEstimate(profile: Profile): { short: string; long: string } | null {
  const estimate = [...profile.ratingHistory].reverse().find((h) => h.estimate)?.estimate;
  if (!estimate) return null;
  return { short: `${estimateRankText(estimate)} · ${estimate.moves} moves`, long: `Last game: ${rankEstimateText(estimate)}.` };
}

/** The problem card's title: category, and where the problem comes from (`size`: the problem's board); in a review, its progress ("Review 2/4 · Shape · move 14"). */
export function problemHeading(p: ProblemView, size = 9): string {
  if (p.review) {
    const move = p.source ? ` · move ${p.source.moveNumber}` : "";
    return `Review ${p.review.index}/${p.review.total} · ${categoryLabel(p.category, { capitalize: true })}${move}`;
  }
  const from = p.source
    ? `from your game, move ${p.source.moveNumber}`
    : p.generated
      ? `${size}×${size} · about ${p.generated.difficultyRank}`
      : "practice problem";
  return `${categoryLabel(p.category, { capitalize: true })} · ${from}`;
}

/** The problem card's Next button: on to the next problem, or within a review the next mistake, and after its last, the end. */
export function nextProblemLabel(p: ProblemView): string {
  if (!p.review) return "Next problem";
  return p.review.index < p.review.total ? "Next mistake" : "Finish review";
}

/**
 * The progress card's problem-generation line: "Generating 7/20" while a batch is being made,
 * else how close the next batch is ("Next batch at 15: 9 mastered"); the details for its tooltip.
 */
export function generationFact(g: GenerationStatus | undefined): { short: string; long: string } | null {
  if (!g) return null;
  const sizes = (b: GenerationBatchStatus) => b.sizes.map((s) => `${s.found}/${s.target} on ${s.size}×${s.size}`).join(", ");
  if (g.current) {
    const paused = g.state === "waiting" ? " It pauses while you play and picks up when KataGo is free." : "";
    return {
      short: `Generating ${g.current.found}/${g.current.target}`,
      long: `New practice problems from games KataGo plays against itself at ${g.current.weakerRank} vs ${g.current.strongerRank}: ${sizes(g.current)}. Each joins Practice as soon as it's found.${paused}`,
    };
  }
  if (g.last) {
    return {
      short: `${g.last.mastered}/${g.last.needed} mastered`,
      long: `Batch ${g.last.number}: ${g.last.problems} generated problems around ${g.last.band}. Master ${g.last.needed} of them (solve each on the first try twice) and a new batch is made at your level.`,
    };
  }
  return null;
}

/**
 * The labels of a problem's last moves before its position ("−1" on the last move, "−2" on the one
 * before, …), except where a drawing (a variation stone or a mark) is on the same point.
 */
export function recentMoveLabels(v: { problem?: ProblemView | null; overlay: Overlay | null; moves?: readonly MoveRecord[] }): { point: Point; text: string }[] {
  const drawn = [...(v.overlay?.variation?.moves ?? []), ...(v.overlay?.marks ?? [])].map((d) => d.point);
  const free = (p: Point) => !drawn.some((d) => samePoint(d, p));
  // Played out past the position: the play-out's moves are numbered instead (1 is the learner's
  // first), except the last, which has the last-move marker; the latest move on a point wins.
  if (v.problem?.playout && v.problem.playout.cursor > 0) {
    const labels = new Map<string, { point: Point; text: string }>();
    (v.moves ?? []).forEach((r, i) => {
      const point = movePoint(r.move);
      if (point) labels.set(`${point.x},${point.y}`, { point, text: String(i + 1) });
    });
    const last = movePoint(v.moves?.at(-1)?.move);
    if (last) labels.delete(`${last.x},${last.y}`);
    return [...labels.values()].filter((l) => free(l.point));
  }
  return (v.problem?.recentMoves ?? []).filter((m) => free(m.point)).map((m) => ({ point: m.point, text: `\u2212${m.ago}` }));
}

/** The play-out card's line: where the learner is in it, and that nothing here counts. */
export function playoutText(p: ProblemView): string {
  const po = p.playout;
  if (!po) return "";
  const at = po.cursor === 0 ? "The problem position" : `Move ${po.cursor} of ${po.line.length}`;
  return `${at} · nothing here is judged`;
}

/** The Forward button's tooltip: the next move of the line, or at its end KataGo moving for the side to play. */
export function forwardTitle(p: ProblemView, toPlay: Color): string {
  const po = p.playout;
  if (po && po.cursor >= po.line.length) return toPlay === p.toPlay ? "KataGo plays your move (→)" : "KataGo's move (→)";
  return "Next move (→)";
}

/** "2 attempts left", "1 attempt left", or "" once the problem is over. */
export function attemptsLeftText(p: ProblemView): string {
  if (p.revealed) return "";
  const left = Math.max(0, p.maxAttempts - p.attempts);
  return `${plural(left, "attempt")} left`;
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
