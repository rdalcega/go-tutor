// Token-cost simulation of a typical tutoring session: `npm run -s sim:tokens`.
//
// A scripted session (setup, a 9×9 game on one tutor level, the review, three practice problems)
// runs through the real `tutor watch` (src/cli/watch.ts) against a fake server, so every line the
// stream prints, with its attached state or review, is the real formatter's output. Each burst of
// output is one Monitor notification, i.e. one Claude turn. A tutor model then answers each
// notification the way CLAUDE.md tells it to (the tool calls it makes and roughly how much it
// writes), and every Claude API call is priced as Claude Code makes it: the whole context is a
// cache read, what was added since the last call is a 1-hour cache write, and the reply is output.
//
// Two protocols are compared: "before" (the stream printing every event, and the CLAUDE.md that
// went with it) and "after" (the current stream and CLAUDE.md). Constants are calibrated on a real
// session transcript (one silent game, review and two problems: 122 calls, about $3.35).

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { Client } from "../src/cli/client.ts";
import { commandOutput, formatReview, formatState } from "../src/cli/format.ts";
import { watch } from "../src/cli/watch.ts";
import { toAscii } from "../src/engine/ascii.ts";
import { GoGame } from "../src/engine/game.ts";
import { TutorBridge } from "../src/server/bridge.ts";
import type { TutorEventInput } from "../src/server/common.ts";
import type { GameController } from "../src/server/game.ts";
import type { Store } from "../src/server/store.ts";
import { fromGtp, movePoint, toGtp } from "../src/shared/coords.ts";
import type {
  ChatMessage,
  Color,
  GameSettings,
  GameSummary,
  GameView,
  Gtp,
  MoveEval,
  MoveRecord,
  ProblemView,
  SavedGame,
  TeachingMoment,
  TutorCommand,
  TutorEvent,
  TutorLevel,
} from "../src/shared/types.ts";

// ---------------------------------------------------------------------------
// Prices and calibration
// ---------------------------------------------------------------------------

/** Claude Opus 5.5, $ per million tokens. Claude Code caches with a 1-hour TTL (writes at 2× input). */
export const PRICES = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 };

export const CALIBRATION = {
  /** Context at the first call: system prompt, tools, CLAUDE.md files, the user's first message. */
  baseContext: 48_800,
  /** Tokens a Monitor notification adds besides its text (task-notification wrapper, reminders). */
  notificationOverhead: 250,
  /** Tokens a tool call adds besides its command and result (tool_use and tool_result framing). */
  toolCallOverhead: 130,
  /** Characters per token for CLI output: coordinates and boards tokenize densely. */
  charsPerToken: 2.5,
};

const tokens = (text: string): number => Math.ceil(text.length / CALIBRATION.charsPerToken);

// ---------------------------------------------------------------------------
// The tutor model
// ---------------------------------------------------------------------------

export type Protocol = "before" | "after";

/** One Claude API call: the tool calls it makes (none for the turn's last call) and its output tokens (thinking included). */
interface Call {
  tools: { command: string; result: () => string }[];
  out: number;
}

/** Output tokens per kind of call, from the transcript (thinking included). */
const OUT = {
  /** A notification needing nothing: "before" narrated every move ("The bot played G4… Your move."). */
  ack: { before: 35, after: 15 },
  /** The closing text after tool work: "before" summarized for the terminal; "after" keeps it to a few words. */
  final: { before: 150, after: 30 },
  claim: 60,
  state: 50,
  say: 220,
  show: 200,
  /** One call that chains several commands (show, say, resume or tag): the say's text plus the line. */
  chained: 380,
  tag: 90,
  review: 120,
  rearm: 200,
};

const SAY = `npm run -s tutor -- say "${"x".repeat(240)}"`;
const SHOW = `npm run -s tutor -- show D5 E4 C6 E6 --label "${"x".repeat(30)}"`;

