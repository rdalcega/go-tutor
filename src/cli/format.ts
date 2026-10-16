// Pure text formatting for the tutor CLI. Output is written for an LLM reader:
// compact, explicit labels, coordinates in GTP, no decoration.

import { toAscii } from "../engine/ascii.ts";
import { toGtp } from "../shared/coords.ts";
import { ratingToRank } from "../shared/rank.ts";
import type {
  ChatMessage,
  GameResult,
  GameSettings,
  GameSummary,
  GameView,
  Move,
  MoveRecord,
  Overlay,
  Point,
  Profile,
  TeachingMoment,
  TutorEvent,
} from "../shared/types.ts";

export function moveToGtp(move: Move, size: number): string {
  return "pass" in move ? "pass" : toGtp(move.point, size);
}

/** Formats a number with one decimal, dropping a trailing ".0". */
export function num(n: number): string {
  const r = Math.round(n * 10) / 10;
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
  /** Board size of a game, when known. Needed to turn points into GTP coordinates. */
  sizeOf(gameId: string): number | undefined;
  /** Current time (ms epoch) for countdowns. Default Date.now(). */
  now?: number;
}

/** Whole seconds from `now` until `deadline`, never negative. */
function secondsUntil(deadline: number, now: number): number {
  return Math.max(0, Math.round((deadline - now) / 1000));
}

