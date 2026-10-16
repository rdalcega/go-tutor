// Pure text formatting for the tutor CLI. Output is written for an LLM reader:
// compact, explicit labels, coordinates in GTP, no decoration.

import { toAscii } from "../engine/ascii.ts";
import { gameBefore } from "../engine/game.ts";
import { moveGtp, movePoint, toGtp } from "../shared/coords.ts";
import { ratingToRank } from "../shared/rank.ts";
import { round1 } from "../shared/text.ts";
import type {
  ChatMessage,
  Color,
  FocusRecommendation,
  GameResult,
  GameSettings,
  GameSummary,
  GameView,
  Move,
  MoveRecord,
  Overlay,
  ProblemListItem,
  ProblemsResponse,
  ProblemView,
  Profile,
  SavedGame,
  TeachingMoment,
  TutorEvent,
} from "../shared/types.ts";

/** Formats a number with one decimal, dropping a trailing ".0". */
export function num(n: number): string {
  const r = round1(n);
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export function resultText(result: GameResult): string {
  if (result.winner === null) return result.reason === "abandon" ? "abandoned" : "draw";
  const how = result.reason === "resign" ? "R" : result.reason === "abandon" ? "abandon" : num(Math.abs(result.margin));
  return `${result.winner}+${how}`;
}

export function settingsText(s: GameSettings): string {
  const parts = [`${s.size}x${s.size}`, `komi ${num(s.komi)}`, `human=${s.humanColor}`, `bot=${s.botRank}`];
  if (s.handicap > 0) parts.push(`handicap ${s.handicap}`);
  return parts.join(" ");
}

function pv(moves: string[], max = 6): string {
  return moves.slice(0, max).join(" ");
}

function quote(text: string): string {
  // JSON escaping keeps multi-line user text on one line.
  return JSON.stringify(text);
}

function mistakesText(summary: GameSummary): string {
  const n = summary.mistakes.length;
  if (n === 0) return "no mistakes";
  const worst = summary.mistakes.reduce((a, b) => (b.pointLoss > a.pointLoss ? b : a));
  return `${n} mistake${n === 1 ? "" : "s"}, worst move ${worst.moveNumber} (${num(worst.pointLoss)})`;
}

export interface EventContext {
  /** Current time (ms epoch) for countdowns. Default Date.now(). */
  now?: number;
  /**
   * Board size of a game, when known (e.g. from its game_start). Used for events logged before
   * they carried `size`; without either, a point is printed without coordinates.
   */
  sizeOf?: (gameId: string) => number | undefined;
}

/** Whole seconds from `now` until `deadline`, never negative. */
function secondsUntil(deadline: number, now: number): number {
  return Math.max(0, Math.round((deadline - now) / 1000));
}

/** The move in GTP, or a note that its coordinates are unknown (an old event without `size`). */
function eventMoveGtp(move: Move, size: number | undefined, gameId: string, ctx: EventContext): string {
  if ("pass" in move) return "pass";
  const n = typeof size === "number" ? size : ctx.sizeOf?.(gameId);
  return typeof n === "number" ? moveGtp(move, n) : "(coords unavailable)";
}

/** One line per tutor event. Ends without a newline. Never throws: an event it can't read is printed raw. */
export function formatEvent(e: TutorEvent, ctx: EventContext = {}): string {
  try {
    return formatKnownEvent(e, ctx);
  } catch {
    return rawEvent(e);
  }
}

function rawEvent(e: unknown): string {
  const unknown = e as { type?: string; seq?: number };
  return `EVENT ${unknown.type ?? "unknown"} seq=${unknown.seq ?? "?"} ${JSON.stringify(e)}`;
}

function formatKnownEvent(e: TutorEvent, ctx: EventContext): string {
  switch (e.type) {
    case "game_start":
      return `GAME_START ${e.gameId} ${settingsText(e.settings)}`;
    case "move": {
      const r = e.record;
      let line = `MOVE ${r.number} ${r.move.color} ${eventMoveGtp(r.move, e.size, e.gameId, ctx)} (${e.by})`;
      if (r.captures.length > 0) line += ` captures ${r.captures.length}`;
      if (r.eval) line += ` lost ${num(r.eval.pointLoss)} (best ${r.eval.bestMove})`;
      return line;
    }
    case "teaching_moment": {
      const { moment: m, record: r } = e;
      const gtp = eventMoveGtp(r.move, e.size, e.gameId, ctx);
      const best = r.eval ? ` (best ${r.eval.bestMove}, pv ${pv(r.eval.bestPv)})` : "";
      const head = `MOMENT ${m.id} game=${e.gameId} move ${r.number} ${r.move.color} ${gtp} lost ${num(m.pointLoss)} pts${best}`;
      // A live moment is always "waiting"; any other state means a replay that the server brought up to date.
      if (m.state === "resolved") return `${head} (replayed; already resolved)`;
      const reply = ` — reply with: claim ${m.id}, then say/show/rethink/resume`;
      if (m.state !== "waiting") return `${head}${reply} (replayed; now ${m.state})`;
      const wait = m.deadline !== undefined ? `; fallback in ${secondsUntil(m.deadline, ctx.now ?? Date.now())}s` : "";
      return `${head}${reply}${wait}`;
    }
    case "user_message":
      // On a practice problem the message is about the problem; the game id would point at the wrong board.
      if (e.problemId) return `USER ${quote(e.text)} (problem ${e.problemId})`;
      return `USER ${quote(e.text)}${e.momentId ? ` (moment ${e.momentId})` : ""}${e.gameId ? ` game=${e.gameId}` : ""}`;
    case "hint_request":
      return `HINT game=${e.gameId} ${e.toPlay} to play — user asks: ${quote(e.text ?? "hint please")} — run: state, then say/show/mark`;
    case "fallback":
      return `FALLBACK ${e.momentId} (tutor too slow; KataGo answer shown)`;
    case "undo":
      return `UNDO game=${e.gameId} by ${e.by}: back to move ${e.moves}, ${e.toPlay} to play`;
    case "game_end":
      return (
        `GAME_END ${e.gameId} ${resultText(e.result)} — ${mistakesText(e.summary)}, ` +
        `total loss ${num(e.summary.totalPointLoss)} over ${e.summary.moves} moves` +
        (e.summary.rating?.rated ? `, rating ${num(e.summary.rating.before)} -> ${num(e.summary.rating.after)}` : "") +
        ` — run: review ${e.gameId}`
      );
    case "problem_start": {
      const from = e.source ? `from ${e.source.gameId} move ${e.source.moveNumber}` : "built-in";
      return (
        `PROBLEM_START ${e.problemId} ${e.category} ${e.toPlay} to play (${from}, box ${e.box}) answers ${e.answers.join(",")} — ` +
        `${quote(e.prompt)} — run: state; let them try, don't give the answer`
      );
    }
    case "problem_attempt": {
      const head = `PROBLEM ${e.problemId} attempt ${e.attempt} ${e.move}`;
      const loss = e.pointLoss !== null ? `, lost ${num(e.pointLoss)}` : "";
      const line = `best ${e.bestMove}, pv ${pv(e.bestPv)}`;
      if (e.correct) return `${head} correct${e.firstTry ? ", first try" : ""} (${e.category}) — ${line} — say why it works`;
      if (!e.revealed) return `${head} wrong${loss} (${e.category}; another attempt left) — ask what they see, don't give the answer (${line})`;
      return `${head} wrong${loss} (${e.category}; out of attempts, answer shown) — ${line} — explain it; show the refutation of ${e.move}`;
    }
    default:
      return rawEvent(e);
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function momentText(m: TeachingMoment, now: number): string {
  let s = `moment ${m.id} move ${m.moveNumber} lost ${num(m.pointLoss)} state=${m.state}`;
  if (m.state === "waiting" && m.deadline !== undefined) {
    s += ` (fallback in ${secondsUntil(m.deadline, now)}s; claim it to keep it)`;
  }
  return s;
}

export function overlayText(o: Overlay, size: number): string {
  const parts: string[] = [];
  if (o.variation && o.variation.moves.length > 0) {
    const moves = o.variation.moves.map((m) => `${m.color} ${toGtp(m.point, size)}`).join(", ");
    const from = o.variation.fromMove !== undefined ? ` (from the position before move ${o.variation.fromMove})` : "";
    parts.push(`variation${o.variation.label ? ` ${quote(o.variation.label)}` : ""}${from}: ${moves}`);
  }
  if (o.marks && o.marks.length > 0) {
    const marks = o.marks.map((m) => `${toGtp(m.point, size)} ${m.kind}${m.text ? ` ${quote(m.text)}` : ""}`);
    parts.push(`marks: ${marks.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : "none";
}

/** Compact move list: `14 B C3 -6.2!` for human moves with evals; `!` flags a mistake-sized loss. */
export function moveListText(moves: MoveRecord[], size: number, threshold = 4, perLine = 10): string {
  const items = moves.map((r) => {
    let s = `${r.number} ${r.move.color} ${moveGtp(r.move, size)}`;
    if (r.eval) s += ` -${num(r.eval.pointLoss)}${r.eval.pointLoss >= threshold ? "!" : ""}`;
    return s;
  });
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += perLine) lines.push(items.slice(i, i + perLine).join(" | "));
  return lines.join("\n");
}

function chatLine(c: ChatMessage): string {
  return `[${c.from}${c.momentId ? ` ${c.momentId}` : ""}] ${c.text.replace(/\s*\n\s*/g, " / ")}`;
}

/** The problem on the board in problem mode: what it is, where the learner is, and the answer once shown. */
export function problemLines(p: ProblemView): string[] {
  const from = p.source ? `from ${p.source.gameId} move ${p.source.moveNumber}` : "built-in";
  const state = p.revealed ? (p.solved ? "solved" : "answer shown") : `attempt ${p.attempts + 1} of ${p.maxAttempts}`;
  const lines = [`problem ${p.id} ${p.category} (${from}, box ${p.box}) ${p.toPlay} to play, ${state}: ${p.prompt}`];
  const a = p.lastAttempt;
  if (a) lines.push(`last attempt ${a.move} ${a.correct ? "correct" : "wrong"}${a.pointLoss !== null ? `, lost ${num(a.pointLoss)}` : ""}`);
  if (p.answer) lines.push(`answer ${p.answer.move} (pv ${pv(p.answer.pv)})`);
  return lines;
}

/** One-line status of the view, printed after every successful tutor command. */
export function statusLine(v: GameView, now = Date.now()): string {
  const parts: string[] = [];
  if (v.gameId) parts.push(`game=${v.gameId}`);
  if (v.problem) parts.push(`problem=${v.problem.id}`);
  parts.push(`mode=${v.mode}`, `status=${v.status}`);
  if (v.status !== "finished" && v.mode !== "idle") parts.push(`toPlay=${v.toPlay}`);
  if (v.problem) {
    const p = v.problem;
    parts.push(`attempts=${p.attempts}/${p.maxAttempts}`);
    if (p.revealed) parts.push(p.solved ? "solved" : `answer shown (${p.answer?.move ?? "?"})`);
  } else {
    parts.push(`moves=${v.moves.length}`);
  }
  if (v.moment && v.moment.state !== "resolved") parts.push(momentText(v.moment, now));
  if (v.result) parts.push(`result=${resultText(v.result)}`);
  return parts.join(" ");
}

export function formatState(v: GameView, now = Date.now(), chatTail = 8): string {
  const size = v.settings?.size ?? v.board.length;
  const out: string[] = [];

  const head = [v.gameId ? `game ${v.gameId}` : "no game", `mode=${v.mode}`, `status=${v.status}`];
  if (v.settings) head.push(settingsText(v.settings));
  out.push(head.join(" "));
  out.push(
    [
      `toPlay=${v.toPlay}`,
      `captures B:${v.captures.B} W:${v.captures.W}`,
      `tutor=${v.tutorAttached ? "attached" : "detached"}`,
      `engine=${v.engineBusy ? "busy" : "idle"}`,
    ].join(" "),
  );
  if (v.result) out.push(`result ${resultText(v.result)}`);
  if (v.problem) out.push(...problemLines(v.problem));
  if (v.board.length > 0) {
    out.push("", toAscii(v.board, movePoint(v.moves.at(-1)?.move)), "");
  }
  out.push(v.moves.length > 0 ? `moves (human loss in pts, ! = mistake):\n${moveListText(v.moves, size)}` : "moves: none");

  const last = v.moves[v.moves.length - 1];
  if (last?.eval) {
    const e = last.eval;
    out.push(
      `last move ${last.number} ${last.move.color} ${moveGtp(last.move, size)}: lead ${num(e.leadBefore)} -> ${num(e.leadAfter)}, ` +
        `winrate ${Math.round(e.winrateBefore * 100)}% -> ${Math.round(e.winrateAfter * 100)}%, best ${e.bestMove} (pv ${pv(e.bestPv)})`,
    );
    if (e.candidates.length > 0) {
      out.push(`candidates: ${e.candidates.map((c) => `${c.move} ${num(c.lead)}`).join(", ")}`);
    }
  }
  out.push(v.moment ? momentText(v.moment, now) : "moment: none");
  out.push(`overlay: ${v.overlay ? overlayText(v.overlay, size) : "none"}`);
  const tail = v.chat.slice(-chatTail);
  out.push(tail.length > 0 ? `chat (last ${tail.length} of ${v.chat.length}):\n${tail.map(chatLine).join("\n")}` : "chat: empty");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Summary and review
// ---------------------------------------------------------------------------

const signed = (n: number) => `${n >= 0 ? "+" : ""}${num(n)}`;

/** Category counts in the last 3 games, and whether they are rising or falling against older games. */
function categoryTrends(p: Profile): Map<string, { recent: number; trend: string }> {
  const games = (p.recentGames ?? []).map((g) => g.gameId);
  if (games.length === 0) {
    // Fall back to the games the recent mistakes come from (newest first).
    for (const m of p.recentMistakes) if (!games.includes(m.gameId)) games.unshift(m.gameId);
  }
  const last = new Set(games.slice(-3));
  const older = new Set(games.slice(0, -3));
  const out = new Map<string, { recent: number; trend: string }>();
  for (const c of Object.keys(p.mistakeCounts)) {
    const recent = p.recentMistakes.filter((m) => m.category === c && last.has(m.gameId)).length;
    const old = p.recentMistakes.filter((m) => m.category === c && older.has(m.gameId)).length;
    let trend = "";
    if (older.size > 0 && last.size > 0) {
      const diff = recent / last.size - old / older.size;
      trend = diff > 0.34 ? "rising" : diff < -0.34 ? "falling" : "steady";
    }
    out.set(c, { recent, trend });
  }
  return out;
}

export function formatProfile(p: Profile, focus?: FocusRecommendation | null): string {
  const out: string[] = [];
  const history = p.ratingHistory.slice(-5);
  const first = history[0];
  const trend =
    first && history.length > 1
      ? `, trend ${signed(p.rating - (first.rating - (first.delta ?? 0)))} over the last ${history.length} rated games`
      : "";
  out.push(`rank estimate ${ratingToRank(p.rating)} (rating ${num(p.rating)}${trend}), games ${p.gamesPlayed}, problems solved ${p.problemsSolved}`);
  const handicap = p.handicap >= 2 ? `, learner takes ${p.handicap} handicap stones on 9x9 (rating below 20k, the weakest bot)` : "";
  out.push(`bot plays ${p.botRank}${handicap}`);
  const change = p.thresholdHistory?.at(-1);
  out.push(
    `mistake threshold ${num(p.mistakeThreshold)} pts` +
      (change ? ` (last changed ${num(change.from)} -> ${num(change.to)} after ${change.gameId}: ${change.reason})` : ""),
  );
  if (history.length > 0) {
    const games = history.map((h) => `${h.gameId} ${h.won ? "won" : "lost"} vs ${h.botRank}${h.handicap ? ` H${h.handicap}` : ""}${h.delta !== undefined ? ` (${signed(h.delta)})` : ""}`);
    out.push(`recent rated games: ${games.join(", ")}`);
  }
  const trends = categoryTrends(p);
  const counts = Object.entries(p.mistakeCounts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  out.push(
    counts.length > 0
      ? `mistakes by category (total, in the last 3 games): ${counts
          .map(([c, n]) => {
            const t = trends.get(c);
            return `${c} ${n} (${t?.recent ?? 0}${t?.trend ? `, ${t.trend}` : ""})`;
          })
          .join(", ")}`
      : "mistakes by category: none yet",
  );
  const recent = p.recentMistakes.slice(0, 8);
  if (recent.length > 0) {
    out.push("recent mistakes:");
    for (const m of recent) {
      out.push(`  ${m.gameId} move ${m.moveNumber} ${m.category} -${num(m.pointLoss)}${m.note ? ` ${quote(m.note)}` : ""}`);
    }
  }
  if (focus) out.push(`recommended focus: ${focus.category}, as ${focus.suggestion === "problems" ? "practice problems" : "a game"} — ${focus.reason}`);
  return out.join("\n");
}

/** "now", "in 9m", "in 5h", "in 3d": when a problem is due. */
export function dueText(due: number, now: number): string {
  const ms = due - now;
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

function problemItemText(p: ProblemListItem, now: number, withAnswers: boolean): string {
  const bits = [p.id, p.category, p.source ? `from ${p.source.gameId} move ${p.source.moveNumber}` : "built-in"];
  if (p.difficulty !== undefined) bits.push(`(lost ${num(p.difficulty)})`);
  bits.push(`box ${p.box}`, `due ${dueText(p.due, now)}`);
  if (p.seen) bits.push(`solved ${p.solves}/${p.seen}${p.lastResult ? ` last ${p.lastResult}` : ""}`);
  if (withAnswers) bits.push(`answers ${p.answers.join(",")}`);
  return bits.join(" ");
}

/** The practice-problem part of `summary`: counts, and the next few that are due. */
export function formatProblems(r: ProblemsResponse, now = Date.now(), show = 5): string {
  const c = r.counts;
  const dueCats = Object.entries(c.dueByCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${cat} ${n}`);
  const head =
    `practice problems: ${c.total} (${c.fromGames} from the learner's games, ${c.builtin} built-in), ` +
    `${c.due} due now${dueCats.length ? ` (${dueCats.join(", ")})` : ""}; boxes ${c.byBox.map((n, i) => `${i + 1}:${n}`).join(" ")}`;
  const due = r.problems.filter((p) => p.isDue).slice(0, show);
  if (due.length === 0) return `${head}\nnothing is due; "problem" still starts the one due soonest`;
  return [`${head}`, `next due (the first is what "problem" starts):`, ...due.map((p) => `  ${problemItemText(p, now, false)}`)].join("\n");
}

/** `tutor problems`: every problem in the order next_problem picks them, with the accepted answers. */
export function formatProblemList(r: ProblemsResponse, now = Date.now()): string {
  const out = [`problems: ${r.counts.total}, ${r.counts.due} due; focus ${r.focus.category} (next_problem prefers it, then the learner's own, then built-ins)`];
  for (const p of r.problems) out.push(`  ${problemItemText(p, now, true)}`);
  out.push("start one with: problem <id> (or problem for the next due)");
  return out.join("\n");
}

/** What a review reads of a saved game (GET /api/game/:id). */
export type ReviewedGame = Pick<SavedGame, "id" | "settings" | "moves"> & Partial<Pick<SavedGame, "result" | "summary">>;

/** Win-rate swings of at least this much (0..1, the learner's view) are listed in a review. */
const SWING_MIN = 0.15;
const REVIEW_BOARDS = 3;

/**
 * Moves that swung the learner's win rate: their own moves (from the eval), and bot moves (the
 * change between the learner's previous move and their next one). Biggest first, at most `max`.
 */
export function winrateSwings(moves: MoveRecord[], human: Color, max = 5): { record: MoveRecord; from: number; to: number }[] {
  const swings: { record: MoveRecord; from: number; to: number }[] = [];
  let lastAfter: number | null = null;
  for (let i = 0; i < moves.length; i++) {
    const r = moves[i]!;
    if (r.move.color !== human) continue;
    const e = r.eval;
    if (!e) {
      lastAfter = null;
      continue;
    }
    const bot = moves[i - 1];
    if (bot && lastAfter !== null && bot.move.color !== human) swings.push({ record: bot, from: lastAfter, to: e.winrateBefore });
    swings.push({ record: r, from: e.winrateBefore, to: e.winrateAfter });
    lastAfter = e.winrateAfter;
  }
  return swings
    .filter((s) => Math.abs(s.to - s.from) >= SWING_MIN)
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
    .slice(0, max)
    .sort((a, b) => a.record.number - b.record.number);
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** The board before move `n`, or null when the moves don't replay. */
function boardBefore(g: ReviewedGame, n: number): string | null {
  try {
    const game = gameBefore(g.settings, g.moves, n);
    return toAscii(game.board, movePoint(game.lastMove?.move));
  } catch {
    return null;
  }
}

/** A compact post-game review: result, rating change, mistakes with PVs, win-rate swings, boards before the worst mistakes, move list. */
export function formatReview(g: ReviewedGame, threshold = 4): string {
  const id = g.id;
  const size = g.settings.size;
  const human = g.settings.humanColor;
  const out: string[] = [];
  out.push(`game ${id} ${settingsText(g.settings)} result ${g.result ? resultText(g.result) : "unfinished"} moves ${g.moves.length}`);
  const rating = g.summary?.rating;
  if (rating) {
    const next = `next bot ${rating.nextBotRank}${rating.nextHandicap ? ` with ${rating.nextHandicap} handicap stones` : ""}`;
    out.push(
      rating.rated
        ? `rating ${num(rating.before)} -> ${num(rating.after)} (${signed(rating.after - rating.before)}, rank ${ratingToRank(rating.after)}); ${next}`
        : `rating unchanged at ${num(rating.after)} (games under 10 moves don't count); ${next}`,
    );
  }

  const mistakes =
    g.summary?.mistakes ??
    g.moves
      .filter((r) => r.move.color === human && r.eval && r.eval.pointLoss >= threshold)
      .sort((a, b) => b.eval!.pointLoss - a.eval!.pointLoss)
      .map((r) => ({ moveNumber: r.number, move: moveGtp(r.move, size), pointLoss: r.eval!.pointLoss, bestMove: r.eval!.bestMove, category: undefined, categorySource: undefined }));
  if (mistakes.length === 0) {
    out.push("mistakes: none");
  } else {
    const total = g.summary ? `, total loss ${num(g.summary.totalPointLoss)}` : "";
    out.push(`mistakes (${mistakes.length}, worst first${total}):`);
    for (const m of mistakes) {
      const record = g.moves[m.moveNumber - 1];
      const category = m.category ? `[${m.category}${m.categorySource === "heuristic" ? ", heuristic" : ""}]` : "[untagged]";
      const line = record?.eval?.bestPv.length ? ` pv ${pv(record.eval.bestPv)}` : "";
      out.push(`  move ${m.moveNumber} ${record?.move.color ?? human} ${m.move} -${num(m.pointLoss)} best ${m.bestMove} ${category}${line}`);
    }
    if (mistakes.some((m) => m.categorySource !== "tutor")) {
      out.push(`  confirm or correct categories with: tag ${id} <move#> <category> [note]`);
    }
  }

  const swings = winrateSwings(g.moves, human);
  if (swings.length > 0) {
    out.push(`win-rate swings (learner's win rate):`);
    for (const s of swings) {
      const r = s.record;
      const who = r.move.color === human ? "" : " (bot)";
      out.push(`  move ${r.number} ${r.move.color} ${moveGtp(r.move, size)}${who} ${pct(s.from)} -> ${pct(s.to)} (${signed(Math.round((s.to - s.from) * 100))})`);
    }
  }

  for (const m of mistakes.slice(0, REVIEW_BOARDS)) {
    const board = boardBefore(g, m.moveNumber);
    if (!board) continue;
    out.push(`board before move ${m.moveNumber} (${g.moves[m.moveNumber - 1]?.move.color ?? human} played ${m.move}, best ${m.bestMove}):`, board);
  }

  out.push(g.moves.length > 0 ? `moves (human loss in pts, ! = mistake):\n${moveListText(g.moves, size, threshold)}` : "moves: none");
  return out.join("\n");
}