/** What a notification is about, beyond its first line: the scripted reason the learner wrote or did it. */
export type Beat =
  | { kind: "user-question" }
  | { kind: "board-question" }
  | { kind: "review-answer"; last: boolean }
  | { kind: "problem-reply" }
  | { kind: "start-problems" }
  | { kind: "moment"; action: "rethink" | "show" }
  | { kind: "none" };

/** The kind of event a notification answers: deferred lines (GAME_START, PROBLEM_START, BATCH finished, FALLBACK) lead the event they ride with. */
function headOf(text: string): string {
  const lines = text.split("\n").filter((l) => /^[A-Z_]+ /.test(l));
  const main = lines.find((l) => !/^(GAME_START|PROBLEM_START|FALLBACK|BATCH \S+ finished)/.test(l)) ?? lines[0] ?? text;
  return main.split(" ")[0]!;
}

/**
 * The calls Claude makes for one notification, following the protocol's CLAUDE.md. `status` is the
 * status line a command prints, `state` and `review` what those commands print now. (A finished
 * batch riding along is mentioned in that answer's say: no extra call.)
 */
function respond(protocol: Protocol, text: string, beat: Beat, w: World): Call[] {
  const p = protocol;
  const head = headOf(text);
  const status = (command: TutorCommand) => () => commandOutput(command, w.view(), w.now);
  const say = { command: SAY, result: status({ type: "say", text: "" }) };
  const state = { command: "npm run -s tutor -- state", result: () => formatState(w.view(), w.now) };
  const final = (): Call => ({ tools: [], out: OUT.final[p] });
  const ack = (): Call[] => [{ tools: [], out: OUT.ack[p] }];
  const chain = (...names: string[]) => ({ command: names.map((n) => `npm run -s tutor -- ${n} …`).join(" && "), result: () => names.map(() => status({ type: "say", text: "" })()).join("\n") });
  switch (head) {
    case "MOMENT": {
      const rethink = beat.kind === "moment" && beat.action === "rethink";
      const claim = { command: "npm run -s tutor -- claim m1", result: status({ type: "claim", momentId: "m1" }) };
      const rethinkCall = { command: `npm run -s tutor -- rethink "${"x".repeat(100)}"`, result: status({ type: "rethink", text: "" }) };
      if (p === "before") {
        if (rethink) return [{ tools: [claim], out: OUT.claim }, { tools: [state], out: OUT.state }, { tools: [rethinkCall], out: OUT.say }, final()];
        return [
          { tools: [claim], out: OUT.claim },
          { tools: [state], out: OUT.state },
          { tools: [{ command: SHOW, result: status({ type: "show", moves: [] }) }], out: OUT.show },
          { tools: [say], out: OUT.say },
          { tools: [{ command: "npm run -s tutor -- resume", result: status({ type: "resume" }) }], out: OUT.claim },
          final(),
        ];
      }
      // The state came with the line and the moment waits 75 s: one chained call, starting with the claim, answers it.
      if (rethink) return [{ tools: [chain("claim", "rethink")], out: OUT.say }, final()];
      return [{ tools: [chain("claim", "show", "say", "resume")], out: OUT.chained }, final()];
    }
    case "HINT": {
      const mark = { command: "npm run -s tutor -- mark C3 D3", result: status({ type: "mark", points: [] }) };
      if (p === "before") return [{ tools: [state], out: OUT.state }, { tools: [mark], out: OUT.show }, { tools: [say], out: OUT.say }, final()];
      return [{ tools: [chain("mark", "say")], out: OUT.chained }, final()];
    }
    case "USER": {
      if (beat.kind === "review-answer") {
        if (p === "before") {
          return [
            { tools: [{ command: SHOW, result: status({ type: "show", moves: [] }) }], out: OUT.show },
            { tools: [say], out: OUT.say },
            { tools: [{ command: "npm run -s tutor -- tag g1 14 shape", result: status({ type: "tag", gameId: "g1", moveNumber: 14, category: "shape" }) }], out: OUT.tag },
            final(),
          ];
        }
        return [{ tools: [chain("show", "say", "tag")], out: OUT.chained }, final()];
      }
      if (beat.kind === "start-problems") return [{ tools: [chain("problem", "say")], out: OUT.chained }, final()];
      // A question about the board during the game needs the position, which the stream's moves no longer bring.
      // ("before" streamed every move, so its tutor followed the game without it.)
      if (p === "after" && beat.kind === "board-question" && !text.includes("state below")) return [{ tools: [state], out: OUT.state }, { tools: [say], out: OUT.say }, final()];
      return [{ tools: [say], out: OUT.say }, final()];
    }
    case "GAME_END": {
      const review = { command: "npm run -s tutor -- review last", result: () => w.reviewText() };
      // "before": review, the result and a question; the RATING line comes as its own notification.
      if (p === "before" || !text.includes("\n")) return [{ tools: [review], out: OUT.review }, { tools: [say], out: OUT.say }, final()];
      return [{ tools: [say], out: OUT.say }, final()];
    }
    case "RATING":
      return [{ tools: [say], out: OUT.say }, final()];
    case "PROBLEM_START":
      // "before": run state; say nothing yet.
      return p === "before" ? [{ tools: [state], out: OUT.state }, final()] : ack();
    case "PROBLEM": {
      if (text.includes(" correct")) return [{ tools: [say], out: OUT.say }, final()];
      if (text.includes("another attempt left")) return [{ tools: [say], out: OUT.say }, final()];
      if (p === "before") return [{ tools: [{ command: SHOW, result: status({ type: "show", moves: [] }) }], out: OUT.show }, { tools: [say], out: OUT.say }, final()];
      return [{ tools: [chain("show", "say")], out: OUT.chained }, final()];
    }
    case "BATCH":
      return text.includes("finished") ? [{ tools: [say], out: OUT.say }, final()] : ack();
    case "EXPIRED":
      // "before" reloaded TaskStop's schema and narrated; "after" re-arms with the documented command.
      return p === "before"
        ? [{ tools: [{ command: "Monitor(...)", result: () => "Monitor started" }], out: OUT.rearm }, { tools: [{ command: "ToolSearch(TaskStop)", result: () => "x".repeat(3000) }], out: OUT.ack.before }, final()]
        : [{ tools: [{ command: "Monitor(...)", result: () => "Monitor started" }], out: OUT.rearm }, final()];
    default:
      // GAME_START, MOVE, LEVEL, JUDGE, UNDO, FALLBACK: nothing to do.
      return ack();
  }
}

