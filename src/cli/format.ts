// Pure text formatting for the tutor CLI. Output is written for an LLM reader:
// compact, explicit labels, coordinates in GTP, no decoration.

import { toAscii } from "../engine/ascii.ts";
import { gameBefore, gameFromLine } from "../engine/game.ts";
import { moveGtp, movePoint, toGtp } from "../shared/coords.ts";
import { atLevelOf } from "../shared/judge.ts";
import { ratingToRank } from "../shared/rank.ts";
import { playedThreshold, sizeText, thresholdNum, thresholdText } from "../shared/threshold.ts";
import { JUDGE_MODE_TEXT, TUTOR_LEVEL_TEXT, assistText, estimateRankText, plural, rankEstimateText, round1, secondsUntil, takenBackTry, takenBackTryText } from "../shared/text.ts";
import type {
  ChatMessage,
  Color,
  FocusRecommendation,
  GameResult,
  GameSettings,
  GameSummary,
  GameView,
  GeneratedProblemInfo,
  GenerationBatchStatus,
  GenerationStatus,
  JudgeMode,
  Move,
  MoveRecord,
  Overlay,
  ProblemListItem,
  ProblemReview,
  ProblemsResponse,
  ProblemView,
  Profile,
  RatingChange,
  SavedGame,
  TakenBackMove,
  TeachingMoment,
  TutorCommand,
  TutorEvent,
  TutorLevel,
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
  const firsts = summary.mistakes.filter((m) => m.takenBack !== undefined).length;
  const taken = firsts ? ` (${firsts} taken back)` : "";
  return `${plural(n, "mistake")}${taken}, worst move ${worst.moveNumber} (${num(worst.pointLoss)})`;
}

