// GameController: the current game, turns, bot replies, per-move evals, teaching moments with the
// tutor wait and KataGo fallback, the chat log, and the GameView / TutorEvents the rest of the
// server publishes. Practice problems run in a PracticeSession (practice.ts) while the game waits
// underneath. It knows nothing about HTTP or KataGo's process; the engine is injected.
//
// Every async engine call captures `gen` (bumped by new game, undo and game end) and the move
// count; a reply that no longer matches is dropped, so late answers never touch a newer state.

import { randomBytes } from "node:crypto";
import { GoGame, deadStonesFromOwnership, emptyBoard, opponent, scoreArea, toAscii, writeSgf } from "../engine/index.ts";
import { allowedActions, retryBlocked, type ActionState } from "../shared/allowed.ts";
import { moveGtp, movePoint, samePoint, toGtp, tryFromGtp } from "../shared/coords.ts";
import { normalizeBotRank } from "../shared/rank.ts";
import { colorName, formatScore, round1 } from "../shared/text.ts";
import type {
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
  Profile,
  SavedGame,
  TeachingMoment,
  TutorCommand,
} from "../shared/types.ts";
import {
  ILLEGAL_TEXT,
  PV_STONES,
  UserError,
  alternatingStones,
  lineStones,
  markPoints,
  plural,
  systemClock,
  type Clock,
  type TutorEventInput,
} from "./common.ts";
import { moveEvalFrom, type Analysis, type Engine, type Position } from "./katago.ts";
import { PracticeSession, type PracticeDeps } from "./practice.ts";
import { generateProblems, pickNextProblem, promptFor, resultOf, schedule, type StoredProblem } from "./problems.ts";
import { applyGame, applyProblemResult, applyTag, classifyMistake, recommendFocus } from "./profile.ts";
import type { Store } from "./store.ts";

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