/** One line per tutor event. Ends without a newline. */
export function formatEvent(e: TutorEvent, ctx: EventContext): string {
  // Without the board size a point has no GTP name (rows count from the bottom), so say so.
  const gtpIn = (gameId: string, move: Move) => {
    if ("pass" in move) return "pass";
    const size = ctx.sizeOf(gameId);
    if (size !== undefined) return toGtp(move.point, size);
    return `x${move.point.x},y${move.point.y} (board size unknown; 0-based from top-left)`;
  };
  switch (e.type) {
    case "game_start":
      return `GAME_START ${e.gameId} ${settingsText(e.settings)}`;
    case "move": {
      const r = e.record;
      let line = `MOVE ${r.number} ${r.move.color} ${gtpIn(e.gameId, r.move)} (${e.by})`;
      if (r.captures.length > 0) line += ` captures ${r.captures.length}`;
      if (r.eval) line += ` lost ${num(r.eval.pointLoss)} (best ${r.eval.bestMove})`;
      return line;
    }
    case "teaching_moment": {
      const { moment: m, record: r } = e;
      const gtp = gtpIn(e.gameId, r.move);
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
        `total loss ${num(e.summary.totalPointLoss)} over ${e.summary.moves} moves — run: review ${e.gameId}`
      );
    case "problem_attempt":
      return `PROBLEM ${e.problemId} attempt ${e.move} ${e.correct ? "correct" : "wrong"}`;
    default: {
      const unknown = e as { type?: string; seq?: number };
      return `EVENT ${unknown.type ?? "unknown"} seq=${unknown.seq ?? "?"} ${JSON.stringify(e)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function lastPlacedPoint(moves: MoveRecord[]): Point | null {
  const last = moves[moves.length - 1];
  return last && "point" in last.move ? last.move.point : null;
}

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
    let s = `${r.number} ${r.move.color} ${moveToGtp(r.move, size)}`;
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

/** One-line status of the view, printed after every successful tutor command. */
export function statusLine(v: GameView, now = Date.now()): string {
  const parts: string[] = [];
  if (v.gameId) parts.push(`game=${v.gameId}`);
  parts.push(`mode=${v.mode}`, `status=${v.status}`);
  if (v.status !== "finished" && v.mode !== "idle") parts.push(`toPlay=${v.toPlay}`);
  parts.push(`moves=${v.moves.length}`);
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
  if (v.problem) {
    const p = v.problem;
    const src = p.source ? ` from ${p.source.gameId} move ${p.source.moveNumber}` : "";
    out.push(`problem ${p.id}${src} attempts=${p.attempts} solved=${p.solved}: ${p.prompt}`);
  }
  if (v.board.length > 0) {
    out.push("", toAscii(v.board, lastPlacedPoint(v.moves)), "");
  }
  out.push(v.moves.length > 0 ? `moves (human loss in pts, ! = mistake):\n${moveListText(v.moves, size)}` : "moves: none");

  const last = v.moves[v.moves.length - 1];
  if (last?.eval) {
    const e = last.eval;
    out.push(
      `last move ${last.number} ${last.move.color} ${moveToGtp(last.move, size)}: lead ${num(e.leadBefore)} -> ${num(e.leadAfter)}, ` +
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

/** Loose shape of a practice problem from GET /api/problems (owned by Milestone 5). */
export interface ProblemInfo {
  id: string;
  prompt?: string;
  solved?: boolean;
  attempts?: number;
  category?: string;
  source?: { gameId: string; moveNumber: number };
}

export function formatProfile(p: Profile): string {
  const out: string[] = [];
  out.push(
    `rank estimate ${ratingToRank(p.rating)} (rating ${num(p.rating)}), bot plays ${p.botRank}, ` +
      `games ${p.gamesPlayed}, problems solved ${p.problemsSolved}, mistake threshold ${num(p.mistakeThreshold)} pts`,
  );
  const recentGames = p.ratingHistory.slice(-5);
  if (recentGames.length > 0) {
    out.push(`recent games: ${recentGames.map((h) => `${h.gameId} ${h.won ? "won" : "lost"} vs ${h.botRank}`).join(", ")}`);
  }
  const counts = Object.entries(p.mistakeCounts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  out.push(counts.length > 0 ? `mistakes by category: ${counts.map(([c, n]) => `${c} ${n}`).join(", ")}` : "mistakes by category: none tagged");
  const recent = p.recentMistakes.slice(0, 8);
  if (recent.length > 0) {
    out.push("recent mistakes:");
    for (const m of recent) {
      out.push(`  ${m.gameId} move ${m.moveNumber} ${m.category} -${num(m.pointLoss)}${m.note ? ` ${quote(m.note)}` : ""}`);
    }
  }
  return out.join("\n");
}

export function formatProblems(problems: ProblemInfo[]): string {
  const open = problems.filter((p) => !p.solved);
  if (open.length === 0) return `open problems: none (${problems.length} total)`;
  const lines = open.map((p) => {
    const bits = [p.id];
    if (p.category) bits.push(p.category);
    if (p.source) bits.push(`from ${p.source.gameId} move ${p.source.moveNumber}`);
    if (p.attempts) bits.push(`attempts=${p.attempts}`);
    return `  ${bits.join(" ")}${p.prompt ? `: ${p.prompt}` : ""}`;
  });
  return [`open problems (${open.length} of ${problems.length}) — start one with: problem <id>`, ...lines].join("\n");
}

/** Loose shape of a saved game from GET /api/game/:id (games/<id>.json). */
export interface SavedGame {
  id?: string;
  gameId?: string;
  settings: GameSettings;
  moves: MoveRecord[];
  result?: GameResult | null;
  summary?: GameSummary | null;
  chat?: ChatMessage[];
}

export function formatReview(g: SavedGame, threshold = 4): string {
  const id = g.id ?? g.gameId ?? "?";
  const size = g.settings.size;
  const out: string[] = [];
  out.push(`game ${id} ${settingsText(g.settings)} result ${g.result ? resultText(g.result) : "unfinished"} moves ${g.moves.length}`);
  out.push("moves (human: loss, best move, pv; bot moves bare):");
  for (const r of g.moves) {
    let s = `${r.number} ${r.move.color} ${moveToGtp(r.move, size)}`;
    if (r.captures.length > 0) s += ` x${r.captures.length}`;
    if (r.eval) {
      const e = r.eval;
      s += ` -${num(e.pointLoss)}`;
      if (e.pointLoss >= threshold) s += ` MISTAKE best ${e.bestMove} pv ${pv(e.bestPv)}`;
      else if (e.pointLoss >= 1) s += ` best ${e.bestMove}`;
    }
    out.push(s);
  }
  const summary = g.summary;
  if (summary) {
    out.push(`summary: ${mistakesText(summary)}, total loss ${num(summary.totalPointLoss)}`);
    for (const m of summary.mistakes) {
      out.push(`  move ${m.moveNumber} ${m.move} -${num(m.pointLoss)} best ${m.bestMove}${m.category ? ` [${m.category}]` : " [untagged]"}`);
    }
    if (summary.mistakes.some((m) => !m.category)) {
      out.push(`tag untagged mistakes with: tag ${id} <move#> <category> [note]`);
    }
  }
  return out.join("\n");
}
