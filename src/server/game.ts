// GameController: the current game, turns, bot replies, per-move evals, teaching moments with the
// tutor wait and KataGo fallback, the chat log, and the GameView / TutorEvents the rest of the
// server publishes. It knows nothing about HTTP or KataGo's process; the engine is injected.
//
// Every async engine call captures `gen` (bumped by new game, undo and game end) and the move
// count; a reply that no longer matches is dropped, so late answers never touch a newer state.

import { randomBytes } from "node:crypto";
import { GoGame, emptyBoard, scoreArea, deadStonesFromOwnership, toAscii, writeSgf, type IllegalReason } from "../engine/index.ts";
import { toGtp, tryFromGtp } from "../shared/coords.ts";
import { normalizeBotRank } from "../shared/rank.ts";
import type {
  Board,
  ChatMessage,
  ClientAction,
  Color,
  GameResult,
  GameSettings,
  GameStatus,
  GameSummary,
  GameView,
  Gtp,
  MistakeCategory,
  Move,
  MoveRecord,
  Overlay,
  Point,
  ProblemAttempt,
  Profile,
  TeachingMoment,
  TutorCommand,
  TutorEvent,
} from "../shared/types.ts";
import { TRUSTED_CANDIDATE_VISITS, moveEvalFrom, type Analysis, type AnalyzeOptions, type Engine, type Position } from "./katago.ts";
import {
  ANSWER_MARGIN,
  DEEP_VISITS,
  MAX_ATTEMPTS,
  addProblems,
  candidatesFromAnalysis,
  candidatesThin,
  nextProblemId,
  pickNextProblem,
  problemFromMistake,
  problemGame,
  problemPosition,
  promptFor,
  resultOf,
  schedule,
  stonesOf,
  type MistakeSnapshot,
  type StoredProblem,
} from "./problems.ts";
import { applyGame, applyProblemResult, applyTag, classifyMistake, recommendFocus } from "./profile.ts";
import type { SavedGame, Store } from "./store.ts";

/** An error whose message is meant for the person (or tutor) who sent the request. */
export class UserError extends Error {}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A TutorEvent before the bridge stamps `seq` and `ts`. */
export type TutorEventInput = DistributiveOmit<TutorEvent, "seq" | "ts">;

export type GameEngine = Pick<Engine, "analyze" | "botMove"> & Partial<Pick<Engine, "concurrency">>;
export type EngineState = "starting" | "ready" | "failed";

export interface ControllerOptions {
  engine: GameEngine;
  store: Store;
  clock?: Clock;
  /** How long a teaching moment waits for an attached tutor before the KataGo fallback. Default 30 s. */
  tutorTimeoutMs?: number;
  /** Minimum time before the bot answers, so replies don't feel instant. Default 500 ms. */
  botDelayMs?: number;
  /** Retry delay after a failed bot move. Default 2 s. */
  botRetryMs?: number;
  /** Visits for move evaluation; default is the config's maxVisits. */
  analysisVisits?: number;
  /** Visits for checking a practice-problem attempt. Default 600. */
  problemVisits?: number;
  log?: (msg: string) => void;
}

/** The practice problem on the board in problem mode. The game, if any, waits underneath. */
interface Practice {
  problem: StoredProblem;
  /** The rules engine at the problem position (it never changes; attempts are checked on copies). */
  game: GoGame;
  /** The problem's box when it started. */
  box: number;
  attempts: number;
  solved: boolean;
  /** Solved or out of attempts: the answer is shown and the board is locked. */
  revealed: boolean;
  /** An attempt is with KataGo. */
  checking: boolean;
  lastAttempt?: ProblemAttempt;
  answer?: { move: Gtp; pv: Gtp[] };
  overlay: Overlay | null;
  /** Analyses of the problem position (key "") and after each attempt (key = the move). */
  analyses: Map<string, Promise<Analysis>>;
}

export const DEFAULT_SETTINGS: Omit<GameSettings, "botRank"> = { size: 9, komi: 7, humanColor: "B", handicap: 0 };
const CHAT_LIMIT = 200;
const VIEW_CHAT_LIMIT = 100;
const FALLBACK_PV_LENGTH = 6;
const BOT_RETRIES = 3;
const DEFAULT_PROBLEM_VISITS = 600;
/** Moves of the follow-up drawn after a correct answer: the answer, the opponent's best reply, the next move. */
const ANSWER_LINE_LENGTH = 3;
/** Komi when the profile gives the learner handicap stones. */
const HANDICAP_KOMI = 0.5;

const ILLEGAL_TEXT: Record<IllegalReason, string> = {
  occupied: "That point is already taken.",
  suicide: "That move would leave your stones without liberties (suicide is not allowed).",
  ko: "That move would repeat an earlier position (ko). Play elsewhere first.",
  not_your_turn: "It's not your turn.",
  game_over: "The game is over.",
  off_board: "That point is off the board.",
};

const other = (c: Color): Color => (c === "B" ? "W" : "B");
const round1 = (n: number) => Math.round(n * 10) / 10;

function moveGtp(move: Move, size: number): Gtp {
  return "pass" in move ? "pass" : toGtp(move.point, size);
}

/** KataGo searched `move` well enough in `analysis` to judge it within that one search. */
function searchedWell(analysis: Analysis, move: Gtp): boolean {
  return analysis.moveInfos.some((m) => m.move === move && m.visits >= TRUSTED_CANDIDATE_VISITS);
}