export const DEFAULT_SETTINGS: Omit<GameSettings, "botRank"> = { size: 9, komi: 7, humanColor: "B", handicap: 0 };
const CHAT_LIMIT = 200;
const VIEW_CHAT_LIMIT = 100;
const BOT_RETRIES = 3;
const DEFAULT_PROBLEM_VISITS = 600;
/** Komi when the profile gives the learner handicap stones. */
const HANDICAP_KOMI = 0.5;
/** Analyses kept: the recent positions, which cover an open moment and a Try again. */
const ANALYSIS_CACHE_SIZE = 16;

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
  private readonly log: (msg: string) => void;
  private readonly practiceDeps: PracticeDeps;

  private readonly eventListeners: ((e: TutorEventInput) => void)[] = [];
  private readonly changeListeners: (() => void)[] = [];

  private profile: Profile;
  /** Bumped by every profile change, so the browser knows to fetch it again. */
  private profileVersion = 0;
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
  /** Heuristic mistake categories by move number, from the eval of each mistake. */
  private heuristics: Record<number, MistakeCategory> = {};
  private tutorAttached = false;
  private engineState: EngineState = "starting";
  /** Problem mode: the problem on the board. */
  private practice: PracticeSession | null = null;
  /** The problem shown last, so Next problem moves on to a different one. */
  private lastProblemId: string | undefined;

  /** Bumped whenever a pending engine reply could become stale. */
  private gen = 0;
  /** Engine calls the human is waiting on (move eval, bot move, scoring, hint, problem check). */
  private busy = 0;
  /** `gen` for which a bot move is in flight, if any. */
  private botFor: number | null = null;
  private botFailures = 0;
  /** The human move whose evaluation is in flight. The bot waits for it, so a moment can't be skipped. */
  private evaluating: MoveRecord | null = null;
  private momentTimer: unknown = null;
  /** Mistakes whose teaching moment has opened (or was dismissed before a restart). */
  private readonly momentShown = new WeakSet<MoveRecord>();
  /** Analyses by position (moves as a GTP list), least recently used first. */
  private readonly analyses = new Map<string, Promise<Analysis>>();
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
    this.log = opts.log ?? (() => {});
    this.profile = this.store.loadProfile();
    this.practiceDeps = {
      engine: this.engine,
      problemVisits: opts.problemVisits ?? DEFAULT_PROBLEM_VISITS,
      engineNotReady: () => (this.engineState === "ready" ? null : this.engineNotReadyText()),
      system: (text) => this.system(text),
      say: (text, momentId) => {
        this.addChat("tutor", text, momentId);
        this.changed();
      },
      emit: (e) => this.emit(e),
      changed: () => this.changed(),
      busyWhile: (p) => this.busyWhile(p),
      addAnswer: (id, move) => this.addProblemAnswer(id, move),
      recordResult: (problem, solved, attempts) => this.recordProblemResult(problem, solved, attempts),
    };
  }

  onEvent(fn: (e: TutorEventInput) => void): void {
    this.eventListeners.push(fn);
  }

  onChange(fn: () => void): void {
    this.changeListeners.push(fn);
  }

  // --- view ------------------------------------------------------------------

  view(): GameView {
    const common = {
      chat: this.chat.slice(-VIEW_CHAT_LIMIT),
      tutorAttached: this.tutorAttached,
      engineBusy: this.engineState !== "ready" || this.busy > 0,
      profileVersion: this.profileVersion,
      allowed: this.allowed(),
    };
    if (this.practice) return this.practice.view(common, this.settings?.botRank ?? this.profile.botRank);
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
      ...common,
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

  /** The browser actions handleAction accepts right now: the same checks it makes (src/shared/allowed.ts). */
  private allowed(): ClientAction["type"][] {
    return allowedActions(this.actionState());
  }

  /** What the shared allowed-actions rules read of the controller. */
  private actionState(): ActionState {
    const { game, settings } = this;
    return {
      mode: this.practice ? "problem" : game ? "game" : "idle",
      status: this.status,
      finished: this.result !== null,
      humanColor: game && settings ? settings.humanColor : null,
      toPlay: game ? game.toPlay : "B",
      moves: game ? game.moves : [],
      moment: this.moment,
      engineReady: this.engineState === "ready",
      tutorAttached: this.tutorAttached,
      problem: this.practice ? this.practice.actionState : null,
    };
  }

  // --- wiring from the bridge / index ------------------------------------------

  setTutorAttached(attached: boolean): void {
    if (attached === this.tutorAttached) return;
    this.tutorAttached = attached;
    // Nobody is left to answer a waiting moment: its wait is off (KataGo answers, or a tutor who
    // comes back gets a fresh one).
    if (!attached && this.moment?.state === "waiting") {
      this.cancelMomentTimer();
      this.setMomentState("waiting");
    }
    this.settleWaitingMoment();
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
   * Do what the game's state calls for next, after a restore, KataGo becoming ready, a mistake's
   * eval or Back to playing: settle a waiting moment whose wait isn't running, open the moment of a
   * mistake that has none, score a game that ended, evaluate a human move that never got its eval,
   * or let the bot reply. While a practice problem is on the board the game waits.
   */
  private resumeTurn(): void {
    const { game, settings } = this;
    if (!game || !settings || this.result) return;
    if (this.settleWaitingMoment() || this.practice) return;
    const last = game.lastMove;
    const human = last && last.move.color === settings.humanColor ? last : null;
    const loss = human?.eval?.pointLoss;
    if (human && loss !== undefined && loss >= this.profile.mistakeThreshold && !game.isOver && !this.momentShown.has(human)) {
      this.startMoment(human);
      return;
    }
    if (this.engineState !== "ready") return;
    if (game.isOver) {
      void this.finishByScore();
      return;
    }
    if (this.status !== "playing") return;
    if (human && !human.eval && !this.evaluating) {
      void this.evaluateHumanMove(human);
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
    // A mistake the learner dismissed stays dismissed; one they hadn't dealt with opens again.
    const last = game.lastMove;
    if (last && saved.moment?.moveNumber === last.number && saved.moment.state === "resolved") this.momentShown.add(last);
    this.resumeTurn();
    this.changed();
    return true;
  }

  // --- browser actions -------------------------------------------------------

  async handleAction(action: ClientAction): Promise<void> {
    switch (action.type) {
      case "new_game":
        return this.newGame(action.settings);
      case "chat":
        return this.userChat(action.text);
      case "next_problem":
        return this.startProblem();
      case "leave_problem":
        return this.leaveProblem();
    }
    // In problem mode the game waits underneath: the problem answers the game's actions.
    if (this.practice) return this.practice.handleAction(action);
    switch (action.type) {
      case "play":
        return this.play(action.point);
      case "pass":
        return this.play(null);
      case "resign":
        return this.resign();
      case "continue":
        return this.continueGame();
      case "retry":
        return this.retry(null);
      case "ask_tutor":
        return this.hint(action.text);
    }
  }

  // --- tutor commands -----------------------------------------------------------

  async handleTutor(cmd: TutorCommand): Promise<void> {
    switch (cmd.type) {
      case "claim":
        return this.claim(cmd.momentId);
      case "new_game":
        return this.newGame(cmd.settings);
      case "start_problem":
        return this.startProblem(cmd.problemId);
      case "tag":
        return this.tag(cmd.gameId, cmd.moveNumber, cmd.category, cmd.note);
      // Drawings go on the problem in problem mode, else on the game. They are checked before the
      // tutor engages a moment, so a typo doesn't cancel the fallback.
      case "show": {
        const variation = this.practice ? this.practice.variation(cmd.moves, cmd.start, cmd.label) : this.variationFrom(cmd.moves, cmd.start, cmd.label);
        if (!this.practice) this.engage();
        this.activeOverlay = { ...this.activeOverlay, variation };
        return this.changed();
      }
      case "mark": {
        const size = this.practice ? this.practice.problem.size : this.requireGame().settings.size;
        const marks = markPoints(cmd.points, size, cmd.kind ?? "circle", cmd.text);
        if (!this.practice) this.engage();
        this.activeOverlay = { ...this.activeOverlay, marks: [...(this.activeOverlay?.marks ?? []), ...marks] };
        return this.changed();
      }
      case "clear":
        this.activeOverlay = null;
        return this.changed();
    }
    if (this.practice) return this.practice.handleTutor(cmd);
    switch (cmd.type) {
      case "say":
        this.engage(cmd.momentId);
        this.addChat("tutor", cmd.text, cmd.momentId ?? this.activeMoment()?.id);
        return this.changed();
      case "rethink": {
        const moment = this.rethinkMoment(cmd.momentId);
        this.engage(moment.id);
        this.retry(cmd.text, moment.id);
        return;
      }
      case "resume":
        return this.continueGame();
    }
  }

  /** The overlay on the board: the problem's in problem mode, else the game's. */
  private get activeOverlay(): Overlay | null {
    return this.practice ? this.practice.overlay : this.overlay;
  }

  private set activeOverlay(overlay: Overlay | null) {
    if (this.practice) this.practice.overlay = overlay;
    else this.overlay = overlay;
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
      `New game: ${settings.size}×${settings.size}, you play ${colorName(settings.humanColor)} against a ${settings.botRank} bot (komi ${settings.komi}${handicap}).${why}`,
    );
    this.saveNow(); // on disk at once, so `last` finds it and the next game's id can't collide
    if (this.engineState === "ready") void this.prefetch();
    this.maybeBotMove();
    this.changed();
  }

  private resetGameState(): void {
    this.invalidatePending();
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
  }

  /** Drop what is in flight for the current position: stale engine replies, the eval the bot waits for, the moment's wait. */
  private invalidatePending(): void {
    this.gen++;
    this.evaluating = null;
    this.cancelMomentTimer();
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
    if (this.moment) this.setMomentState("resolved");
    this.cancelMomentTimer();
    this.overlay = null;
    this.emit({ type: "move", gameId: this.gameId!, size: game.size, record, by: "human" });
    this.save();

    if (game.isOver) {
      // The bot passed and so did the human: nothing left to evaluate.
      void this.finishByScore();
    } else {
      void this.evaluateHumanMove(record);
    }
    this.changed();
  }

  /**
   * KataGo's verdict on a human move, from the analyses of the positions before and after it
   * (with ownership, so a mistake is categorized at once). A mistake opens a teaching moment;
   * otherwise the bot replies.
   */
  private async evaluateHumanMove(record: MoveRecord): Promise<void> {
    const gen = this.gen;
    const game = this.game!;
    const movesBefore = game.moves.slice(0, record.number - 1).map((r) => r.move);
    this.evaluating = record;
    try {
      const [before, after] = await this.busyWhile(Promise.all([this.analysisOf(movesBefore), this.analysisOf([...movesBefore, record.move])]));
      if (!this.isCurrent(gen, record)) return;
      record.eval = moveEvalFrom(before, after, moveGtp(record.move, game.size));
      if (record.eval.pointLoss >= this.profile.mistakeThreshold) {
        try {
          this.heuristics[record.number] = this.classify(record, before, after);
        } catch (err) {
          // Only the category is lost; game end classifies the move again.
          this.log(`classifying move ${record.number} failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      if (!this.isCurrent(gen, record)) return;
      this.system(`KataGo couldn't evaluate that move (${(err as Error).message}). Playing on without feedback.`);
    } finally {
      if (this.evaluating === record) this.evaluating = null;
    }
    this.save();
    const loss = record.eval?.pointLoss;
    // The moment opens now, or once the learner is back from a practice problem.
    if (loss !== undefined && loss >= this.profile.mistakeThreshold) this.resumeTurn();
    else this.maybeBotMove();
    this.changed();
  }

  private isCurrent(gen: number, record?: MoveRecord): boolean {
    return this.gen === gen && !!this.game && (!record || this.game.lastMove === record);
  }

  // --- teaching moments --------------------------------------------------------------

  private startMoment(record: MoveRecord): void {
    const game = this.game!;
    if (this.result) return;
    this.momentShown.add(record);
    const before = game.before(record.number);
    this.moment = {
      id: `${record.number}-${randomBytes(2).toString("hex")}`,
      moveNumber: record.number,
      pointLoss: round1(record.eval!.pointLoss),
      state: "waiting",
      ...(this.tutorAttached && { deadline: this.clock.now() + this.tutorTimeoutMs }),
    };
    this.status = "paused";
    this.emit({
      type: "teaching_moment",
      gameId: this.gameId!,
      size: game.size,
      moment: { ...this.moment },
      record,
      boardBefore: toAscii(before.board, movePoint(before.lastMove?.move)),
      boardAfter: toAscii(game.board, this.lastPoint()),
    });
    this.save();
    this.settleWaitingMoment();
  }

  /**
   * A waiting moment whose wait isn't running: it just opened, the tutor's time ran out, or the
   * tutor left (or came back). An attached tutor gets a wait unless the time ran out; otherwise
   * KataGo answers, except on a practice problem, where its "Press Continue" would land on the
   * problem screen: there it waits for Back to playing. Returns whether there was such a moment.
   * `timedOut` is set when the wait's own timer fired: that is the expiry, even if the clock reads
   * a moment before the deadline (Node timers can fire a millisecond early).
   */
  private settleWaitingMoment(timedOut = false): boolean {
    const m = this.moment;
    if (m?.state !== "waiting" || this.momentTimer !== null) return false;
    const expired = timedOut || (m.deadline !== undefined && m.deadline <= this.clock.now());
    if (this.tutorAttached && !expired) this.waitForTutor();
    else if (!this.practice) this.applyFallback();
    return true;
  }

  /** Give the attached tutor `tutorTimeoutMs` to take the waiting moment before KataGo answers. */
  private waitForTutor(): void {
    const moment = this.moment;
    if (!moment) return;
    this.cancelMomentTimer();
    this.setMomentState("waiting", this.clock.now() + this.tutorTimeoutMs);
    this.momentTimer = this.clock.setTimeout(() => {
      this.momentTimer = null;
      if (this.moment?.id !== moment.id) return;
      this.settleWaitingMoment(true);
      this.changed();
    }, this.tutorTimeoutMs);
  }

  /** KataGo answers instead of the tutor: best move and its line on the board, plus plain words. */
  private applyFallback(): void {
    const moment = this.moment;
    const game = this.game;
    if (!moment || !game) return;
    this.cancelMomentTimer();
    this.setMomentState("fallback");
    const record = game.moves[moment.moveNumber - 1];
    const evaluation = record?.eval;
    if (record && evaluation) {
      const played = moveGtp(record.move, game.size);
      // KataGo's line is an alternative to the move, so it is drawn on the board from before it,
      // with the move actually played marked so the learner can find it.
      const moves = lineStones(game.before(record.number), evaluation.bestPv, PV_STONES);
      const playedPoint = movePoint(record.move);
      const marks: NonNullable<Overlay["marks"]> = playedPoint && !moves.some((m) => samePoint(m.point, playedPoint)) ? [{ point: playedPoint, kind: "x" }] : [];
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

  /** The moment's new state. Only a waiting moment has a deadline, and only when one is given. */
  private setMomentState(state: TeachingMoment["state"], deadline?: number): void {
    if (!this.moment) return;
    const { deadline: _old, ...rest } = this.moment;
    this.moment = { ...rest, state, ...(state === "waiting" && deadline !== undefined && { deadline }) };
  }

  private activeMoment(): TeachingMoment | null {
    return this.moment && this.moment.state !== "resolved" ? this.moment : null;
  }

  /** A tutor command about the current moment: the tutor has it, so stop the fallback clock. */
  private engage(momentId?: string): void {
    const m = this.moment;
    if (!m || (momentId && momentId !== m.id)) return;
    if (m.state !== "waiting" && m.state !== "fallback") return;
    this.cancelMomentTimer();
    this.setMomentState("tutor");
  }

  private claim(momentId: string): void {
    const m = this.activeMoment();
    if (!m) throw new UserError(`There is no open teaching moment to claim (asked for ${momentId}).`);
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
    if (this.activeMoment()) this.setMomentState("resolved");
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
    const m = this.activeMoment();
    if (!m || this.result) {
      throw new UserError("There is no open teaching moment to rethink. Use say to comment on other moves.");
    }
    if (momentId && momentId !== m.id) throw new UserError(`Moment ${momentId} is not current; the open moment is ${m.id}.`);
    if (game.lastMove?.number !== m.moveNumber) {
      throw new UserError(`Move ${m.moveNumber} of moment ${m.id} is already taken back; wait for the learner's new move.`);
    }
    return m;
  }

  /** Why Try again can't take a move back now, or null when it can. */
  /** How many of the last moves Try again takes back (the human's last move and any reply), or why it can't. */
  private movesToTakeBack(): number | string {
    const { game, settings } = this;
    switch (retryBlocked(this.actionState())) {
      case "no_game":
        return "No game in progress. Start a new game first.";
      case "finished":
        return ILLEGAL_TEXT.game_over;
      case "taken_back":
        return "That move is already taken back. Play a new one.";
      case "no_move":
        return "There is no move of yours to take back.";
    }
    const moves = game!.moves;
    let lastHuman = moves.length - 1;
    while (moves[lastHuman]!.move.color !== settings!.humanColor) lastHuman--;
    return moves.length - lastHuman;
  }

  /**
   * Take back the human's last move (and the bot's reply, if it came). From the browser's
   * Try again (text null) the moment is over; from the tutor's rethink the moment stays with the
   * tutor until the human plays again.
   */
  private retry(text: string | null, momentId?: string): void {
    const count = this.movesToTakeBack();
    if (typeof count === "string") throw new UserError(count);
    const { game } = this.requireGame();
    this.invalidatePending();
    game.undo(count);
    this.dropTagsAfter(game.moves.length);
    this.status = "playing";
    this.overlay = null;
    if (this.moment) this.setMomentState(text === null ? "resolved" : "tutor");
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
    this.updateProfile((profile) => {
      for (const n of dropped) {
        const { category } = this.tags[n]!;
        profile.mistakeCounts[category] = Math.max(0, profile.mistakeCounts[category] - 1);
        delete this.tags[n];
      }
      profile.recentMistakes = profile.recentMistakes.filter((m) => m.gameId !== this.gameId || m.moveNumber <= moveCount);
    });
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
      [gtp] = await this.busyWhile(Promise.all([choose(), this.sleep(this.botDelayMs)]));
    } catch (err) {
      failure = err as Error;
    } finally {
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
    const color = opponent(settings.humanColor);
    let point = gtp === "pass" ? null : tryFromGtp(gtp, settings.size);
    if (point === undefined || (point && !game.isLegal(point, color))) {
      this.log(`bot chose an illegal move ${gtp}; passing instead`);
      point = null;
    }
    const result = game.play(point ? { color, point } : { color, pass: true });
    if (!result.ok) return; // only possible if the game state changed under us, which gen rules out
    this.emit({ type: "move", gameId: this.gameId!, size: game.size, record: result.record, by: "bot" });
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
    if (text?.trim()) this.addChat("user", text.trim(), this.activeMoment()?.id);
    this.emit({
      type: "hint_request",
      gameId: this.gameId!,
      size: game.size,
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
    try {
      const analysis = await this.busyWhile(this.analysisOf(game.moves.map((r) => r.move)));
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
    }
  }

  private userChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) throw new UserError("Type a message first.");
    // On a practice problem the message is about the problem, not the game waiting underneath.
    const problemId = this.practice?.problem.id;
    const momentId = problemId ? undefined : this.activeMoment()?.id;
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
    const m = this.moment;
    const mover = m ? game.moves[m.moveNumber - 1]?.move.color : undefined;
    const color = start ?? mover ?? game.toPlay;
    const onBoard = m && m.state !== "resolved" && game.lastMove?.number === m.moveNumber;
    const fromMove = onBoard && color === mover ? m.moveNumber : undefined;
    return { moves: alternatingStones(moves, color, settings.size), ...(label && { label }), ...(fromMove !== undefined && { fromMove }) };
  }

  // --- game end ------------------------------------------------------------------------

  private resign(): void {
    const { settings } = this.requireGame();
    if (this.result) throw new UserError("The game is already over.");
    this.finish({ winner: opponent(settings.humanColor), margin: 0, reason: "resign" });
  }

  private async finishByScore(): Promise<void> {
    const game = this.game!;
    const settings = this.settings!;
    const gen = this.gen;
    const board = game.board;
    // KataGo's Chinese rules give White one point per handicap stone.
    const komi = settings.komi + (settings.handicap >= 2 ? settings.handicap : 0);
    let dead: Point[] = [];
    try {
      const analysis = await this.busyWhile(this.analysisOf(game.moves.map((r) => r.move)));
      if (analysis.ownership) dead = deadStonesFromOwnership(board, analysis.ownership);
    } catch (err) {
      if (this.isCurrent(gen)) this.system(`KataGo couldn't judge dead stones (${(err as Error).message}); counting every stone as alive.`);
    }
    if (!this.isCurrent(gen) || this.result) return;
    const score = scoreArea(board, komi, dead);
    this.finish({ winner: score.winner, margin: score.margin, reason: "score" }, score.dead.length);
  }

  private finish(result: GameResult, deadCount = 0): void {
    const settings = this.settings!;
    this.invalidatePending();
    this.result = result;
    this.status = "finished";
    this.moment = null;
    this.overlay = null;
    const summary = this.buildSummary();
    this.summary = summary;
    // The game must still be saved and announced if the profile can't be updated.
    try {
      summary.rating = this.updateProfileAfterGame(result, summary);
    } catch (err) {
      this.log(`updating the profile after game ${this.gameId} failed: ${(err as Error).message}`);
    }
    const dead = deadCount ? ` (${plural(deadCount, "dead stone")} removed)` : "";
    this.system(`Game over: ${formatScore(result, settings.humanColor)}${dead}.`);
    this.saveNow();
    const gameId = this.gameId!;
    this.emit({ type: "game_end", gameId, result, summary });
    this.changed();
    this.makeProblems(gameId, settings, this.game!.moves, summary);
  }

  /** In the background, each mistake of the finished game becomes a practice problem (problems.ts). */
  private makeProblems(gameId: string, settings: GameSettings, moves: MoveRecord[], summary: GameSummary): void {
    generateProblems(
      { gameId, settings, moves, summary },
      {
        analyze: (position, opts) => (this.engineState === "ready" ? this.engine.analyze(position, opts) : null),
        concurrency: this.engine.concurrency ?? 1,
        now: () => this.clock.now(),
        log: (msg) => this.log(msg),
        // The current game's summary is the object `tag` updates; a saved game's lives on disk.
        currentSummary: () => (gameId === this.gameId ? this.summary : this.store.loadGame(gameId)?.summary),
        updateProblems: (change) => this.updateProblems(change),
      },
    ).then(
      (added) => {
        if (added.length === 0) return;
        this.log(`practice problems from ${gameId}: ${added.map((p) => p.id).join(", ")}`);
        if (this.gameId === gameId && !this.practice) {
          this.system(`${added.length === 1 ? "One of your mistakes is" : `${added.length} of your mistakes are`} now a practice problem. Press Practice to try ${added.length === 1 ? "it" : "them"}.`);
        }
      },
      (err: unknown) => this.log(`making practice problems from ${gameId} failed: ${(err as Error).message}`),
    );
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
        // A mistake evaluated before this boot (or below the threshold back then) is classified now, without ownership.
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
    const replay = this.game!.before(record.number);
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
  private classifyOrOther(record: MoveRecord): MistakeCategory {
    try {
      return this.classify(record);
    } catch (err) {
      this.log(`classifying move ${record.number} failed: ${(err as Error).message}`);
      return "other";
    }
  }

  /** Rating, next bot, heuristic mistake tallies and the threshold, from the finished game. */
  private updateProfileAfterGame(result: GameResult, summary: GameSummary): GameSummary["rating"] {
    const update = this.updateProfile((profile) =>
      applyGame(profile, {
        gameId: this.gameId!,
        ts: this.clock.now(),
        settings: this.settings!,
        result,
        moves: this.game!.moves,
        summary,
        threshold: this.profile.mistakeThreshold,
      }),
    );
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
      throw new UserError(`Move ${moveNumber} was the bot's. Tag the learner's moves (${colorName(humanColor)}).`);
    }
    const tags = saved ? (saved.tags ??= {}) : this.tags;
    const summary = saved ? saved.summary : this.summary;
    const entry = summary?.mistakes.find((m) => m.moveNumber === moveNumber);
    // What the move counts as so far: an earlier tag, or the heuristic category counted at game end.
    const previous = tags[moveNumber]?.category ?? (entry?.categorySource === "heuristic" ? entry.category : undefined);
    tags[moveNumber] = { category, ...(note && { note }) };

    const pointLoss = round1(record.eval?.pointLoss ?? 0);
    this.updateProfile((profile) => applyTag(profile, { ts: this.clock.now(), gameId, moveNumber, category, pointLoss, ...(note && { note }) }, previous));

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
    const fromMove = (p: StoredProblem) => p.source?.gameId === gameId && p.source.moveNumber === moveNumber;
    // The problem may be on the board right now: its result and attempts count for the new category.
    if (this.practice && fromMove(this.practice.problem)) this.practice.retag(category);
    try {
      this.updateProblems((problems) => {
        const problem = problems.find(fromMove);
        if (!problem) return;
        problem.category = category;
        problem.prompt = promptFor(category, problem.toPlay);
      });
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
      const next = pickNextProblem(problems, { now: this.clock.now(), focus: recommendFocus(this.profile).category, exclude: this.lastProblemId });
      if (!next) throw new UserError("There are no practice problems yet.");
      ({ problem, early } = next);
    }
    const session = new PracticeSession(problem, this.practiceDeps); // checks the setup before the current problem closes
    // Leaving a problem after a wrong attempt reschedules it: the same problem again starts from its new box.
    const rescheduled = this.closePractice();
    if (rescheduled?.id === problem.id) Object.assign(session.problem, rescheduled);
    this.practice = session;
    this.lastProblemId = problem.id;
    session.start(early);
    this.changed();
  }

  /** Back to playing: the game (paused, finished or mid-turn) as it was, or the idle board. */
  private leaveProblem(): void {
    if (!this.practice) return;
    this.closePractice();
    this.resumeTurn();
    this.changed();
  }

  /** End problem mode. Returns the problem as rescheduled, when leaving it counted as a failure. */
  private closePractice(): StoredProblem | undefined {
    const session = this.practice;
    this.practice = null;
    return session?.close();
  }

  /** A problem ended: schedule it (Leitner box) and count it in the profile. Returns it as stored now. */
  private recordProblemResult(problem: StoredProblem, solved: boolean, attempts: number): StoredProblem | undefined {
    let stored: StoredProblem | undefined;
    try {
      stored = this.updateProblems((problems) => {
        const p = problems.find((q) => q.id === problem.id);
        if (p) schedule(p, resultOf(solved, attempts), this.clock.now());
        return p;
      });
    } catch (err) {
      this.log(`saving problem ${problem.id} failed: ${(err as Error).message}`);
    }
    try {
      this.updateProfile((profile) => applyProblemResult(profile, problem.category, solved));
    } catch (err) {
      this.log(`updating the profile after problem ${problem.id} failed: ${(err as Error).message}`);
    }
    return stored;
  }

  /** An attempt KataGo found as good as the answers becomes one. */
  private addProblemAnswer(id: string, move: Gtp): void {
    try {
      this.updateProblems((problems) => {
        const p = problems.find((q) => q.id === id);
        if (p && !p.answers.includes(move)) p.answers = [...p.answers, move];
      });
    } catch (err) {
      this.log(`saving problem ${id} failed: ${(err as Error).message}`);
    }
  }

  // --- persistence -----------------------------------------------------------------

  /** Load the profile, change it, save it, and make it the current one. Returns what `change` returns. */
  private updateProfile<T>(change: (profile: Profile) => T): T {
    const profile = this.store.loadProfile();
    const result = change(profile);
    this.store.saveProfile(profile);
    this.profile = profile;
    this.profileVersion++;
    return result;
  }

  /** Load the stored problems, change them, save them. Returns what `change` returns. */
  private updateProblems<T>(change: (problems: StoredProblem[]) => T): T {
    const problems = this.store.loadProblems();
    const result = change(problems);
    this.store.saveProblems(problems);
    return result;
  }

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
   * Cached analysis of the position after `moves`, with KataGo's ownership (it costs only network
   * output, not search), so one query serves move evals and mistake categories, the bot's pass
   * check, hints and scoring. The cache keeps the ANALYSIS_CACHE_SIZE most recently used positions.
   */
  private analysisOf(moves: Move[]): Promise<Analysis> {
    const pos = this.position(moves);
    const key = pos.moves.map((m) => m[1]).join(" ");
    const cached = this.analyses.get(key);
    if (cached) {
      this.analyses.delete(key);
      this.analyses.set(key, cached);
      return cached;
    }
    const pending = this.engine.analyze(pos, { includeOwnership: true, ...(this.analysisVisits !== undefined && { maxVisits: this.analysisVisits }) });
    this.analyses.set(key, pending);
    if (this.analyses.size > ANALYSIS_CACHE_SIZE) this.analyses.delete(this.analyses.keys().next().value!);
    pending.catch(() => {
      if (this.analyses.get(key) === pending) this.analyses.delete(key);
    });
    return pending;
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

  /** Runs `p` with the view showing KataGo as busy. */
  private async busyWhile<T>(p: Promise<T>): Promise<T> {
    this.busy++;
    this.changed();
    try {
      return await p;
    } finally {
      this.busy--;
      this.changed();
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
    return movePoint(this.game?.lastMove?.move);
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