// ---------------------------------------------------------------------------
// The scripted world
// ---------------------------------------------------------------------------

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SETTINGS: GameSettings = { size: 9, komi: 7, humanColor: "B", botRank: "20k", handicap: 0 };

class World {
  now = Date.UTC(2026, 9, 18, 17, 0, 0);
  game = new GoGame(9, 7);
  level: TutorLevel = "coach";
  chat: ChatMessage[] = [];
  moment: TeachingMoment | null = null;
  result: SavedGame["result"] = null;
  summary: GameSummary | null = null;
  problem: ProblemView | null = null;
  /** The tutor's watch is attached (the bridge says so). */
  watching = false;
  private readonly random: () => number;

  constructor(seed: number) {
    this.random = rng(seed);
  }

  /** An event as the game controller emits it (the bridge stamps seq and ts); chat about the game carries the level, as the server's does. */
  event(e: Record<string, unknown> & { type: TutorEvent["type"] }): TutorEventInput {
    const level = e.type === "user_message" && !e.problemId ? { tutorLevel: this.level } : {};
    return { ...e, ...level } as unknown as TutorEventInput;
  }

  private randomPoint(): Gtp {
    return toGtp({ x: Math.floor(this.random() * 9), y: Math.floor(this.random() * 9) }, 9);
  }