/** Some empty point is illegal only because of ko (superko): the position depends on its history. */
function hasKoBan(game: GoGame): boolean {
  return game.board.some((row, y) => row.some((cell, x) => cell === null && game.illegalReason({ x, y }) === "ko"));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function formatScore(result: GameResult, humanColor?: Color): string {
  const who = (c: Color) => (c === "B" ? "Black" : "White") + (humanColor ? (c === humanColor ? " (you)" : " (bot)") : "");
  if (result.reason === "abandon") return "game abandoned";
  if (!result.winner) return "a draw";
  if (result.reason === "resign") return `${who(result.winner)} wins by resignation`;
  return `${who(result.winner)} wins by ${Math.abs(result.margin)} points`;
}

/** Points a pass may cost the bot, in KataGo's judgment, for it to answer a pass with a pass. */
export const PASS_TOLERANCE = 1.5;

/** After the opponent passed: is passing (ending the game) about as good as KataGo's best move? */
export function passIsFine(analysis: Analysis): boolean {
  const best = analysis.moveInfos[0];
  if (!best || best.move === "pass") return true;
  const pass = analysis.moveInfos.find((m) => m.move === "pass");
  return !!pass && pass.scoreLead >= best.scoreLead - PASS_TOLERANCE;
}

export class GameController {
  private readonly engine: GameEngine;
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly tutorTimeoutMs: number;
  private readonly botDelayMs: number;
  private readonly botRetryMs: number;
  private readonly analysisVisits: number | undefined;
  private readonly problemVisits: number;
  private readonly log: (msg: string) => void;

  private readonly eventListeners: ((e: TutorEventInput) => void)[] = [];
  private readonly changeListeners: (() => void)[] = [];

  private profile: Profile;
  private game: GoGame | null = null;
  private gameId: string | null = null;
  private settings: GameSettings | null = null;
  private createdAt = 0;
  private status: GameStatus = "playing";
  private result: GameResult | null = null;
  private summary: GameSummary | null = null;
  private moment: TeachingMoment | null = null;
  private overlay: Overlay | null = null;
  private chat: ChatMessage[] = [];
  private tags: SavedGame["tags"] = {};
  /** Heuristic mistake categories by move number, from the eval of each mistake (refined with ownership). */
  private heuristics: Record<number, MistakeCategory> = {};
  private tutorAttached = false;
  private engineState: EngineState = "starting";
  /** Problem mode: the problem on the board. */
  private practice: Practice | null = null;
  /** The problem shown last, so Next problem moves on to a different one. */
  private lastProblemId: string | undefined;

  /** Bumped whenever a pending engine reply could become stale. */
  private gen = 0;
  /** Engine calls the human is waiting on (move eval, bot move, scoring, hint). */
  private busy = 0;
  /** `gen` for which a bot move is in flight, if any. */
  private botFor: number | null = null;
  private botFailures = 0;
  /** The human move whose evaluation is in flight. The bot waits for it, so a moment can't be skipped. */
  private evaluating: MoveRecord | null = null;
  private momentTimer: unknown = null;
  /** A mistake evaluated while the learner was on a practice problem: its moment opens on Back to playing. */
  private deferredMoment: MoveRecord | null = null;
  /** The fallback came due while the learner was on a practice problem: it is applied on Back to playing. */
  private fallbackDeferred = false;
  /** Analyses by position (moves as a GTP list), and whether they include ownership. */
  private readonly analyses = new Map<string, { pending: Promise<Analysis>; ownership: boolean }>();
  private nextChatId = 1;
  /** A save is scheduled for the end of this tick. */
  private saveQueued = false;

  constructor(opts: ControllerOptions) {
    this.engine = opts.engine;
    this.store = opts.store;
    this.clock = opts.clock ?? systemClock;
    this.tutorTimeoutMs = opts.tutorTimeoutMs ?? 30_000;
    this.botDelayMs = opts.botDelayMs ?? 500;
    this.botRetryMs = opts.botRetryMs ?? 2000;
    this.analysisVisits = opts.analysisVisits;
    this.problemVisits = opts.problemVisits ?? DEFAULT_PROBLEM_VISITS;
    this.log = opts.log ?? (() => {});
    this.profile = this.store.loadProfile();
  }

  onEvent(fn: (e: TutorEventInput) => void): void {
    this.eventListeners.push(fn);
  }

  onChange(fn: () => void): void {
    this.changeListeners.push(fn);
  }

  // --- view ------------------------------------------------------------------

  view(): GameView {
    if (this.practice) return this.problemView(this.practice);
    const game = this.game;
    return {
      gameId: this.gameId,
      mode: game ? "game" : "idle",
      settings: this.settings,
      status: this.status,
      board: game ? game.board : emptyBoard(DEFAULT_SETTINGS.size),
      toPlay: game ? game.toPlay : "B",
      moves: game ? game.moves : [],
      captures: game ? game.captures : { B: 0, W: 0 },
      result: this.result,
      moment: this.moment ? { ...this.moment } : null,
      overlay: this.overlay,
      chat: this.chat.slice(-VIEW_CHAT_LIMIT),
      tutorAttached: this.tutorAttached,
      engineBusy: this.engineState !== "ready" || this.busy > 0,
      problem: null,
    };
  }

  /** The game's teaching moment, also while a practice problem is on the board (whose view shows none). */
  gameMoment(): TeachingMoment | null {
    return this.moment ? { ...this.moment } : null;
  }

  get currentProfile(): Profile {
    return this.profile;
  }

  // --- wiring from the bridge / index ------------------------------------------

  setTutorAttached(attached: boolean): void {
    if (attached === this.tutorAttached) return;
    this.tutorAttached = attached;
    // Nobody is left to answer a waiting moment.
    if (!attached && this.moment?.state === "waiting") this.applyFallback();
    // A tutor is back while the fallback waits under a practice problem: the moment is theirs to
    // answer again, with a fresh wait, instead of KataGo's answer on Back to playing.
    else if (attached && this.fallbackDeferred && this.moment?.state === "waiting") this.waitForTutor();
    this.changed();
  }

  setEngineState(state: EngineState, message?: string): void {
    this.engineState = state;
    if (message) this.system(message);
    if (state === "ready") {
      this.botFailures = 0;
      this.resumeTurn();
    }
    this.changed();
  }

  /**
   * After a restore or an engine (re)start, finish what the last move still needs: score a game
   * that ended, evaluate a human move that never got its eval, or let the bot reply.
   */
  private resumeTurn(): void {
    const { game, settings } = this;
    if (!game || !settings || this.result || this.engineState !== "ready") return;
    if (game.isOver) {
      void this.finishByScore();
      return;
    }
    if (this.status !== "playing") return;
    const last = game.lastMove;
    if (last && last.move.color === settings.humanColor && !last.eval && !this.evaluating) {
      void this.evaluateHumanMove(last);
      return;
    }
    void this.prefetch();
    this.maybeBotMove();
  }

  /** Picks up the newest unfinished saved game, e.g. after a server restart. */
  restoreLastGame(): boolean {
    const saved = this.store.lastGame();
    if (!saved || saved.result) return false;
    let game: GoGame;
    try {
      game = GoGame.fromMoves(saved.settings.size, saved.settings.komi, saved.settings.handicap, saved.moves.map((r) => r.move));
    } catch (err) {
      this.log(`could not restore game ${saved.id}: ${(err as Error).message}`);
      return false;
    }
    game.moves.forEach((record, i) => {
      const evaluation = saved.moves[i]?.eval;
      if (evaluation) record.eval = evaluation;
    });
    this.resetGameState();
    this.game = game;
    this.gameId = saved.id;
    this.settings = saved.settings;
    this.createdAt = saved.createdAt;
    this.tags = saved.tags ?? {};
    this.heuristics = saved.heuristics ?? {};
    this.chat = saved.chat ?? [];
    const maxChatId = Math.max(0, ...this.chat.map((m) => Number(/^c(\d+)$/.exec(m.id)?.[1] ?? 0)));
    this.nextChatId = Math.max(this.nextChatId, maxChatId + 1);
    this.system(`Picked up where you left off: game ${saved.id}, move ${game.moves.length}.`);

    // A mistake the learner hadn't dealt with yet: open its teaching moment again.
    const last = game.lastMove;
    const evaluation = last?.eval;
    const dismissed = saved.moment?.moveNumber === last?.number && saved.moment?.state === "resolved";
    if (last && evaluation && last.move.color === saved.settings.humanColor && !game.isOver && !dismissed && evaluation.pointLoss >= this.profile.mistakeThreshold) {
      this.startMoment(last);
    } else {
      this.resumeTurn();
    }
    this.changed();
    return true;
  }

  // --- browser actions -------------------------------------------------------

  async handleAction(action: ClientAction): Promise<void> {
    // In problem mode the game waits underneath: only a stone on the board counts as an answer.
    const practicing = !!this.practice;
    switch (action.type) {
      case "new_game":
        return this.newGame(action.settings);
      case "play":
        return practicing ? this.problemPlay(action.point) : this.play(action.point);
      case "pass":
        if (practicing) throw new UserError("In a problem, answer by playing a stone on the board.");
        return this.play(null);
      case "resign":
        if (practicing) throw new UserError("You're on a practice problem. Press Back to playing to return to your game first.");
        return this.resign();
      case "continue":
        if (practicing) return; // Enter on the problem screen: nothing to continue
        return this.continueGame();
      case "retry":
        if (practicing) throw new UserError("Try again is for games. In a problem, just play another move while you have attempts left.");
        return this.retry(null);
      case "chat":
        return this.userChat(action.text);
      case "ask_tutor":
        if (practicing) throw new UserError("Hints are for games. In a problem, ask your tutor in the chat.");
        return this.hint(action.text);
      case "next_problem":
        return this.startProblem();
      case "leave_problem":
        return this.leaveProblem();
    }
  }

  // --- tutor commands -----------------------------------------------------------

  async handleTutor(cmd: TutorCommand): Promise<void> {
    const practice = this.practice;
    switch (cmd.type) {
      case "say":
        if (practice) {
          this.addChat("tutor", cmd.text, cmd.momentId);
          return this.changed();
        }
        this.engage(cmd.momentId);
        this.addChat("tutor", cmd.text, cmd.momentId ?? this.activeMomentId());
        return this.changed();
      case "rethink": {
        if (practice) throw new UserError("The learner is on a practice problem; rethink is for games. Use say, show or mark.");
        const moment = this.rethinkMoment(cmd.momentId);
        this.engage(moment.id);
        this.retry(cmd.text, moment.id);
        return;
      }
      // Validate the drawing before engaging, so a typo doesn't cancel the fallback.
      case "show": {
        if (practice) {
          practice.overlay = { ...practice.overlay, variation: this.problemVariation(practice, cmd.moves, cmd.start, cmd.label) };
          return this.changed();
        }
        const variation = this.variationFrom(cmd.moves, cmd.start, cmd.label);
        this.engage();
        this.overlay = { ...this.overlay, variation };
        return this.changed();
      }
      case "mark": {
        if (practice) {
          const marks = this.markPoints(cmd.points, practice.problem.size, cmd.kind ?? "circle", cmd.text);
          practice.overlay = { ...practice.overlay, marks: [...(practice.overlay?.marks ?? []), ...marks] };
          return this.changed();
        }
        const marks = this.marksFrom(cmd.points, cmd.kind ?? "circle", cmd.text);
        this.engage();
        this.overlay = { ...this.overlay, marks: [...(this.overlay?.marks ?? []), ...marks] };
        return this.changed();
      }
      case "clear":
        if (practice) practice.overlay = null;
        else this.overlay = null;
        return this.changed();
      case "resume":
        if (practice) return; // the game stays paused underneath until the learner goes back to it
        return this.continueGame();
      case "claim":
        return this.claim(cmd.momentId);
      case "new_game":
        return this.newGame(cmd.settings);
      case "start_problem":
        return this.startProblem(cmd.problemId);
      case "tag":
        return this.tag(cmd.gameId, cmd.moveNumber, cmd.category, cmd.note);
    }
  }

  // --- game lifecycle ----------------------------------------------------------

  newGame(partial: Partial<GameSettings> = {}): void {
    const { settings, fromProfile } = this.validateSettings(partial);
    this.closePractice(); // a new game ends problem mode
    if (this.game && !this.result && this.gameId) {
      // Leaving an unfinished game: keep its record, but it doesn't count.
      this.result = { winner: null, margin: 0, reason: "abandon" };
      this.save();
    }
    this.flush(); // the old game's last changes belong in its own file
    this.resetGameState();
    const now = this.clock.now();
    this.gameId = this.newGameId(now);
    this.settings = settings;
    this.createdAt = now;
    this.game = new GoGame(settings.size, settings.komi, settings.handicap);
    this.emit({ type: "game_start", gameId: this.gameId, settings });
    const handicap = settings.handicap >= 2 ? `, ${settings.handicap} handicap stones` : "";
    const why =
      settings.handicap >= 2 && fromProfile
        ? ` The handicap stands in for a bot weaker than ${settings.botRank}, the weakest one KataGo has; it goes away as your rating rises.`
        : "";
    this.system(
      `New game: ${settings.size}×${settings.size}, you play ${settings.humanColor === "B" ? "Black" : "White"} against a ${settings.botRank} bot (komi ${settings.komi}${handicap}).${why}`,
    );
    this.save();
    if (this.engineState === "ready") void this.prefetch();
    this.maybeBotMove();
    this.changed();
  }

  private resetGameState(): void {
    this.gen++;
    this.cancelMomentTimer();
    this.analyses.clear();
    this.game = null;
    this.result = null;
    this.summary = null;
    this.moment = null;
    this.overlay = null;
    this.tags = {};
    this.heuristics = {};
    this.status = "playing";
    this.botFailures = 0;
    this.evaluating = null;
    this.deferredMoment = null;
    this.fallbackDeferred = false;
  }

  /** A new game's settings, and whether its handicap came from the profile (the learner is below the weakest bot). */
  private validateSettings(partial: Partial<GameSettings>): { settings: GameSettings; fromProfile: boolean } {
    const size = partial.size ?? DEFAULT_SETTINGS.size;
    if (size !== 9 && size !== 13 && size !== 19) throw new UserError(`Board size must be 9, 13 or 19 (got ${String(size)}).`);
    const komi = partial.komi ?? DEFAULT_SETTINGS.komi;
    if (typeof komi !== "number" || !Number.isInteger(komi * 2) || Math.abs(komi) > 150) {
      throw new UserError("Komi must be a whole or half number, e.g. 7 or 6.5.");
    }
    const humanColor = partial.humanColor ?? DEFAULT_SETTINGS.humanColor;
    if (humanColor !== "B" && humanColor !== "W") throw new UserError('Color must be "B" or "W".');
    // Below the weakest bot the profile gives the learner (Black, 9×9) handicap stones, unless the
    // game asks for its own bot rank or handicap.
    const profileHandicap = this.profile.handicap ?? 0;
    const fromProfile =
      profileHandicap >= 2 && partial.handicap === undefined && partial.botRank === undefined && size === 9 && humanColor === "B";
    const handicap = partial.handicap ?? (fromProfile ? profileHandicap : DEFAULT_SETTINGS.handicap);
    if (!Number.isInteger(handicap) || handicap < 0 || handicap > 9 || handicap === 1) {
      throw new UserError("Handicap must be 0 or 2–9 stones.");
    }
    let botRank: string;
    try {
      botRank = normalizeBotRank(partial.botRank ?? this.profile.botRank);
    } catch (err) {
      throw new UserError((err as Error).message);
    }
    // Handicap stones replace komi (White keeps half a point so there are no draws).
    const finalKomi = fromProfile && partial.komi === undefined ? HANDICAP_KOMI : komi;
    return { settings: { size, komi: finalKomi, humanColor, botRank, handicap }, fromProfile };
  }

  private newGameId(now: number): string {
    const d = new Date(now);
    const pad = (n: number) => String(n).padStart(2, "0");
    const base = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    let id = base;
    for (let n = 2; this.store.gameExists(id) || id === this.gameId; n++) id = `${base}-${n}`;
    return id;
  }

  // --- human moves -------------------------------------------------------------

  /** `point` null is a pass. */
  play(point: Point | null): void {
    const { game, settings } = this.requireGame();
    if (this.result) throw new UserError(ILLEGAL_TEXT.game_over);
    if (this.status === "paused") throw new UserError("The game is paused for a teaching moment: press Continue or Try again.");
    if (game.toPlay !== settings.humanColor) throw new UserError("Wait for the bot to move.");
    if (this.engineState !== "ready") throw new UserError(this.engineNotReadyText());

    const result = point ? game.playAt(point) : game.pass();
    if (!result.ok) throw new UserError(ILLEGAL_TEXT[result.reason]);
    const record = result.record;

    // Playing again after a rethink ends that moment; any leftover overlay is about the old position.
    if (this.moment) this.moment = { ...this.moment, state: "resolved" };
    this.cancelMomentTimer();
    this.overlay = null;
    this.emit({ type: "move", gameId: this.gameId!, record, by: "human" });
    this.save();

    if (game.isOver) {
      // The bot passed and so did the human: nothing left to evaluate.
      void this.finishByScore();
    } else {
      void this.evaluateHumanMove(record);
    }
    this.changed();
  }

  private async evaluateHumanMove(record: MoveRecord): Promise<void> {
    const gen = this.gen;
    const game = this.game!;
    const movesBefore = game.moves.slice(0, record.number - 1).map((r) => r.move);
    this.evaluating = record;
    this.busy++;
    this.changed();
    try {
      const [before, after] = await Promise.all([
        this.analysisOf(movesBefore),
        this.analysisOf([...movesBefore, record.move]),
      ]);
      if (!this.isCurrent(gen, record)) return;
      record.eval = moveEvalFrom(before, after, moveGtp(record.move, game.size));
      if (record.eval.pointLoss >= this.profile.mistakeThreshold) {
        try {
          // A first category without ownership; KataGo's ownership refines it in the background.
          this.heuristics[record.number] = this.classify(record, before, after);
          void this.refineCategory(record, movesBefore, gen);
        } catch (err) {
          // Only the category is lost; game end classifies the move again without ownership.
          this.log(`classifying move ${record.number} failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      if (!this.isCurrent(gen, record)) return;
      this.system(`KataGo couldn't evaluate that move (${(err as Error).message}). Playing on without feedback.`);
    } finally {
      this.busy--;
      if (this.evaluating === record) this.evaluating = null;
      this.changed();
    }
    this.save();
    const evaluation = record.eval;
    if (evaluation && evaluation.pointLoss >= this.profile.mistakeThreshold) {
      // On a practice problem the moment waits until the learner goes back to the game.
      if (this.practice) this.deferredMoment = record;
      else this.startMoment(record);
    } else {
      this.maybeBotMove();
    }
    this.changed();
  }

  /**
   * Classify a mistake again with KataGo's ownership before and after it, which spots groups that
   * live or die. It doesn't hold up the teaching moment; a game that ends first keeps the category
   * from the eval.
   */
  private async refineCategory(record: MoveRecord, movesBefore: Move[], gen: number): Promise<void> {
    try {
      const [before, after] = await Promise.all([this.analysisOf(movesBefore, true), this.analysisOf([...movesBefore, record.move], true)]);
      if (this.gen !== gen || this.game?.moves[record.number - 1] !== record) return;
      this.heuristics[record.number] = this.classify(record, before, after);
      this.save();
    } catch (err) {
      this.log(`classifying move ${record.number} with ownership failed: ${(err as Error).message}`);
    }
  }

  private isCurrent(gen: number, record?: MoveRecord): boolean {
    return this.gen === gen && !!this.game && (!record || this.game.lastMove === record);
  }

  // --- teaching moments --------------------------------------------------------------

  private startMoment(record: MoveRecord): void {
    const game = this.game!;
    if (this.result) return;
    const before = this.positionBefore(record);
    const waiting = this.tutorAttached;
    const now = this.clock.now();
    this.moment = {
      id: `${record.number}-${randomBytes(2).toString("hex")}`,
      moveNumber: record.number,
      pointLoss: round1(record.eval!.pointLoss),
      state: "waiting",
      ...(waiting && { deadline: now + this.tutorTimeoutMs }),
    };
    this.status = "paused";
    this.emit({
      type: "teaching_moment",
      gameId: this.gameId!,
      moment: { ...this.moment },
      record,
      boardBefore: toAscii(before.board, before.last),
      boardAfter: toAscii(game.board, this.lastPoint()),
    });
    this.save();
    if (waiting) this.waitForTutor();
    else this.applyFallback();
  }

  /** Give the attached tutor `tutorTimeoutMs` to take the waiting moment before KataGo answers. */
  private waitForTutor(): void {
    const moment = this.moment;
    if (!moment) return;
    this.cancelMomentTimer();
    this.fallbackDeferred = false;
    this.moment = { ...moment, deadline: this.clock.now() + this.tutorTimeoutMs };
    const id = moment.id;
    this.momentTimer = this.clock.setTimeout(() => {
      this.momentTimer = null;
      if (this.moment?.id === id && this.moment.state === "waiting") {
        this.applyFallback();
        this.changed();
      }
    }, this.tutorTimeoutMs);
  }

  /** KataGo answers instead of the tutor: best move and its line on the board, plus plain words. */
  private applyFallback(): void {
    const moment = this.moment;
    const game = this.game;
    if (!moment || !game || !this.settings) return;
    this.cancelMomentTimer();
    if (this.practice) {
      // Its "Press Continue" would land on the problem screen; it waits for Back to playing.
      this.fallbackDeferred = true;
      return;
    }
    this.fallbackDeferred = false;
    const { deadline: _deadline, ...rest } = moment;
    this.moment = { ...rest, state: "fallback" };
    const record = game.moves[moment.moveNumber - 1];
    const evaluation = record?.eval;
    if (record && evaluation) {
      const size = this.settings.size;
      const played = moveGtp(record.move, size);
      // KataGo's line is an alternative to the move, so it is drawn on the board from before it,
      // with the move actually played marked so the learner can find it.
      const moves = this.pvStones(evaluation.bestPv, record);
      const playedPoint = "point" in record.move ? record.move.point : null;
      const marks: NonNullable<Overlay["marks"]> =
        playedPoint && !moves.some((m) => m.point.x === playedPoint.x && m.point.y === playedPoint.y) ? [{ point: playedPoint, kind: "x" }] : [];
      this.overlay = moves.length
        ? { variation: { label: `KataGo's line instead of ${played}`, moves, fromMove: record.number }, ...(marks.length && { marks }) }
        : null;
      const playedText = played === "pass" ? "Passing" : `Your move at ${played}`;
      const best = evaluation.bestMove === "pass" ? "passing" : evaluation.bestMove;
      const where = playedPoint ? ` (your move is marked ✕)` : "";
      const line = moves.length > 1 ? ` The board shows the position before your move${where}; the numbered stones show how play might go instead.` : "";
      this.system(
        `${playedText} cost about ${round1(evaluation.pointLoss)} points. KataGo would have played ${best}.${line} ` +
          `Press Continue to play on, or Try again to take your move back.`,
        moment.id,
      );
    }
    this.emit({ type: "fallback", momentId: moment.id });
  }

  /**
   * Ghost stones for KataGo's line in the position before `record` (where its analysis comes from),
   * played out by the rules so it stops at a pass or a move that isn't legal there.
   */
  private pvStones(pv: Gtp[], record: MoveRecord): { color: Color; point: Point }[] {
    const replay = this.gameBefore(record.number);
    const stones: { color: Color; point: Point }[] = [];
    for (const gtp of pv.slice(0, FALLBACK_PV_LENGTH)) {
      const point = tryFromGtp(gtp, replay.size);
      const color = replay.toPlay;
      if (!point || !replay.play({ color, point }).ok) break;
      stones.push({ color, point });
    }
    return stones;
  }

  private activeMomentId(): string | undefined {
    return this.moment && this.moment.state !== "resolved" ? this.moment.id : undefined;
  }

  /** A tutor command about the current moment: the tutor has it, so stop the fallback clock. */
  private engage(momentId?: string): void {
    const m = this.moment;
    if (!m || (momentId && momentId !== m.id)) return;
    if (m.state !== "waiting" && m.state !== "fallback") return;
    this.cancelMomentTimer();
    const { deadline: _deadline, ...rest } = m;
    this.moment = { ...rest, state: "tutor" };
  }

  private claim(momentId: string): void {
    const m = this.moment;
    if (!m || m.state === "resolved") throw new UserError(`There is no open teaching moment to claim (asked for ${momentId}).`);
    if (m.id !== momentId) throw new UserError(`Moment ${momentId} is not current; the open moment is ${m.id}.`);
    this.engage(momentId);
    this.changed();
  }

  private cancelMomentTimer(): void {
    if (this.momentTimer !== null) this.clock.clearTimeout(this.momentTimer);
    this.momentTimer = null;
  }

  /**
   * Continue (browser) or resume (tutor): end the pause and let the bot reply. Without a pause it
   * does nothing, so a late resume can't start the bot before the human move's eval is in.
   */
  private continueGame(): void {
    if (this.status !== "paused") return;
    if (this.moment && this.moment.state !== "resolved") this.moment = { ...this.moment, state: "resolved" };
    this.cancelMomentTimer();
    this.status = "playing";
    this.overlay = null;
    this.save();
    this.maybeBotMove();
    this.changed();
  }

  /** The open moment a rethink may take back: its move must still be the last one played. */
  private rethinkMoment(momentId?: string): TeachingMoment {
    const { game } = this.requireGame();
    const m = this.moment;
    if (!m || m.state === "resolved" || this.result) {
      throw new UserError("There is no open teaching moment to rethink. Use say to comment on other moves.");
    }
    if (momentId && momentId !== m.id) throw new UserError(`Moment ${momentId} is not current; the open moment is ${m.id}.`);
    if (game.lastMove?.number !== m.moveNumber) {
      throw new UserError(`Move ${m.moveNumber} of moment ${m.id} is already taken back; wait for the learner's new move.`);
    }
    return m;
  }

  /**
   * Take back the human's last move (and the bot's reply, if it came). From the browser's
   * Try again (text null) the moment is over; from the tutor's rethink the moment stays with the
   * tutor until the human plays again.
   */
  private retry(text: string | null, momentId?: string): void {
    const { game, settings } = this.requireGame();
    if (this.result) throw new UserError(ILLEGAL_TEXT.game_over);
    const open = this.moment && this.moment.state !== "resolved" ? this.moment : null;
    if (open && open.moveNumber > game.moves.length) throw new UserError("That move is already taken back. Play a new one.");
    const moves = game.moves;
    let lastHuman = moves.length - 1;
    while (lastHuman >= 0 && moves[lastHuman]!.move.color !== settings.humanColor) lastHuman--;
    if (lastHuman < 0) throw new UserError("There is no move of yours to take back.");
    this.gen++;
    this.evaluating = null;
    this.deferredMoment = null;
    this.fallbackDeferred = false;
    this.cancelMomentTimer();
    game.undo(moves.length - lastHuman);
    this.dropTagsAfter(game.moves.length);
    this.status = "playing";
    this.overlay = null;
    if (this.moment) this.moment = { ...this.moment, state: text === null ? "resolved" : "tutor" };
    if (this.moment?.state === "tutor") delete this.moment.deadline;
    this.emit({ type: "undo", gameId: this.gameId!, moves: game.moves.length, toPlay: game.toPlay, by: text === null ? "human" : "tutor" });
    if (text !== null) this.addChat("tutor", text, momentId);
    this.save();
    this.changed();
  }

  /** Tags on moves that were taken back no longer describe anything: remove them and their tallies. */
  private dropTagsAfter(moveCount: number): void {
    for (const n of Object.keys(this.heuristics).map(Number)) if (n > moveCount) delete this.heuristics[n];
    const dropped = Object.keys(this.tags).map(Number).filter((n) => n > moveCount);
    if (dropped.length === 0) return;
    const profile = this.store.loadProfile();
    for (const n of dropped) {
      const { category } = this.tags[n]!;
      profile.mistakeCounts[category] = Math.max(0, profile.mistakeCounts[category] - 1);
      delete this.tags[n];
    }
    profile.recentMistakes = profile.recentMistakes.filter((m) => m.gameId !== this.gameId || m.moveNumber <= moveCount);
    this.store.saveProfile(profile);
    this.profile = profile;
  }

  // --- bot moves ---------------------------------------------------------------------

  private maybeBotMove(): void {
    const game = this.game;
    const settings = this.settings;
    // The bot waits while the learner is on a practice problem; leaving problem mode resumes the turn.
    if (!game || !settings || this.result || this.status !== "playing" || this.practice) return;
    if (game.toPlay === settings.humanColor || game.isOver || this.evaluating) return;
    if (this.engineState !== "ready" || this.botFor === this.gen) return;
    void this.botMove(game, settings);
  }

  private async botMove(game: GoGame, settings: GameSettings): Promise<void> {
    const gen = this.gen;
    const moveCount = game.moves.length;
    this.botFor = gen;
    this.busy++;
    this.changed();
    let gtp: Gtp | null = null;
    let failure: Error | null = null;
    try {
      const moves = game.moves.map((r) => r.move);
      const choose = async (): Promise<Gtp> => {
        // A human-SL bot at low ranks fills its own territory forever after the human passes, so
        // full-strength KataGo decides whether the game is over.
        const last = moves.at(-1);
        if (last && "pass" in last && passIsFine(await this.analysisOf(moves))) return "pass";
        return this.engine.botMove(this.position(moves), settings.botRank);
      };
      [gtp] = await Promise.all([choose(), this.sleep(this.botDelayMs)]);
    } catch (err) {
      failure = err as Error;
    } finally {
      this.busy--;
      if (this.botFor === gen) this.botFor = null;
    }
    if (this.gen !== gen || this.game !== game || game.moves.length !== moveCount || this.status !== "playing" || this.practice) {
      this.changed();
      return;
    }
    if (failure) {
      this.botFailures++;
      if (this.botFailures <= BOT_RETRIES) {
        this.log(`bot move failed (${failure.message}); retrying`);
        this.clock.setTimeout(() => {
          if (this.isCurrent(gen)) this.maybeBotMove();
        }, this.botRetryMs);
      } else {
        this.system(`KataGo couldn't pick a move (${failure.message}). Restart the server; if it keeps happening, run \`npm run setup:katago\`.`);
      }
      this.changed();
      return;
    }
    this.botFailures = 0;
    this.playBotMove(game, settings, gtp!);
  }

  private playBotMove(game: GoGame, settings: GameSettings, gtp: Gtp): void {
    const color = other(settings.humanColor);
    let point = gtp === "pass" ? null : tryFromGtp(gtp, settings.size);
    if (point === undefined || (point && !game.isLegal(point, color))) {
      this.log(`bot chose an illegal move ${gtp}; passing instead`);
      point = null;
    }
    const result = game.play(point ? { color, point } : { color, pass: true });
    if (!result.ok) return; // only possible if the game state changed under us, which gen rules out
    this.emit({ type: "move", gameId: this.gameId!, record: result.record, by: "bot" });
    this.save();
    if (game.isOver) void this.finishByScore();
    else void this.prefetch();
    this.changed();
  }

  // --- hints and chat --------------------------------------------------------------

  private async hint(text?: string): Promise<void> {
    const { game, settings } = this.requireGame();
    if (this.result) throw new UserError(ILLEGAL_TEXT.game_over);
    // A hint is for the human's move; during a pause or the bot's turn the side to move is the bot.
    if (game.toPlay !== settings.humanColor) {
      throw new UserError(this.status === "paused" ? "Press Continue or Try again first, then ask for a hint." : "Wait for the bot to move, then ask for a hint.");
    }
    if (text?.trim()) this.addChat("user", text.trim(), this.activeMomentId());
    this.emit({
      type: "hint_request",
      gameId: this.gameId!,
      board: toAscii(game.board, this.lastPoint()),
      toPlay: game.toPlay,
      ...(text?.trim() && { text: text.trim() }),
    });
    if (this.tutorAttached) {
      this.system("Asked your tutor for a hint.");
      this.changed();
      return;
    }
    if (this.engineState !== "ready") throw new UserError(this.engineNotReadyText());
    const gen = this.gen;
    const moveCount = game.moves.length;
    this.busy++;
    this.changed();
    try {
      const analysis = await this.analysisOf(game.moves.map((r) => r.move));
      if (!this.isCurrent(gen) || game.moves.length !== moveCount) return;
      const best = analysis.moveInfos[0]?.move ?? "pass";
      const point = best === "pass" ? null : tryFromGtp(best, settings.size);
      if (point) {
        this.overlay = { ...this.overlay, marks: [{ point, kind: "circle" }] };
        this.system(`Hint from KataGo: look at ${best} (circled). Your tutor isn't connected, so that's all it can say.`);
      } else {
        this.system("Hint from KataGo: passing is fine here; the board is settled.");
      }
    } catch (err) {
      if (this.isCurrent(gen)) this.system(`KataGo couldn't give a hint (${(err as Error).message}).`);
    } finally {
      this.busy--;
      this.changed();
    }
  }

  private userChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) throw new UserError("Type a message first.");
    // On a practice problem the message is about the problem, not the game waiting underneath.
    const problemId = this.practice?.problem.id;
    const momentId = problemId ? undefined : this.activeMomentId();
    this.addChat("user", trimmed, momentId);
    this.emit({ type: "user_message", text: trimmed, gameId: this.gameId, ...(momentId && { momentId }), ...(problemId && { problemId }) });
    if (!this.tutorAttached) {
      this.system("Your tutor isn't connected right now, so nobody can answer chat. KataGo's feedback still works.");
    }
    this.changed();
  }

  // --- tutor board drawing ---------------------------------------------------------

  /**
   * A tutor's `show`. During a teaching moment whose move is still on the board, a line starting
   * with the mover's color is an alternative to that move, so it is drawn from the position before
   * it (`fromMove`); a line starting with the other color continues from the current position.
   */
  private variationFrom(moves: Gtp[], start: Color | undefined, label: string | undefined): NonNullable<Overlay["variation"]> {
    const { game, settings } = this.requireGame();
    if (moves.length === 0) throw new UserError("show needs at least one move.");
    const mover = this.moment ? game.moves[this.moment.moveNumber - 1]?.move.color : undefined;
    let color = start ?? mover ?? game.toPlay;
    const m = this.moment;
    const onBoard = m && m.state !== "resolved" && game.lastMove?.number === m.moveNumber;
    const fromMove = onBoard && color === mover ? m.moveNumber : undefined;
    const stones: { color: Color; point: Point }[] = [];
    for (const gtp of moves) {
      const point = this.parsePoint(gtp, settings.size, true);
      if (point) stones.push({ color, point });
      color = other(color);
    }
    return { moves: stones, ...(label && { label }), ...(fromMove !== undefined && { fromMove }) };
  }

  private marksFrom(points: Gtp[], kind: "circle" | "triangle" | "square" | "x", text?: string): NonNullable<Overlay["marks"]> {
    const { settings } = this.requireGame();
    return this.markPoints(points, settings.size, kind, text);
  }

  private markPoints(points: Gtp[], size: number, kind: "circle" | "triangle" | "square" | "x", text?: string): NonNullable<Overlay["marks"]> {
    if (points.length === 0) throw new UserError("mark needs at least one point.");
    return points.map((gtp) => ({ point: this.parsePoint(gtp, size, false)!, kind, ...(text && { text }) }));
  }

  private parsePoint(gtp: Gtp, size: number, allowPass: boolean): Point | null {
    const point = tryFromGtp(gtp, size);
    if (point === undefined || (point === null && !allowPass)) {
      throw new UserError(`"${gtp}" is not a point on a ${size}×${size} board (columns skip I, row 1 is the bottom).`);
    }
    return point;
  }

  // --- game end ------------------------------------------------------------------------

  private resign(): void {
    const { settings } = this.requireGame();
    if (this.result) throw new UserError("The game is already over.");
    this.finish({ winner: other(settings.humanColor), margin: 0, reason: "resign" });
  }

  private async finishByScore(): Promise<void> {
    const game = this.game!;
    const settings = this.settings!;
    const gen = this.gen;
    const board = game.board;
    // KataGo's Chinese rules give White one point per handicap stone.
    const komi = settings.komi + (settings.handicap >= 2 ? settings.handicap : 0);
    let dead: Point[] = [];
    this.busy++;
    this.changed();
    try {
      const analysis = await this.analysisOf(game.moves.map((r) => r.move), true);
      if (analysis.ownership) dead = deadStonesFromOwnership(board, analysis.ownership);
    } catch (err) {
      if (this.isCurrent(gen)) this.system(`KataGo couldn't judge dead stones (${(err as Error).message}); counting every stone as alive.`);
    } finally {
      this.busy--;
      this.changed();
    }
    if (!this.isCurrent(gen) || this.result) return;
    const score = scoreArea(board, komi, dead);
    this.finish({ winner: score.winner, margin: score.margin, reason: "score" }, score.dead.length);
  }

  private finish(result: GameResult, deadCount = 0): void {
    const settings = this.settings!;
    this.gen++;
    this.cancelMomentTimer();
    this.deferredMoment = null;
    this.fallbackDeferred = false;
    this.result = result;
    this.status = "finished";
    this.moment = null;
    this.overlay = null;
    this.summary = this.buildSummary();
    // The game must still be saved and announced if the profile can't be updated.
    try {
      this.summary.rating = this.updateProfileAfterGame(result, this.summary);
    } catch (err) {
      this.log(`updating the profile after game ${this.gameId} failed: ${(err as Error).message}`);
    }
    const dead = deadCount ? ` (${plural(deadCount, "dead stone")} removed)` : "";
    this.system(`Game over: ${formatScore(result, settings.humanColor)}${dead}.`);
    this.saveNow();
    this.emit({ type: "game_end", gameId: this.gameId!, result, summary: this.summary });
    this.changed();
    const gameId = this.gameId!;
    this.generateProblems(gameId, settings, this.game!.moves, this.summary).catch((err: unknown) =>
      this.log(`making practice problems from ${gameId} failed: ${(err as Error).message}`),
    );
  }

  /**
   * Turns each mistake of a finished game into a practice problem: the position before it, the
   * learner to play, and KataGo's candidates within ANSWER_MARGIN of its best as the answers. A
   * mistake whose stored candidates are thin is analyzed again, deeper, first. So is one where a ko
   * ban applied: the problem position has no move history, so the immediate recapture is legal
   * there and the game's candidates (a ko threat, say) no longer answer it; without that analysis
   * there is no problem.
   */
  private async generateProblems(gameId: string, settings: GameSettings, moves: MoveRecord[], summary: GameSummary): Promise<void> {
    const snapshots: MistakeSnapshot[] = [];
    const koBanned = new Set<MistakeSnapshot>();
    for (const m of summary.mistakes) {
      const record = moves[m.moveNumber - 1];
      const evaluation = record?.eval;
      if (!record || !evaluation) continue;
      let before: GoGame;
      try {
        before = GoGame.fromMoves(settings.size, settings.komi, settings.handicap, moves.slice(0, m.moveNumber - 1).map((r) => r.move));
      } catch {
        continue;
      }
      const snapshot: MistakeSnapshot = {
        gameId,
        moveNumber: m.moveNumber,
        played: m.move,
        pointLoss: evaluation.pointLoss,
        category: m.category ?? "other",
        size: settings.size,
        komi: settings.komi,
        board: before.board,
        toPlay: record.move.color,
        candidates: evaluation.candidates.map((c) => ({ move: c.move, lead: c.lead, visits: c.visits, pv: c.pv })),
      };
      snapshots.push(snapshot);
      if (hasKoBan(before)) koBanned.add(snapshot);
    }
    const deepen = async (s: MistakeSnapshot): Promise<void> => {
      const ko = koBanned.has(s);
      if (this.engineState === "ready") {
        try {
          const position = problemPosition({ size: s.size, komi: s.komi, stones: stonesOf(s.board), toPlay: s.toPlay });
          s.candidates = candidatesFromAnalysis(await this.engine.analyze(position, { maxVisits: DEEP_VISITS }));
          return;
        } catch (err) {
          this.log(`deeper analysis for a problem from ${gameId} move ${s.moveNumber} failed: ${(err as Error).message}`);
        }
      }
      if (ko) s.candidates = []; // the game's answers belong to a position the problem can't show
    };
    // As many at once as KataGo runs, so they don't queue up ahead of the next game's analyses.
    const queue = snapshots.filter((s) => koBanned.has(s) || candidatesThin(s.candidates));
    const workers = Math.max(1, Math.min(queue.length, this.engine.concurrency ?? 1));
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (let s = queue.shift(); s; s = queue.shift()) await deepen(s);
      }),
    );
    try {
      const problems = this.store.loadProblems();
      const now = this.clock.now();
      const fresh: StoredProblem[] = [];
      // The tutor may have tagged a mistake while KataGo was busy: the problem takes the tag. The
      // current game's summary is the object `tag` updates; a saved game's lives on disk.
      const current = (gameId === this.gameId ? this.summary : this.store.loadGame(gameId)?.summary) ?? summary;
      for (const s of snapshots) {
        s.category = current.mistakes.find((m) => m.moveNumber === s.moveNumber)?.category ?? s.category;
        const problem = problemFromMistake(s, nextProblemId([...problems, ...fresh]), now);
        if (problem) fresh.push(problem);
      }
      const added = addProblems(problems, fresh);
      if (added.length === 0) return;
      this.store.saveProblems(problems);
      this.log(`practice problems from ${gameId}: ${added.map((p) => p.id).join(", ")}`);
      if (this.gameId === gameId && !this.practice) {
        this.system(`${added.length === 1 ? "One of your mistakes is" : `${added.length} of your mistakes are`} now a practice problem. Press Practice to try ${added.length === 1 ? "it" : "them"}.`);
      }
    } catch (err) {
      this.log(`saving practice problems from ${gameId} failed: ${(err as Error).message}`);
    }
  }

  private buildSummary(): GameSummary {
    const game = this.game!;
    const settings = this.settings!;
    const human = game.moves.filter((r) => r.move.color === settings.humanColor && r.eval);
    const mistakes = human
      .filter((r) => r.eval!.pointLoss >= this.profile.mistakeThreshold)
      .sort((a, b) => b.eval!.pointLoss - a.eval!.pointLoss)
      .map((r) => {
        const tagged = this.tags[r.number]?.category;
        // A mistake evaluated before this boot (or below the threshold back then) is classified now.
        const category = tagged ?? (this.heuristics[r.number] ??= this.classifyOrOther(r));
        return {
          moveNumber: r.number,
          move: moveGtp(r.move, settings.size),
          pointLoss: round1(r.eval!.pointLoss),
          bestMove: r.eval!.bestMove,
          category,
          categorySource: tagged ? ("tutor" as const) : ("heuristic" as const),
        };
      });
    const total = human.reduce((sum, r) => sum + r.eval!.pointLoss, 0);
    return { moves: game.moves.length, mistakes, totalPointLoss: round1(total) };
  }

  /**
   * A heuristic category for a human move (src/server/profile.ts). The analyses around the move
   * give KataGo's ownership, for spotting groups that live or die; without them that check is skipped.
   */
  private classify(record: MoveRecord, before?: Analysis, after?: Analysis): MistakeCategory {
    const settings = this.settings!;
    const replay = this.gameBefore(record.number);
    const boardBefore = replay.board;
    replay.play(record.move);
    return classifyMistake({
      size: settings.size,
      moveNumber: record.number,
      move: record.move,
      captures: record.captures.length,
      pointLoss: record.eval?.pointLoss ?? 0,
      threshold: this.profile.mistakeThreshold,
      bestMove: record.eval?.bestMove ?? "pass",
      reply: after?.moveInfos[0]?.move,
      boardBefore,
      boardAfter: replay.board,
      ...(before?.ownership && { ownershipBefore: before.ownership }),
      ...(after?.ownership && { ownershipAfter: after.ownership }),
    });
  }

  /** `classify`, or "other" (logged) when it fails, so a bad replay can't stop the game from ending. */
  private classifyOrOther(record: MoveRecord, before?: Analysis, after?: Analysis): MistakeCategory {
    try {
      return this.classify(record, before, after);
    } catch (err) {
      this.log(`classifying move ${record.number} failed: ${(err as Error).message}`);
      return "other";
    }
  }

  /** Rating, next bot, heuristic mistake tallies and the threshold, from the finished game. */
  private updateProfileAfterGame(result: GameResult, summary: GameSummary): GameSummary["rating"] {
    const settings = this.settings!;
    const profile = this.store.loadProfile();
    const update = applyGame(profile, {
      gameId: this.gameId!,
      ts: this.clock.now(),
      settings,
      result,
      moves: this.game!.moves,
      summary,
      threshold: this.profile.mistakeThreshold,
    });
    this.store.saveProfile(profile);
    this.profile = profile;
    if (update.threshold) {
      const { from, to } = update.threshold;
      this.log(`mistake threshold ${from} -> ${to} (${update.threshold.reason})`);
    }
    return update.rating;
  }

  /**
   * Tag a mistake with a category (current or saved game). The tutor's tag replaces the heuristic
   * category in the summary and in the profile tallies.
   */
  private tag(gameId: string, moveNumber: number, category: MistakeCategory, note?: string): void {
    const saved = gameId === this.gameId ? null : this.store.loadGame(gameId);
    if (gameId !== this.gameId && !saved) throw new UserError(`No saved game "${gameId}".`);
    const moves = saved ? saved.moves : this.game!.moves;
    const humanColor = (saved ? saved.settings : this.settings!).humanColor;
    const record = moves[moveNumber - 1];
    if (!record) throw new UserError(`Game ${gameId} has no move ${moveNumber}.`);
    if (record.move.color !== humanColor) {
      throw new UserError(`Move ${moveNumber} was the bot's. Tag the learner's moves (${humanColor === "B" ? "Black" : "White"}).`);
    }
    const tags = saved ? (saved.tags ??= {}) : this.tags;
    const summary = saved ? saved.summary : this.summary;
    const entry = summary?.mistakes.find((m) => m.moveNumber === moveNumber);
    // What the move counts as so far: an earlier tag, or the heuristic category counted at game end.
    const previous = tags[moveNumber]?.category ?? (entry?.categorySource === "heuristic" ? entry.category : undefined);
    tags[moveNumber] = { category, ...(note && { note }) };

    const profile = this.store.loadProfile();
    const pointLoss = round1(record.eval?.pointLoss ?? 0);
    applyTag(profile, { ts: this.clock.now(), gameId, moveNumber, category, pointLoss, ...(note && { note }) }, previous);
    this.store.saveProfile(profile);
    this.profile = profile;

    if (entry) {
      entry.category = category;
      entry.categorySource = "tutor";
    }
    this.retagProblem(gameId, moveNumber, category);
    if (saved) {
      this.store.saveGame({ ...saved, updatedAt: this.clock.now() }, this.sgfFor(saved.settings, saved.moves, saved.result, tags));
    } else {
      this.save();
    }
    this.changed();
  }

  /** A tag changes what a mistake was about; the practice problem made from it follows. */
  private retagProblem(gameId: string, moveNumber: number, category: MistakeCategory): void {
    // The problem may be on the board right now: its result and attempts count for the new category.
    const onBoard = this.practice?.problem;
    if (onBoard?.source?.gameId === gameId && onBoard.source.moveNumber === moveNumber && onBoard.category !== category) {
      onBoard.category = category;
      onBoard.prompt = promptFor(category, onBoard.toPlay);
    }
    try {
      const problems = this.store.loadProblems();
      const problem = problems.find((p) => p.source?.gameId === gameId && p.source.moveNumber === moveNumber);
      if (!problem || problem.category === category) return;
      problem.category = category;
      problem.prompt = promptFor(category, problem.toPlay);
      this.store.saveProblems(problems);
    } catch (err) {
      this.log(`updating the problem from ${gameId} move ${moveNumber} failed: ${(err as Error).message}`);
    }
  }

  // --- practice problems -------------------------------------------------------------

  /**
   * Enter problem mode with problem `id`, or the next one due: the recommended focus category
   * first, then the learner's own problems, then the built-ins (src/server/problems.ts).
   */
  private startProblem(id?: string): void {
    const problems = this.store.loadProblems();
    let problem: StoredProblem | undefined;
    let early = false;
    if (id) {
      problem = problems.find((p) => p.id === id);
      if (!problem) throw new UserError(`No practice problem "${id}". List them with: tutor problems`);
    } else {
      const next = pickNextProblem(problems, {
        now: this.clock.now(),
        focus: recommendFocus(this.profile).category,
        exclude: this.practice?.problem.id ?? this.lastProblemId,
      });
      if (!next) throw new UserError("There are no practice problems yet.");
      ({ problem, early } = next);
    }
    let game: GoGame;
    try {
      game = problemGame(problem);
    } catch (err) {
      throw new UserError(`Problem ${problem.id} can't be set up: ${(err as Error).message}`);
    }
    // Leaving the problem on the board after a wrong attempt reschedules it; the same problem again
    // then starts from its new box.
    const previous = this.practice?.problem.id;
    if (this.closePractice() && problem.id === previous) {
      problem = this.store.loadProblems().find((p) => p.id === problem!.id) ?? problem;
    }
    this.practice = { problem, game, box: problem.box, attempts: 0, solved: false, revealed: false, checking: false, overlay: null, analyses: new Map() };
    this.lastProblemId = problem.id;
    const from = problem.source ? ` from your game ${problem.source.gameId} (move ${problem.source.moveNumber})` : "";
    this.system(`Practice problem${from}: ${problem.prompt}${early ? " (Nothing is due right now, so this is an early review.)" : ""}`);
    this.emit({
      type: "problem_start",
      problemId: problem.id,
      kind: problem.kind,
      category: problem.category,
      toPlay: problem.toPlay,
      prompt: problem.prompt,
      answers: [...problem.answers],
      box: problem.box,
      ...(problem.source && { source: { gameId: problem.source.gameId, moveNumber: problem.source.moveNumber } }),
      board: toAscii(game.board, null),
    });
    // KataGo reads the position while the learner does.
    if (this.engineState === "ready") this.problemAnalysis(this.practice, []).catch(() => {});
    this.changed();
  }

  /** Back to playing: the game (paused, finished or mid-turn) as it was, or the idle board. */
  private leaveProblem(): void {
    if (!this.practice) return;
    this.closePractice();
    const deferred = this.deferredMoment;
    this.deferredMoment = null;
    if (deferred && this.isCurrent(this.gen, deferred) && !this.result) {
      this.startMoment(deferred);
    } else if (this.fallbackDeferred && this.moment?.state === "waiting") {
      this.applyFallback();
    } else {
      this.fallbackDeferred = false;
      this.resumeTurn();
    }
    this.changed();
  }

  /**
   * End problem mode. A problem left unfinished after a wrong attempt counts as failed (box 1);
   * one left before any judged attempt keeps its schedule. Returns whether a failure was recorded.
   */
  private closePractice(): boolean {
    const practice = this.practice;
    this.practice = null;
    // Unrevealed means unsolved, so any judged attempt was wrong.
    if (!practice || practice.revealed || !practice.lastAttempt) return false;
    this.finishProblem(practice);
    return true;
  }

  private problemPlay(point: Point): void {
    const practice = this.practice!;
    if (practice.revealed) throw new UserError("This problem is over. Press Next problem, or Back to playing.");
    if (practice.checking) throw new UserError("KataGo is still checking your last move.");
    if (this.engineState !== "ready") throw new UserError(this.engineNotReadyText());
    const reason = practice.game.illegalReason(point);
    if (reason) throw new UserError(ILLEGAL_TEXT[reason]);
    practice.attempts++;
    practice.checking = true;
    practice.overlay = null;
    this.changed();
    void this.checkAttempt(practice, toGtp(point, practice.problem.size), point);
  }

  /**
   * Judge an attempt: a known answer is correct; any other move is correct when KataGo finds it
   * within ANSWER_MARGIN of its best (and becomes an answer). A wrong move with attempts left gets
   * a ✕ and another try; otherwise the problem ends with KataGo's line on the board.
   */
  private async checkAttempt(practice: Practice, move: Gtp, point: Point): Promise<void> {
    let before: Analysis | null = null;
    let after: Analysis | null = null;
    let failure: Error | null = null;
    this.busy++;
    try {
      [before, after] = await Promise.all([this.problemAnalysis(practice, []), this.problemAnalysis(practice, [move])]);
    } catch (err) {
      failure = err as Error;
    } finally {
      this.busy--;
    }
    if (this.practice !== practice) {
      this.changed();
      return;
    }
    practice.checking = false;
    const problem = practice.problem;
    const known = problem.answers.includes(move);
    if (!known && (!before || !after)) {
      practice.attempts--; // KataGo's failure doesn't cost the learner an attempt
      this.system(`KataGo couldn't check ${move} (${failure?.message ?? "no answer"}). Try the move again.`);
      this.changed();
      return;
    }
    // The margin is checked on the raw loss; it is rounded only for display.
    const rawLoss = before && after ? moveEvalFrom(before, after, move).pointLoss : null;
    const loss = rawLoss === null ? null : round1(rawLoss);
    const correct = known || (rawLoss !== null && rawLoss <= ANSWER_MARGIN);
    // A known answer KataGo now rates lower stays correct; its loss would only confuse.
    const pointLoss = correct && rawLoss !== null && rawLoss > ANSWER_MARGIN ? null : loss;
    // The attempt is judged either way, but it becomes an answer for good only when KataGo searched
    // it well in the problem position: otherwise its loss compares two separate searches, which
    // disagree by a point or more run to run.
    if (correct && !known && before && searchedWell(before, move)) problem.answers = [...problem.answers, move];
    const best = before?.moveInfos[0];
    const bestMove = best && best.move !== "pass" ? best.move : (problem.bestMove ?? problem.answers[0] ?? move);
    const bestPv = best && best.move !== "pass" ? best.pv : (problem.bestPv ?? [bestMove]);
    practice.lastAttempt = { move, correct, pointLoss };
    const left = MAX_ATTEMPTS - practice.attempts;

    if (correct) {
      practice.solved = true;
      practice.revealed = true;
      practice.answer = { move: bestMove, pv: bestPv };
      // The answer, the opponent's best reply and the next move.
      const line = this.problemStones(practice, [move, ...(after?.moveInfos[0]?.pv ?? [])].slice(0, ANSWER_LINE_LENGTH));
      // Even a line of one stone is drawn: the board is the fixed problem position, so without it
      // the learner's stone would vanish (KataGo's reply on a settled board is usually a pass).
      practice.overlay = line.length ? { variation: { label: line.length > 1 ? `${move} and how play goes on` : move, moves: line } } : null;
      const also = bestMove !== move ? ` KataGo's favorite is ${bestMove}, and yours is about as good.` : "";
      const shown = line.length > 1 ? " The board shows the opponent's best reply." : "";
      this.system(`Correct${practice.attempts === 1 ? ", first try" : ""}: ${move}.${also}${shown}`);
    } else if (left > 0) {
      practice.overlay = { marks: [{ point, kind: "x" }] };
      this.system(`${move} isn't it: it loses about ${loss} points. Try again (${plural(left, "attempt")} left).`);
    } else {
      practice.revealed = true;
      practice.answer = { move: bestMove, pv: bestPv };
      const line = this.problemStones(practice, bestPv.slice(0, FALLBACK_PV_LENGTH));
      const covered = line.some((s) => s.point.x === point.x && s.point.y === point.y);
      practice.overlay = {
        ...(line.length && { variation: { label: `KataGo's answer: ${bestMove}`, moves: line } }),
        ...(!covered && { marks: [{ point, kind: "x" as const }] }),
      };
      this.system(`${move} loses about ${loss} points. The answer is ${bestMove}; the board shows KataGo's line (your move is marked ✕).`);
    }
    this.emit({
      type: "problem_attempt",
      problemId: problem.id,
      move,
      correct,
      category: problem.category,
      attempt: practice.attempts,
      firstTry: correct && practice.attempts === 1,
      pointLoss,
      revealed: practice.revealed,
      bestMove,
      bestPv: bestPv.slice(0, 8),
    });
    if (practice.revealed) this.finishProblem(practice);
    this.changed();
  }

  /** The problem is over: schedule it (Leitner box), keep any new answer, and update the profile. */
  private finishProblem(practice: Practice): void {
    const { problem } = practice;
    try {
      const problems = this.store.loadProblems();
      const stored = problems.find((p) => p.id === problem.id);
      if (stored) {
        stored.answers = [...new Set([...stored.answers, ...problem.answers])];
        schedule(stored, resultOf(practice.solved, practice.attempts), this.clock.now());
        this.store.saveProblems(problems);
      }
    } catch (err) {
      this.log(`saving problem ${problem.id} failed: ${(err as Error).message}`);
    }
    try {
      const profile = this.store.loadProfile();
      applyProblemResult(profile, problem.category, practice.solved);
      this.store.saveProfile(profile);
      this.profile = profile;
    } catch (err) {
      this.log(`updating the profile after problem ${problem.id} failed: ${(err as Error).message}`);
    }
  }

  /** Cached analysis of the problem position after `moves` (the learner moving first). */
  private problemAnalysis(practice: Practice, moves: Gtp[]): Promise<Analysis> {
    const key = moves.join(" ");
    let pending = practice.analyses.get(key);
    if (!pending) {
      pending = this.engine.analyze(problemPosition(practice.problem, moves), { maxVisits: this.problemVisits });
      practice.analyses.set(key, pending);
      pending.catch(() => practice.analyses.delete(key));
    }
    return pending;
  }

  /** Ghost stones for a line from the problem position, stopping at a pass or an illegal move. */
  private problemStones(practice: Practice, line: Gtp[]): { color: Color; point: Point }[] {
    const replay = problemGame(practice.problem);
    const stones: { color: Color; point: Point }[] = [];
    for (const gtp of line) {
      const point = tryFromGtp(gtp, replay.size);
      const color = replay.toPlay;
      if (!point || !replay.play({ color, point }).ok) break;
      stones.push({ color, point });
    }
    return stones;
  }

  /** A tutor's `show` in problem mode: always from the problem position, the learner's color first by default. */
  private problemVariation(practice: Practice, moves: Gtp[], start: Color | undefined, label: string | undefined): NonNullable<Overlay["variation"]> {
    if (moves.length === 0) throw new UserError("show needs at least one move.");
    let color = start ?? practice.problem.toPlay;
    const stones: { color: Color; point: Point }[] = [];
    for (const gtp of moves) {
      const point = this.parsePoint(gtp, practice.problem.size, true);
      if (point) stones.push({ color, point });
      color = other(color);
    }
    return { moves: stones, ...(label && { label }) };
  }

  private problemView(p: Practice): GameView {
    const { problem } = p;
    return {
      gameId: null,
      mode: "problem",
      settings: {
        size: problem.size as GameSettings["size"],
        komi: problem.komi,
        humanColor: problem.toPlay,
        botRank: this.settings?.botRank ?? this.profile.botRank,
        handicap: 0,
      },
      status: p.revealed ? "finished" : "playing",
      board: p.game.board,
      toPlay: problem.toPlay,
      moves: [],
      captures: { B: 0, W: 0 },
      result: null,
      moment: null,
      overlay: p.overlay,
      chat: this.chat.slice(-VIEW_CHAT_LIMIT),
      tutorAttached: this.tutorAttached,
      engineBusy: this.engineState !== "ready" || this.busy > 0 || p.checking,
      problem: {
        id: problem.id,
        prompt: problem.prompt,
        ...(problem.source && { source: { gameId: problem.source.gameId, moveNumber: problem.source.moveNumber } }),
        attempts: p.attempts,
        solved: p.solved,
        kind: problem.kind,
        category: problem.category,
        toPlay: problem.toPlay,
        maxAttempts: MAX_ATTEMPTS,
        revealed: p.revealed,
        box: p.box,
        ...(p.lastAttempt && { lastAttempt: { ...p.lastAttempt } }),
        ...(p.answer && { answer: { move: p.answer.move, pv: [...p.answer.pv] } }),
      },
    };
  }

  // --- persistence -----------------------------------------------------------------

  /**
   * Save the current game at the end of this tick. One action changes the game several times
   * (move, chat, moment), and each save rewrites the JSON and SGF, so the burst is written once.
   */
  private save(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    setImmediate(() => this.flush());
  }

  /** Write a pending save now. Call before shutting down. */
  flush(): void {
    if (this.saveQueued) this.saveNow();
  }

  private saveNow(): void {
    this.saveQueued = false;
    const game = this.game;
    const settings = this.settings;
    if (!game || !settings || !this.gameId) return;
    const moves = game.moves;
    const record: SavedGame = {
      id: this.gameId,
      settings,
      createdAt: this.createdAt,
      updatedAt: this.clock.now(),
      moves,
      result: this.result,
      summary: this.summary,
      chat: this.chat.filter((m) => m.ts >= this.createdAt),
      tags: this.tags,
      heuristics: this.heuristics,
      moment: this.moment,
    };
    try {
      this.store.saveGame(record, this.sgfFor(settings, moves, this.result, this.tags));
    } catch (err) {
      this.log(`saving game ${this.gameId} failed: ${(err as Error).message}`);
    }
  }

  private sgfFor(settings: GameSettings, moves: MoveRecord[], result: GameResult | null, tags: SavedGame["tags"]): string {
    const comments: Record<number, string> = {};
    for (const r of moves) {
      const e = r.eval;
      const tag = tags[r.number];
      const parts: string[] = [];
      if (e && e.pointLoss >= 1) parts.push(`Lost ${round1(e.pointLoss)} points; KataGo preferred ${e.bestMove}.`);
      if (tag) parts.push(`[${tag.category}]${tag.note ? ` ${tag.note}` : ""}`);
      if (parts.length) comments[r.number] = parts.join(" ");
    }
    return writeSgf(settings, moves, result, comments);
  }

  // --- engine helpers ------------------------------------------------------------------

  private position(moves: Move[]): Position {
    const game = this.game!;
    return {
      size: game.size,
      komi: game.komi,
      rules: "chinese",
      moves: moves.map((m) => [m.color, moveGtp(m, game.size)]),
      initialStones: game.initialStones.map((s) => [s.color, toGtp(s.point, game.size)]),
      initialPlayer: game.initialPlayer,
    };
  }

  /**
   * Cached analysis of the position after `moves`. Only scoring and classifying a mistake need
   * KataGo's ownership, so only they ask for it; an entry without ownership doesn't satisfy them,
   * and the analysis with ownership then replaces it (it serves every other purpose too).
   */
  private analysisOf(moves: Move[], ownership = false): Promise<Analysis> {
    const pos = this.position(moves);
    const key = pos.moves.map((m) => m[1]).join(" ");
    const cached = this.analyses.get(key);
    if (cached && (cached.ownership || !ownership)) return cached.pending;
    const opts: AnalyzeOptions = {
      ...(ownership && { includeOwnership: true }),
      ...(this.analysisVisits !== undefined && { maxVisits: this.analysisVisits }),
    };
    const entry = { pending: this.engine.analyze(pos, opts), ownership };
    this.analyses.set(key, entry);
    entry.pending.catch(() => {
      if (this.analyses.get(key) === entry) this.analyses.delete(key);
    });
    return entry.pending;
  }

  /** Analyze the current position in the background, so the next human move's "before" is ready. */
  private async prefetch(): Promise<void> {
    const game = this.game;
    if (!game || this.result) return;
    try {
      await this.analysisOf(game.moves.map((r) => r.move));
    } catch (err) {
      this.log(`background analysis failed: ${(err as Error).message}`);
    }
  }

  private engineNotReadyText(): string {
    return this.engineState === "failed"
      ? "KataGo isn't running. See the chat for how to fix it."
      : "KataGo is still starting up (this can take about 30 seconds). Try again in a moment.";
  }

  private sleep(ms: number): Promise<void> {
    return ms > 0 ? new Promise((resolve) => this.clock.setTimeout(resolve, ms)) : Promise.resolve();
  }

  // --- small helpers ------------------------------------------------------------------

  private requireGame(): { game: GoGame; settings: GameSettings } {
    if (!this.game || !this.settings) throw new UserError("No game in progress. Start a new game first.");
    return { game: this.game, settings: this.settings };
  }

  private lastPoint(): Point | null {
    const last = this.game?.lastMove;
    return last && "point" in last.move ? last.move.point : null;
  }

  /** The game as it was before move `moveNumber` (1-based). */
  private gameBefore(moveNumber: number): GoGame {
    const { game, settings } = this.requireGame();
    return GoGame.fromMoves(settings.size, settings.komi, settings.handicap, game.moves.slice(0, moveNumber - 1).map((r) => r.move));
  }

  /** The board before `record` was played, and the move before it, for the tutor's ASCII view. */
  private positionBefore(record: MoveRecord): { board: Board; last: Point | null } {
    const replay = this.gameBefore(record.number);
    const prev = replay.lastMove;
    return { board: replay.board, last: prev && "point" in prev.move ? prev.move.point : null };
  }

  /** Adds a chat message and saves it with the game, so a restart (or a post-game review) keeps it. */
  private addChat(from: ChatMessage["from"], text: string, momentId?: string): void {
    this.chat.push({ id: `c${this.nextChatId++}`, ts: this.clock.now(), from, text, ...(momentId && { momentId }) });
    if (this.chat.length > CHAT_LIMIT) this.chat.splice(0, this.chat.length - CHAT_LIMIT);
    this.save();
  }

  /** A system chat message (also used for KataGo status and errors). */
  system(text: string, momentId?: string): void {
    this.addChat("system", text, momentId);
    this.changed();
  }

  private emit(event: TutorEventInput): void {
    for (const fn of this.eventListeners) fn(event);
  }

  private changed(): void {
    for (const fn of this.changeListeners) fn();
  }
}