/** A game's rating change: its rank estimate, the rating and the next bot. */
export function ratingChangeText(r: RatingChange): string {
  const next = `next bot ${r.nextBotRank}${r.nextHandicap ? ` with ${r.nextHandicap} handicap stones` : ""}`;
  if (r.pending) return `rank estimate running; rating ${num(r.before)} for now`;
  if (!r.rated) return `rating unchanged at ${num(r.after)} (games under 10 moves don't count); ${next}`;
  const estimate = r.estimate ? `${lowerFirst(rankEstimateText(r.estimate))}; ` : "";
  return `${estimate}rating ${num(r.before)} -> ${num(r.after)} (${signed(r.after - r.before)}, rank ${ratingToRank(r.after)}); ${next}`;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Where a problem comes from: "from g12 move 14", or "generated 13x13, difficulty 14k, batch2"
 * ("built-in" for the old starter problems in events logged before they were removed).
 */
export function problemOrigin(p: { source?: { gameId: string; moveNumber: number }; generated?: GeneratedProblemInfo; size?: number }): string {
  if (p.source) return `from ${p.source.gameId} move ${p.source.moveNumber}`;
  const size = p.size ?? 9;
  if (p.generated) return `generated ${size}x${size}, difficulty ${p.generated.difficultyRank}, ${p.generated.batchId}`;
  return "built-in";
}

/** ", review g12 2/4" for a problem in a review of one game's mistakes, else "". */
function reviewText(r: ProblemReview | undefined): string {
  return r ? `, review ${r.gameId} ${r.index}/${r.total}` : "";
}

/** "batch2 (17k vs 12k): 7/20 (9x9 3/7, 13x13 2/7, 19x19 2/6)". */
function batchText(b: GenerationBatchStatus): string {
  const sizes = b.sizes.map((s) => `${s.size}x${s.size} ${s.found}/${s.target}`).join(", ");
  return `${b.id} (${b.weakerRank} vs ${b.strongerRank}): ${b.found}/${b.target} (${sizes})`;
}

/** KataGo time per board size: "9x9 12 min (5 games), 13x13 …". */
function batchTimeText(b: GenerationBatchStatus): string {
  const total = b.sizes.reduce((sum, s) => sum + s.minutes, 0);
  return `${b.sizes.map((s) => `${s.size}x${s.size} ${num(s.minutes)} min (${plural(s.games, "game")})`).join(", ")}; ${num(total)} min in all`;
}

/** Problem generation in `summary`: the batch in progress, or how close the next one is. */
export function generationLines(g: GenerationStatus): string[] {
  const out: string[] = [];
  if (g.current) {
    const state = g.state === "generating" ? "generating now" : "paused while the learner plays (or KataGo is starting)";
    out.push(`problem generation: ${batchText(g.current)}, ${state}; difficulty band ${g.current.band}; new problems join practice as they're found`);
  }
  if (g.last) {
    const next = g.current ? "" : `; the next batch starts at ${g.last.needed} mastered (box 3+): ${g.last.mastered}/${g.last.needed}`;
    out.push(`last generated batch: ${g.last.id} (${g.last.weakerRank} vs ${g.last.strongerRank}), ${g.last.problems} problems, difficulty band ${g.last.band}${next}`);
  }
  if (!g.current && !g.last) out.push("problem generation: no batch yet (the first starts once KataGo is ready)");
  return out;
}

/** `tutor generate --status`: the batch in progress and the last finished one, with KataGo time per board size. */
export function formatGeneration(g: GenerationStatus): string {
  const out = generationLines(g);
  if (g.current) out.push(`  time so far: ${batchTimeText(g.current)}`);
  if (g.last) {
    const took = g.last.finishedAt !== undefined ? `, finished ${new Date(g.last.finishedAt).toLocaleString()}` : "";
    out.push(`  ${g.last.id} took: ${batchTimeText(g.last)}${took}`);
  }
  out.push(`finished batches: ${g.batches}`);
  return out.join("\n");
}

export interface EventContext {
  /** Current time (ms epoch) for countdowns. Default Date.now(). */
  now?: number;
  /**
   * Board size of a game, when known (e.g. from its game_start). Used for events logged before
   * they carried `size`; without either, a point is printed without coordinates.
   */
  sizeOf?: (gameId: string) => number | undefined;
  /**
   * True: `watch` prints the state (or, after GAME_END, the review) under this line, so it says so
   * instead of "run: state". False: it couldn't, so the line says to run it. Absent: the bare line.
   */
  attached?: boolean;
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
      return `GAME_START ${e.gameId} ${settingsText(e.settings)}${e.tutorLevel ? ` level=${e.tutorLevel}` : ""}${e.judgeMode ? ` ${judgeText(e.judgeMode, e.atLevelRank)}` : ""}`;
    case "tutor_level":
      return `LEVEL ${e.level} — ${TUTOR_LEVEL_TEXT[e.level].tutor} (from the learner's next move)`;
    case "judge_mode": {
      const text = judgeModeText(e.mode);
      return `JUDGE ${judgeText(e.mode, e.atLevelRank)}${text ? ` — ${text.tutor}` : ""} (from the learner's next move)`;
    }
    case "move": {
      const r = e.record;
      let line = `MOVE ${r.number} ${r.move.color} ${eventMoveGtp(r.move, e.size, e.gameId, ctx)} (${e.by})`;
      if (r.captures.length > 0) line += ` captures ${r.captures.length}`;
      if (r.eval) line += ` lost ${num(r.eval.pointLoss)} (best ${r.eval.bestMove})`;
      if (e.hintPending) line += " — played before your hint answer: that position is gone (don't draw on it)";
      return line;
    }
    case "teaching_moment": {
      const { moment: m, record: r } = e;
      const gtp = eventMoveGtp(r.move, e.size, e.gameId, ctx);
      const at = atLevelOf(r);
      const best = at
        ? ` (judged at level: vs the ${at.rank} move ${at.move}, pv ${pv(at.pv)}; vs KataGo's best ${r.eval!.bestMove} it lost ${num(r.eval!.pointLoss)})`
        : r.eval
          ? ` (best ${r.eval.bestMove}, pv ${pv(r.eval.bestPv)})`
          : "";
      const head = `MOMENT ${m.id} game=${e.gameId} move ${r.number} ${r.move.color} ${gtp} lost ${num(m.pointLoss)} pts${best}`;
      // A live moment is always "waiting"; any other state means a replay that the server brought up to date.
      if (m.state === "resolved") return `${head} (replayed; already resolved)`;
      const reply =
        e.tutorLevel === "point_out"
          ? ` — level point_out: ${TUTOR_LEVEL_TEXT.point_out.tutor} — answer in one call: claim ${m.id} && show/mark/say && resume`
          : ` — answer in one call: claim ${m.id} && show/say/rethink (&& resume)`;
      if (m.state !== "waiting") return `${head}${reply} (replayed; now ${m.state})`;
      const wait = m.deadline !== undefined ? `; fallback in ${secondsUntil(m.deadline, ctx.now ?? Date.now())}s` : "";
      const state = ctx.attached === true ? " — state below" : ctx.attached === false ? " — run state for the board" : "";
      return `${head}${reply}${wait}${state}`;
    }
    case "user_message":
      // On a practice problem the message is about the problem; the game id would point at the wrong board.
      if (e.problemId) return `USER ${quote(e.text)} (problem ${e.problemId}${e.playout ? ", playing it out: answer with one short say" : ""})`;
      return `USER ${quote(e.text)}${e.momentId ? ` (moment ${e.momentId})` : ""}${e.gameId ? ` game=${e.gameId}` : ""}${e.tutorLevel ? ` level=${e.tutorLevel}` : ""}${ctx.attached === true ? " — state below" : ctx.attached === false ? " — run state for the board" : ""}`;
    case "hint_request":
      return `HINT game=${e.gameId} ${e.toPlay} to play${e.tutorLevel ? ` level=${e.tutorLevel}` : ""} — user asks: ${quote(e.text ?? "hint please")} — ${ctx.attached ? "state below; answer with" : "run: state, then"} say/show/mark`;
    case "fallback":
      return `FALLBACK ${e.momentId} (tutor too slow; KataGo answer shown)`;
    case "undo":
      return `UNDO game=${e.gameId} by ${e.by}: back to move ${e.moves}, ${e.toPlay} to play`;
    case "game_end": {
      const r = e.summary.rating;
      const rating = r?.pending ? ", rank estimate running (a RATING line follows)" : r?.rated ? `, rating ${num(r.before)} -> ${num(r.after)}` : "";
      const help = e.summary.assistance ? `, help: ${assistText(e.summary.assistance)}` : "";
      return `GAME_END ${e.gameId} ${resultText(e.result)} — ${mistakesText(e.summary)}, total loss ${num(e.summary.totalPointLoss)} over ${e.summary.moves} moves${help}${rating} — ${ctx.attached ? "review below" : `run: review ${e.gameId}`}`;
    }
    case "rating":
      return `RATING ${e.gameId} ${ratingChangeText(e.rating)}`;
    case "problem_start":
      return (
        `PROBLEM_START ${e.problemId} ${e.category} ${e.toPlay} to play (${problemOrigin(e)}, box ${e.box}${reviewText(e.review)}) answers ${e.answers.join(",")} — ` +
        `${quote(e.prompt)} — ${ctx.attached ? "state below" : "run: state"}; let them try, don't give the answer`
      );
    case "generation": {
      const b = e.batch;
      if (e.status === "started") {
        return `BATCH ${b.id} started (${b.trigger}): ${b.target} problems from ${b.weakerRank} vs ${b.strongerRank} self-play, difficulty band ${b.band}; they join practice as they're found`;
      }
      const sizes = b.sizes.map((s) => `${s.found} on ${s.size}x${s.size}`).join(", ");
      return `BATCH ${b.id} finished: ${b.found} new problems (${sizes}), difficulty band ${b.band} — tell the learner when it fits (not mid-game on Silent)`;
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
  if (m.awaitingLearner) s += " (you resumed; still paused with the drawing, waiting for the learner to press Continue)";
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
  if (o.best) parts.push(`KataGo's move highlighted: ${toGtp(o.best, size)}`);
  return parts.length > 0 ? parts.join("; ") : "none";
}

/** Compact move list: `14 B C3 -6.2!` for human moves with evals; `!` flags a mistake-sized loss, `*` a move played with help. */
export function moveListText(moves: MoveRecord[], size: number, threshold: number, perLine = 10): string {
  const items = moves.map((r) => {
    let s = `${r.number} ${r.move.color} ${moveGtp(r.move, size)}`;
    if (r.eval) s += ` -${num(r.eval.pointLoss)}${r.eval.pointLoss >= threshold ? "!" : ""}`;
    if (r.assist?.length) s += "*";
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
export function problemLines(p: ProblemView, size?: number): string[] {
  const from = problemOrigin({ ...p, ...(size !== undefined && { size }) });
  const state = p.revealed ? (p.solved ? "solved" : "answer shown") : `attempt ${p.attempts + 1} of ${p.maxAttempts}`;
  const lines = [`problem ${p.id} ${p.category} (${from}, box ${p.box}${reviewText(p.review)}) ${p.toPlay} to play, ${state}: ${p.prompt}`];
  const a = p.lastAttempt;
  if (a) lines.push(`last attempt ${a.move} ${a.correct ? "correct" : "wrong"}${a.pointLoss !== null ? `, lost ${num(a.pointLoss)}` : ""}`);
  if (p.answer) lines.push(`answer ${p.answer.move} (pv ${pv(p.answer.pv)})`);
  if (p.playout) {
    const po = p.playout;
    lines.push(
      `playing it out against KataGo: move ${po.cursor} of ${po.line.length}${po.line.length ? ` (${pv(po.line)})` : ""}${po.over ? ", both passed" : ""} — unjudged; don't comment, only answer their chat`,
    );
  }
  if (p.recentMoves?.length && size !== undefined) {
    lines.push(`last moves (labeled on the board): ${[...p.recentMoves].reverse().map((m) => `-${m.ago} ${m.color} ${toGtp(m.point, size)}`).join(", ")}`);
  }
  return lines;
}

/** The learner's tutor level and what it means for the tutor. */
export function levelLine(level: TutorLevel): string {
  const text = TUTOR_LEVEL_TEXT[level] as (typeof TUTOR_LEVEL_TEXT)[TutorLevel] | undefined; // a newer server may send a level this CLI doesn't know
  return `tutor level ${level}${text ? `: ${text.tutor}` : ""}`;
}

/** The wording for a judge mode; undefined for one a newer server sends that this CLI doesn't know. */
function judgeModeText(mode: JudgeMode): (typeof JUDGE_MODE_TEXT)[JudgeMode] | undefined {
  return JUDGE_MODE_TEXT[mode] as (typeof JUDGE_MODE_TEXT)[JudgeMode] | undefined;
}

/** The reference rank, when the mode uses one and it is known. */
function referenceRank(mode: JudgeMode, rank?: string): string | undefined {
  return mode === "at_level" ? rank : undefined;
}

/** "judge=optimal", or "judge=at_level ref=17k" with the reference rank. */
function judgeText(mode: JudgeMode, rank?: string): string {
  const ref = referenceRank(mode, rank);
  return `judge=${mode}${ref ? ` ref=${ref}` : ""}`;
}

/** The learner's judge mode and what it means for the tutor. */
export function judgeLine(mode: JudgeMode, rank?: string): string {
  const ref = referenceRank(mode, rank);
  const text = judgeModeText(mode);
  return `judge ${mode}${ref ? ` (reference ${ref})` : ""}${text ? `: ${text.tutor}` : ""}`;
}

/** A move judged at level: ", at level -1.5 vs 17k D5" (a gain shows as +, the reference itself as 0). Empty otherwise. */
function atLevelText(r: MoveRecord): string {
  const at = atLevelOf(r);
  if (!at) return "";
  const loss = round1(at.loss);
  const score = loss < 0 ? `+${num(-loss)}` : loss > 0 ? `-${num(loss)}` : "0";
  return `, at level ${score} vs ${at.rank} ${at.move}`;
}

/** One-line status of the view, printed after every successful tutor command. */
export function statusLine(v: GameView, now = Date.now()): string {
  const parts: string[] = [];
  if (v.gameId) parts.push(`game=${v.gameId}`);
  if (v.problem) parts.push(`problem=${v.problem.id}`);
  parts.push(`mode=${v.mode}`, `status=${v.status}`);
  if (v.tutorLevel) parts.push(`level=${v.tutorLevel}`);
  if (v.judgeMode === "at_level") parts.push(judgeText(v.judgeMode, v.atLevelRank));
  if (v.mode === "game") parts.push(`threshold=${thresholdNum(v.mistakeThreshold)}`);
  if (v.status !== "finished" && v.mode !== "idle") parts.push(`toPlay=${v.toPlay}`);
  if (v.problem) {
    const p = v.problem;
    parts.push(`attempts=${p.attempts}/${p.maxAttempts}`);
    if (p.revealed) parts.push(p.solved ? "solved" : `answer shown (${p.answer?.move ?? "?"})`);
    if (p.playout) parts.push(`playout=${p.playout.cursor}/${p.playout.line.length}`);
  } else {
    parts.push(`moves=${v.moves.length}`);
  }
  if (v.moment && v.moment.state !== "resolved") parts.push(momentText(v.moment, now));
  if (v.result) parts.push(`result=${resultText(v.result)}`);
  return parts.join(" ");
}

/** The game stays paused with a drawing up, waiting for the learner's Continue (after the tutor's `resume`). */
function awaitingLearner(v: GameView): boolean {
  return !!v.moment?.awaitingLearner && v.status === "paused";
}

/** What a command that changed something prints: "ok" and the status, and for `resume` whether the pause now waits for the learner. */
export function commandOutput(command: TutorCommand, v: GameView, now = Date.now()): string {
  const status = `ok ${statusLine(v, now)}`;
  if (command.type !== "resume" || !awaitingLearner(v)) return status;
  return `${status}\nstill paused: your drawing stays on the board until the learner presses Continue (or Try again) when ready; you can keep talking with say`;
}

/** The --json output of a command: the view, and for `resume` whether the game is still paused waiting for the learner. */
export function commandJson(command: TutorCommand, v: GameView): string {
  return JSON.stringify(command.type === "resume" ? { ...v, stillPaused: awaitingLearner(v) } : v);
}

/** Moves `state --brief` lists in full; earlier ones show only their mistakes. */
const BRIEF_MOVES = 12;

/**
 * `state`. Brief (what `watch` prints under an event, which the tutor reads in the stream): no chat
 * tail (the tutor saw those lines), no level, judge, threshold or connection lines (the event lines
 * carry what matters), the last 12 moves with the earlier mistakes, and no "none" lines.
 */
export function formatState(v: GameView, now = Date.now(), chatTail = 8, brief = false): string {
  const size = v.settings?.size ?? v.board.length;
  const out: string[] = [];

  const head = [v.gameId ? `game ${v.gameId}` : "no game", `mode=${v.mode}`, `status=${v.status}`];
  if (v.settings) head.push(settingsText(v.settings));
  out.push(head.join(" "));
  const turn = [`toPlay=${v.toPlay}`, `captures B:${v.captures.B} W:${v.captures.W}`];
  if (!brief) turn.push(`tutor=${v.tutorAttached ? "attached" : "detached"}`, `engine=${v.engineBusy ? "busy" : "idle"}`);
  out.push(turn.join(" "));
  if (!brief && v.tutorLevel) out.push(levelLine(v.tutorLevel));
  if (!brief && v.judgeMode) out.push(judgeLine(v.judgeMode, v.atLevelRank));
  if (!brief && v.mode === "game") {
    out.push(`mistake threshold ${thresholdNum(v.mistakeThreshold)} pts on ${sizeText(size)} (a move losing this much or more is a teaching moment)`);
  }
  if (v.result) out.push(`result ${resultText(v.result)}`);
  if (v.problem) out.push(...problemLines(v.problem, size));
  if (v.board.length > 0) {
    out.push("", toAscii(v.board, movePoint(v.moves.at(-1)?.move)), "");
  }
  if (v.problem?.playout) {
    // A play-out's moves are unjudged, and the problem's line above lists them.
  } else if (brief && v.moves.length > BRIEF_MOVES) {
    const earlier = v.moves.slice(0, -BRIEF_MOVES).filter((r) => r.move.color === v.settings?.humanColor && r.eval && r.eval.pointLoss >= v.mistakeThreshold);
    out.push(`moves (last ${BRIEF_MOVES}; human loss in pts, ! = mistake):\n${moveListText(v.moves.slice(-BRIEF_MOVES), size, v.mistakeThreshold)}`);
    if (earlier.length) out.push(`earlier mistakes: ${earlier.map((r) => `${r.number} ${moveGtp(r.move, size)} -${num(r.eval!.pointLoss)}`).join(", ")}`);
  } else if (v.moves.length > 0 || !brief) {
    out.push(v.moves.length > 0 ? `moves (human loss in pts, ! = mistake):\n${moveListText(v.moves, size, v.mistakeThreshold)}` : "moves: none");
  }

  const last = v.moves[v.moves.length - 1];
  if (last?.eval) {
    const e = last.eval;
    out.push(
      `last move ${last.number} ${last.move.color} ${moveGtp(last.move, size)}: lead ${num(e.leadBefore)} -> ${num(e.leadAfter)}, ` +
        `winrate ${Math.round(e.winrateBefore * 100)}% -> ${Math.round(e.winrateAfter * 100)}%, best ${e.bestMove} (pv ${pv(e.bestPv)})${atLevelText(last)}`,
    );
    if (e.candidates.length > 0) {
      out.push(`candidates: ${e.candidates.map((c) => `${c.move} ${num(c.lead)}`).join(", ")}`);
    }
  }
  if (v.moment || !brief) out.push(v.moment ? momentText(v.moment, now) : "moment: none");
  if (v.overlay || !brief) out.push(`overlay: ${v.overlay ? overlayText(v.overlay, size) : "none"}`);
  if (brief) return out.join("\n");
  const tail = v.chat.slice(-chatTail);
  out.push(tail.length > 0 ? `chat (last ${tail.length} of ${v.chat.length}):\n${tail.map(chatLine).join("\n")}` : "chat: empty");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Summary and review
// ---------------------------------------------------------------------------

/**
 * The mistake threshold a saved game was played with, on its board (`playedThreshold` with the
 * profile's threshold and recent games); without a profile, `formatReview`'s default applies.
 */
export function reviewThreshold(g: Pick<ReviewedGame, "id" | "settings" | "summary">, p: Profile | null | undefined): number | undefined {
  return p ? playedThreshold(g, p.mistakeThreshold, p.recentGames) : undefined;
}

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
  const last = [...p.ratingHistory].reverse().find((h) => h.estimate);
  if (p.estimating?.length) out.push(`rank estimate for ${p.estimating.join(", ")} still running (a RATING line follows in watch)`);
  if (last?.estimate) {
    out.push(`last game's estimate (${last.gameId}): ${lowerFirst(rankEstimateText(last.estimate))}; the rating follows these move-quality estimates, the results only nudge it`);
  } else if (p.ratingModel === 2) {
    out.push("no rank estimate yet: one comes from each game of 10+ moves, from the moves played without help");
  }
  const handicap = p.handicap >= 2 ? `, learner takes ${p.handicap} handicap stones on 9x9 (rating below 20k, the weakest bot)` : "";
  out.push(`bot plays ${p.botRank}${handicap}`);
  if (p.tutorLevel) out.push(levelLine(p.tutorLevel));
  if (p.judgeMode) out.push(judgeLine(p.judgeMode));
  const change = p.thresholdHistory?.at(-1);
  out.push(
    `mistake threshold ${thresholdText(p.mistakeThreshold)}` +
      (change ? ` (last changed ${num(change.from)} -> ${num(change.to)} after ${change.gameId}: ${change.reason})` : ""),
  );
  if (history.length > 0) {
    const games = history.map((h) => {
      const estimate = h.estimate ? ` est ${estimateRankText(h.estimate)}/${h.estimate.moves} moves` : "";
      return `${h.gameId} ${h.won ? "won" : "lost"} vs ${h.botRank}${h.handicap ? ` H${h.handicap}` : ""}${h.delta !== undefined ? ` (${signed(h.delta)}${estimate})` : ""}`;
    });
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
      const first = m.takenBack !== undefined ? " (first try, taken back)" : "";
      out.push(`  ${m.gameId} move ${m.moveNumber}${first} ${m.category} -${num(m.pointLoss)}${m.note ? ` ${quote(m.note)}` : ""}`);
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
  const bits = [p.id, p.category, problemOrigin(p)];
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
    `practice problems: ${c.total} (${c.fromGames} from the learner's games, ${c.generated} generated), ` +
    `${c.due} due now${dueCats.length ? ` (${dueCats.join(", ")})` : ""}; boxes ${c.byBox.map((n, i) => `${i + 1}:${n}`).join(" ")}`;
  const generation = r.generation ? generationLines(r.generation) : [];
  const due = r.problems.filter((p) => p.isDue).slice(0, show);
  if (due.length === 0) return [head, ...generation, `nothing is due${c.total ? `; "problem" still starts the one due soonest` : ""}`].join("\n");
  return [head, ...generation, `next due (the first is what "problem" starts):`, ...due.map((p) => `  ${problemItemText(p, now, false)}`)].join("\n");
}

/** `tutor problems`: every problem in the order next_problem picks them, with the accepted answers. */
export function formatProblemList(r: ProblemsResponse, now = Date.now()): string {
  const out = [`problems: ${r.counts.total}, ${r.counts.due} due; focus ${r.focus.category} (next_problem prefers it, then the learner's own, then generated)`];
  for (const p of r.problems) out.push(`  ${problemItemText(p, now, true)}`);
  out.push("start one with: problem <id> (or problem for the next due)");
  return out.join("\n");
}

/** What a review reads of a saved game (GET /api/game/:id). */
export type ReviewedGame = Pick<SavedGame, "id" | "settings" | "moves"> & Partial<Pick<SavedGame, "result" | "summary" | "takenBack" | "assistance">>;

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

/** The board before move `n` (or before a taken-back first attempt, from its own line), or null when the moves don't replay. */
function boardBefore(g: ReviewedGame, n: number, first?: TakenBackMove): string | null {
  try {
    const game = first ? gameFromLine(g.settings, first.before) : gameBefore(g.settings, g.moves, n);
    return toAscii(game.board, movePoint(game.lastMove?.move));
  } catch {
    return null;
  }
}

/** The taken-back first attempt a summary entry is about, if it is one. */
function firstOf(g: ReviewedGame, m: { takenBack?: number }): TakenBackMove | undefined {
  return m.takenBack !== undefined ? g.takenBack?.[m.takenBack] : undefined;
}

/**
 * "(first try #2, taken back by the learner)" for a summary entry that is a first attempt: #n is
 * its number among the tries taken back at that move, what `tag --taken-back <n>` takes.
 */
function firstTryText(g: ReviewedGame, m: { takenBack?: number }): string {
  const first = firstOf(g, m);
  if (!first) return "";
  return ` (${takenBackTryText(takenBackTry(g.takenBack!, m.takenBack!))}, taken back by ${first.by === "tutor" ? "the tutor" : "the learner"})`;
}

/** A compact post-game review: result, rating change, mistakes with PVs, win-rate swings, boards before the worst mistakes, move list. */
/** `review`. Brief (what `watch` prints under GAME_END) leaves out the full move list; `review` has it. */
export function formatReview(g: ReviewedGame, threshold = playedThreshold(g), brief = false): string {
  const id = g.id;
  const size = g.settings.size;
  const human = g.settings.humanColor;
  const out: string[] = [];
  out.push(`game ${id} ${settingsText(g.settings)} result ${g.result ? resultText(g.result) : "unfinished"} moves ${g.moves.length}`);
  const rating = g.summary?.rating;
  if (rating) out.push(ratingChangeText(rating));
  const help = g.summary?.assistance ?? g.assistance;
  const assisted = g.moves.filter((r) => r.assist?.length);
  if (help || assisted.length) {
    const moves = assisted.map((r) => `${r.number} ${r.assist!.join("+")}`).join(", ");
    out.push(`help: ${help ? assistText(help) : "?"}${moves ? `; moves played with help (* below, left out of the rank estimate): ${moves}` : ""}`);
  }

  const mistakes: GameSummary["mistakes"] =
    g.summary?.mistakes ??
    g.moves
      .filter((r) => r.move.color === human && r.eval && r.eval.pointLoss >= threshold)
      .sort((a, b) => b.eval!.pointLoss - a.eval!.pointLoss)
      .map((r) => ({ moveNumber: r.number, move: moveGtp(r.move, size), pointLoss: r.eval!.pointLoss, bestMove: r.eval!.bestMove }));
  if (mistakes.length === 0) {
    out.push("mistakes: none");
  } else {
    const total = g.summary ? `, total loss ${num(g.summary.totalPointLoss)}` : "";
    out.push(`mistakes (${mistakes.length}, worst first${total}):`);
    for (const m of mistakes) {
      const first = firstOf(g, m);
      const record = first ? first.record : g.moves[m.moveNumber - 1];
      const category = m.category ? `[${m.category}${m.categorySource === "heuristic" ? ", heuristic" : ""}]` : "[untagged]";
      const line = record?.eval?.bestPv.length ? ` pv ${pv(record.eval.bestPv)}` : "";
      out.push(`  move ${m.moveNumber}${firstTryText(g, m)} ${record?.move.color ?? human} ${m.move} -${num(m.pointLoss)} best ${m.bestMove} ${category}${line}`);
    }
    const untagged = mistakes.filter((m) => m.categorySource !== "tutor");
    if (untagged.length) {
      const firsts = untagged.some((m) => m.takenBack !== undefined) ? " (add --taken-back <n> for first try #n)" : "";
      out.push(`  confirm or correct categories with: tag ${id} <move#> <category> [note]${firsts}`);
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
    const first = firstOf(g, m);
    const board = boardBefore(g, m.moveNumber, first);
    if (!board) continue;
    const color = (first ? first.record : g.moves[m.moveNumber - 1])?.move.color ?? human;
    out.push(`board before move ${m.moveNumber}${firstTryText(g, m)} (${color} played ${m.move}, best ${m.bestMove}):`, board);
  }

  if (brief) {
    out.push(`(the full move list: review ${id})`);
    return out.join("\n");
  }
  const legend = g.moves.some((r) => r.assist?.length) ? ", * = played with help" : "";
  out.push(g.moves.length > 0 ? `moves (human loss in pts, ! = mistake${legend}):\n${moveListText(g.moves, size, threshold)}` : "moves: none");
  return out.join("\n");
}