  private evalOf(loss: number): MoveEval {
    const pv = () => Array.from({ length: 6 }, () => this.randomPoint());
    const best = this.randomPoint();
    return {
      leadBefore: 2,
      leadAfter: 2 - loss,
      pointLoss: loss,
      winrateBefore: 0.6,
      winrateAfter: Math.max(0.05, 0.6 - loss / 20),
      bestMove: best,
      bestPv: [best, ...pv().slice(1)],
      candidates: Array.from({ length: 5 }, (_, i) => ({ move: i === 0 ? best : this.randomPoint(), lead: 2 - i * 0.7, winrate: 0.6 - i * 0.03, visits: 400 - i * 60, pv: pv() })),
    };
  }

  /** A random legal move for the side to play, with an eval for the learner's. */
  play(loss?: number): MoveRecord {
    for (let tries = 0; tries < 200; tries++) {
      const point = { x: Math.floor(this.random() * 9), y: Math.floor(this.random() * 9) };
      if (!this.game.isLegal(point)) continue;
      const res = this.game.playAt(point);
      if (!res.ok) continue;
      if (res.record.move.color === SETTINGS.humanColor) {
        res.record.eval = this.evalOf(loss ?? Math.round(this.random() * 25) / 10);
        res.record.tutorLevel = this.level;
      }
      return res.record;
    }
    const res = this.game.pass();
    if (!res.ok) throw new Error("cannot pass");
    return res.record;
  }

  say(from: ChatMessage["from"], text: string): void {
    this.chat.push({ id: `c${this.chat.length + 1}`, ts: this.now, from, text });
  }

  view(): GameView {
    const problemMode = this.problem !== null;
    return {
      gameId: "g1",
      mode: problemMode ? "problem" : "game",
      settings: SETTINGS,
      status: this.result ? "finished" : this.moment ? "paused" : "playing",
      board: this.game.board,
      toPlay: this.game.toPlay,
      moves: problemMode ? [] : this.game.moves,
      captures: this.game.captures,
      result: this.result,
      moment: this.moment,
      overlay: null,
      chat: this.chat,
      tutorAttached: true,
      tutorLevel: this.level,
      judgeMode: "optimal",
      engineBusy: false,
      profileVersion: 0,
      allowed: [],
      mistakeThreshold: 4,
      ...(this.problem && { problem: this.problem }),
      ...(this.summary && { summary: this.summary }),
    };
  }

  saved(): SavedGame {
    return { id: "g1", settings: SETTINGS, createdAt: this.now, updatedAt: this.now, moves: this.game.moves, result: this.result, summary: this.summary, chat: this.chat, tags: {} };
  }

  reviewText(): string {
    return reviewOf(this.saved());
  }
}

/** `review` as the tutor reads it, at the game's 9×9 threshold. */
const reviewOf = (g: SavedGame): string => formatReview(g, 4);

/** A scripted step: the clock moves on, the world changes, and maybe an event goes out. */
interface Step {
  /** Seconds since the previous step. */
  after: number;
  run: (w: World) => TutorEventInput | null;
  beat?: Beat;
}

/** The session for one tutor level: a 9×9 game of 80 moves, the review of two mistakes, three problems. */
function script(level: TutorLevel): Step[] {
  const steps: Step[] = [];
  const at = (after: number, run: Step["run"], beat?: Beat) => steps.push({ after, run, ...(beat && { beat }) });
  const moments = level === "silent" ? [] : [6, 11, 17, 22, 28, 33];
  const rethinks = level === "coach" ? new Set([6, 17, 28]) : new Set<number>();
  const mistakes = new Set([6, 11, 17, 22, 28, 33]);

  at(0, (w) => w.event({ type: "game_start", gameId: "g1", settings: SETTINGS, tutorLevel: "coach", judgeMode: "optimal" }));
  if (level !== "coach") {
    at(20, (w) => {
      w.level = level;
      return w.event({ type: "tutor_level", level, gameId: "g1" });
    });
  }
  const humanMove = (n: number) => {
    const big = mistakes.has(n);
    at(25, (w) => {
      const r = w.play(big ? 8 : undefined);
      return w.event({ type: "move", gameId: "g1", size: 9, record: r, by: "human" });
    });
    if (moments.includes(n)) {
      at(2, (w) => {
        const r = w.game.moves.at(-1)!;
        // The server's soft claim: a moment going straight to the tutor's watch waits 75 s.
        w.moment = { id: `m${n}`, moveNumber: r.number, pointLoss: 8, state: "waiting", deadline: w.now + (w.watching ? 75_000 : 30_000), level };
        return w.event({ type: "teaching_moment", gameId: "g1", size: 9, moment: w.moment, record: r, boardBefore: "", boardAfter: "", tutorLevel: level });
      }, { kind: "moment", action: rethinks.has(n) ? "rethink" : "show" });
      if (rethinks.has(n)) {
        // The tutor took the move back; the learner plays again (a small loss this time).
        at(1, (w) => {
          w.game.undo(1);
          return w.event({ type: "undo", gameId: "g1", moves: w.game.moves.length, toPlay: "B", by: "tutor", during: "moment" });
        });
        at(30, (w) => {
          w.moment = null;
          const r = w.play(1);
          return w.event({ type: "move", gameId: "g1", size: 9, record: r, by: "human" });
        });
      } else {
        // The learner looked at the drawing and pressed Continue.
        at(40, (w) => {
          w.moment = null;
          return null;
        });
      }
    }
    at(2, (w) => w.event({ type: "move", gameId: "g1", size: 9, record: w.play(), by: "bot" }));
  };

  for (let n = 1; n <= 40; n++) {
    if (n === 9 || n === 25) {
      at(15, (w) => {
        w.say("user", "Why did the bot play there? Is my group in danger?");
        return w.event({ type: "user_message", text: "Why did the bot play there? Is my group in danger?", gameId: "g1" });
      }, { kind: "board-question" });
    }
    if (n === 14) {
      at(15, (w) => w.event({ type: "hint_request", gameId: "g1", size: 9, board: toAscii(w.game.board, movePoint(w.game.moves.at(-1)?.move)), toPlay: "B", text: "where should I play?" }));
    }
    if (n === 20) at(5, (w) => w.event({ type: "generation", status: "started", batch: batch("started") }));
    if (n === 31) {
      // Take back: the learner's move and the bot's reply.
      at(5, (w) => {
        w.game.undo(2);
        return w.event({ type: "undo", gameId: "g1", moves: w.game.moves.length, toPlay: "B", by: "human" });
      });
    }
    humanMove(n);
  }

  // Both pass; the rank estimate lands a few seconds after the game ends.
  at(20, (w) => {
    w.result = { winner: "B", margin: 6.5, reason: "score" };
    w.summary = summaryOf(w, true);
    return w.event({ type: "game_end", gameId: "g1", result: w.result, summary: w.summary });
  });
  at(4, (w) => {
    w.summary = summaryOf(w, false);
    return w.event({ type: "rating", gameId: "g1", rating: w.summary.rating! });
  });

  // The review: the learner answers the tutor's question about each of two mistakes.
  at(60, (w) => w.event({ type: "user_message", text: "I wanted to cut there, I thought it was big.", gameId: "g1" }), { kind: "review-answer", last: false });
  at(60, (w) => w.event({ type: "user_message", text: "I didn't see that my group was short of liberties.", gameId: "g1" }), { kind: "review-answer", last: true });
  at(30, (w) => w.event({ type: "user_message", text: "Sure, let's do some problems.", gameId: "g1" }), { kind: "start-problems" });

  // Three problems: solved first try; solved on the second attempt after a nudge; missed twice.
  const problem = (id: string, attempts: ("right" | "wrong")[]) => {
    at(10, (w) => {
      w.problem = problemView(id);
      return w.event({ type: "problem_start", problemId: id, kind: "game", category: "life_and_death", toPlay: "B", prompt: w.problem.prompt, answers: ["E1", "D1"], box: 1, source: { gameId: "g1", moveNumber: 14 }, size: 9, board: toAscii(w.game.board) });
    });
    attempts.forEach((a, i) => {
      at(40, (w) => {
        const revealed = a === "right" || i === 1;
        return w.event({ type: "problem_attempt", problemId: id, move: a === "right" ? "E1" : "C2", correct: a === "right", category: "life_and_death", attempt: i + 1, firstTry: a === "right" && i === 0, pointLoss: a === "right" ? null : 9, revealed, bestMove: "E1", bestPv: ["E1", "F2", "D2", "F1"] });
      });
      if (a === "wrong" && i === 0) at(30, (w) => w.event({ type: "user_message", text: "I thought C2 makes an eye?", gameId: "g1", problemId: id }), { kind: "problem-reply" });
    });
  };
  problem("p1", ["right"]);
  at(5, (w) => w.event({ type: "generation", status: "finished", batch: batch("finished") }));
  problem("p2", ["wrong", "right"]);
  problem("p3", ["wrong", "wrong"]);
  at(30, (w) => w.event({ type: "user_message", text: "Thanks, that's enough for today.", gameId: "g1" }), { kind: "user-question" });
  return steps;
}

function batch(status: "started" | "finished") {
  return { id: "batch2", trigger: "mastery", target: 20, weakerRank: "17k", strongerRank: "12k", band: "17k–13k", found: status === "finished" ? 20 : 0, sizes: [{ size: 9, found: 7 }, { size: 13, found: 7 }, { size: 19, found: 6 }], status };
}

function summaryOf(w: World, pending: boolean): GameSummary {
  const human = w.game.moves.filter((r) => r.move.color === "B" && r.eval);
  const mistakes = human
    .filter((r) => r.eval!.pointLoss >= 4)
    .sort((a, b) => b.eval!.pointLoss - a.eval!.pointLoss)
    .map((r) => ({ moveNumber: r.number, move: toGtp((r.move as { point: { x: number; y: number } }).point, 9), pointLoss: r.eval!.pointLoss, bestMove: r.eval!.bestMove, category: "shape" as const, categorySource: "heuristic" as const }));
  return {
    moves: w.game.moves.length,
    threshold: 4,
    mistakes,
    totalPointLoss: human.reduce((s, r) => s + r.eval!.pointLoss, 0),
    assistance: { hints: 1, shown: 0, rethinks: 0, takeBacks: 1 } as unknown as GameSummary["assistance"],
    rating: { before: 10, after: pending ? 10 : 11.5, rated: true, ...(pending && { pending: true }), nextBotRank: "19k", nextHandicap: 0 },
  };
}

function problemView(id: string): ProblemView {
  return { id, prompt: "Black to play. Make this group live.", source: { gameId: "g1", moveNumber: 14 }, attempts: 0, solved: false, kind: "game", category: "life_and_death", toPlay: "B", maxAttempts: 2, revealed: false, box: 1, recentMoves: RECENT_SIM };
}

/** The last moves before a problem's position, which the state lists on one line. */
const RECENT_SIM = (["C2", "B3", "D2", "C3", "E2"] as const).map((gtp, i) => ({ color: (i % 2 === 0 ? "W" : "B") as Color, point: fromGtp(gtp, 9)!, ago: 5 - i }));

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * The session's start: setup, the browser, the watch, summary, the plan, new-game. "before" is the
 * transcript's (one call per step, six Chrome tool schemas); "after" makes the independent calls
 * together and loads three Chrome schemas (~2.1k fewer tokens in every later call).
 */
const SETUP_AFTER: { add: number; out: number }[] = [
  { add: 0, out: 200 },
  { add: 1500, out: 300 },
  { add: 5200, out: 250 },
  { add: 1950, out: 300 },
  { add: 1300, out: 330 },
  { add: 500, out: 200 },
];
const SETUP_BEFORE: { add: number; out: number }[] = [
  { add: 0, out: 170 },
  { add: 400, out: 160 },
  { add: 1100, out: 320 },
  { add: 7300, out: 300 },
  { add: 450, out: 370 },
  { add: 700, out: 300 },
  { add: 600, out: 300 },
  { add: 1500, out: 250 },
  { add: 300, out: 216 },
  { add: 200, out: 330 },
];

export interface Cost {
  calls: number;
  notifications: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  dollars: number;
  /** Dollars by the kind of notification that caused the calls. */
  byKind: Record<string, number>;
}

class Meter {
  context = CALIBRATION.baseContext;
  /** Tokens added since the last call (a notification, tool results, the last reply). */
  pending = 0;
  cost: Cost = { calls: 0, notifications: 0, cacheRead: 0, cacheWrite: 0, output: 0, dollars: 0, byKind: {} };

  call(out: number, kind: string): void {
    const read = this.context;
    const write = this.pending;
    const dollars = (read * PRICES.cacheRead + write * PRICES.cacheWrite + out * PRICES.output) / 1e6;
    this.cost.calls++;
    this.cost.cacheRead += read;
    this.cost.cacheWrite += write;
    this.cost.output += out;
    this.cost.dollars += dollars;
    this.cost.byKind[kind] = (this.cost.byKind[kind] ?? 0) + dollars;
    this.context += write;
    this.pending = out;
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Simulates one session on `level` under `protocol`. */
export async function simulate(protocol: Protocol, level: TutorLevel, seed = 7): Promise<Cost> {
  const w = new World(seed);
  const meter = new Meter();
  for (const s of protocol === "before" ? SETUP_BEFORE : SETUP_AFTER) {
    meter.pending += s.add;
    meter.call(s.out, "setup");
  }

  // Timers the bridge sets (the rating hold) run on the simulated clock.
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let timerId = 0;
  const setTimer = (fn: () => void, ms: number) => {
    timers.push({ at: w.now + ms, fn, id: ++timerId });
    return timerId;
  };
  const clearTimer = (id: unknown) => {
    timers = timers.filter((t) => t.id !== id);
  };

  // The real bridge behind a small HTTP server; the game controller and the store are the world.
  const log: TutorEvent[] = [];
  let emit: (e: TutorEventInput) => void = () => {};
  const controller = {
    onEvent: (fn: (e: TutorEventInput) => void) => (emit = fn),
    onChange: () => {},
    view: () => w.view(),
    gameMoment: () => w.moment,
    setTutorAttached: () => {},
    setTutorWatching: (on: boolean) => (w.watching = on),
    // The server's soft claim: a waiting moment delivered to the tutor's watch waits 75 s.
    extendMoment: (id: string) => {
      if (w.moment?.id === id && w.moment.state === "waiting") w.moment.deadline = Math.max(w.moment.deadline ?? 0, w.now + 30_000);
    },
  } as unknown as GameController;
  const store = {
    lastEventSeq: () => 0,
    appendEvent: (e: TutorEvent) => log.push(e),
    readEvents: (since = -Infinity) => log.filter((e) => e.seq > since),
    findEvent: (type: TutorEvent["type"], matches: (e: TutorEvent) => boolean) => [...log].reverse().find((e) => e.type === type && matches(e)) ?? null,
  } as unknown as Store;
  // The old server sent every event at once.
  const bridge = new TutorBridge(controller, store, { now: () => w.now, setTimer, clearTimer, log: () => {}, ...(protocol === "before" && { ratingHoldMs: 0 }) });
  let inFlight = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://sim");
    if (url.pathname === "/api/tutor/events") {
      const since = url.searchParams.get("since");
      return bridge.openTutorStream(req, res, since === null ? undefined : Number(since), url.searchParams.get("epoch") ?? undefined, url.searchParams.get("rejoin") === "1");
    }
    inFlight++;
    res.on("close", () => inFlight--);
    const body = url.pathname === "/api/state" ? w.view() : url.pathname.startsWith("/api/game/") ? w.saved() : null;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(body ? JSON.stringify(body) : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let printed: string[] = [];
  const start = () => {
    const abort = new AbortController();
    const done = watch({ client: new Client(base), all: protocol === "before", json: false, out: (text) => printed.push(text), err: () => {}, signal: abort.signal, sleep: async () => {}, now: () => w.now });
    return { abort, done };
  };
  /** Lets the event reach watch, and watch finish its fetches and print. */
  const settle = async () => {
    for (let quiet = 0, i = 0; quiet < 4 && i < 500; i++) {
      const before = printed.length;
      await new Promise((resolve) => setTimeout(resolve, 2));
      quiet = inFlight === 0 && printed.length === before ? quiet + 1 : 0;
    }
  };

  const notify = async (text: string, beat: Beat) => {
    const kind = headOf(text);
    meter.cost.notifications++;
    meter.pending += CALIBRATION.notificationOverhead + tokens(text);
    for (const call of respond(protocol, text, beat, w)) {
      // The call's output (its tool commands included) joins the context with the next call; then the results.
      meter.call(call.out, kind);
      for (const tool of call.tools) meter.pending += CALIBRATION.toolCallOverhead + tokens(tool.result());
    }
  };
  /** Everything printed since the last flush arrives within Monitor's 200 ms batching: one notification. */
  const flush = async (beat: Beat) => {
    const out = printed;
    printed = [];
    if (out.length > 0) await notify(out.join("\n"), beat);
  };

  let current = start();
  await settle();
  let lastExpiry = w.now;
  try {
    for (const step of script(level)) {
      const target = w.now + step.after * 1000;
      // Timers due before the step fire at their own time, each a notification of its own.
      const nextDue = () => timers.filter((t) => t.at <= target).sort((x, y) => x.at - y.at)[0];
      for (let due = nextDue(); due; due = nextDue()) {
        clearTimer(due.id);
        w.now = due.at;
        due.fn();
        await settle();
        await flush({ kind: "none" });
      }
      w.now = target;
      // A Monitor lives at most 30 minutes: the watch is killed, the tutor gets the notice and starts a new one.
      if (w.now - lastExpiry >= 30 * 60_000) {
        lastExpiry = w.now;
        current.abort.abort();
        await current.done;
        await settle();
        await notify("EXPIRED [Monitor expired after 30m]", { kind: "none" });
        current = start();
        await settle();
        await flush({ kind: "none" });
      }
      const event = step.run(w);
      if (!event) continue;
      emit(event);
      await settle();
      await flush(step.beat ?? { kind: "none" });
    }
  } finally {
    current.abort.abort();
    await current.done;
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
  }
  return meter.cost;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const LEVELS: TutorLevel[] = ["silent", "point_out", "coach"];

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

async function main(): Promise<void> {
  const rows: string[] = [];
  rows.push("Simulated tutoring session (setup, one 9x9 game of 80 moves, review of 2 mistakes, 3 problems), Claude Opus 5.5 prices");
  rows.push("");
  rows.push("level      protocol  notifications  calls  cache read  cache write  output   cost");
  for (const level of LEVELS) {
    for (const protocol of ["before", "after"] as const) {
      const c = await simulate(protocol, level);
      rows.push(
        `${level.padEnd(10)} ${protocol.padEnd(9)} ${String(c.notifications).padStart(13)} ${String(c.calls).padStart(6)} ${String(c.cacheRead).padStart(11)} ${String(c.cacheWrite).padStart(12)} ${String(c.output).padStart(7)} ${money(c.dollars).padStart(6)}`,
      );
      if (process.argv.includes("--breakdown")) {
        const kinds = Object.entries(c.byKind).sort((a, b) => b[1] - a[1]);
        rows.push(`           ${kinds.map(([k, d]) => `${k} ${money(d)}`).join(", ")}`);
      }
    }
  }
  console.log(rows.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
