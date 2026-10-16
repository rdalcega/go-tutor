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
  Profile,
  TeachingMoment,
  TutorCommand,
  TutorEvent,
} from "../shared/types.ts";
import { moveEvalFrom, type Analysis, type AnalyzeOptions, type Engine, type Position } from "./katago.ts";
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

export type GameEngine = Pick<Engine, "analyze" | "botMove">;
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
  log?: (msg: string) => void;
}

export const DEFAULT_SETTINGS: Omit<GameSettings, "botRank"> = { size: 9, komi: 7, humanColor: "B", handicap: 0 };
const CHAT_LIMIT = 200;
const VIEW_CHAT_LIMIT = 100;
const FALLBACK_PV_LENGTH = 6;
const BOT_RETRIES = 3;

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
  private tutorAttached = false;
  private engineState: EngineState = "starting";

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
  }

  onEvent(fn: (e: TutorEventInput) => void): void {
    this.eventListeners.push(fn);
  }

  onChange(fn: () => void): void {
    this.changeListeners.push(fn);
  }

  // --- view ------------------------------------------------------------------

  view(): GameView {
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

  get currentProfile(): Profile {
    return this.profile;
  }

  // --- wiring from the bridge / index ------------------------------------------

  setTutorAttached(attached: boolean): void {
    if (attached === this.tutorAttached) return;
    this.tutorAttached = attached;
    // Nobody is left to answer a waiting moment.
    if (!attached && this.moment?.state === "waiting") this.applyFallback();
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
    switch (action.type) {
      case "new_game":
        return this.newGame(action.settings);
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
      case "chat":
        return this.userChat(action.text);
      case "ask_tutor":
        return this.hint(action.text);
      case "next_problem":
        throw new UserError("Practice problems aren't available yet.");
    }
  }

  // --- tutor commands -----------------------------------------------------------

  async handleTutor(cmd: TutorCommand): Promise<void> {
    switch (cmd.type) {
      case "say":
        this.engage(cmd.momentId);
        this.addChat("tutor", cmd.text, cmd.momentId ?? this.activeMomentId());
        return this.changed();
      case "rethink": {
        const moment = this.rethinkMoment(cmd.momentId);
        this.engage(moment.id);
        this.retry(cmd.text, moment.id);
        return;
      }
      // Validate the drawing before engaging, so a typo doesn't cancel the fallback.
      case "show": {
        const variation = this.variationFrom(cmd.moves, cmd.start, cmd.label);
        this.engage();
        this.overlay = { ...this.overlay, variation };
        return this.changed();
      }
      case "mark": {
        const marks = this.marksFrom(cmd.points, cmd.kind ?? "circle", cmd.text);
        this.engage();
        this.overlay = { ...this.overlay, marks: [...(this.overlay?.marks ?? []), ...marks] };
        return this.changed();
      }
      case "clear":
        this.overlay = null;
        return this.changed();
      case "resume":
        return this.continueGame();
      case "claim":
        return this.claim(cmd.momentId);
      case "new_game":
        return this.newGame(cmd.settings);
      case "start_problem":
        throw new UserError("Practice problems aren't available yet (Milestone 5).");
      case "tag":
        return this.tag(cmd.gameId, cmd.moveNumber, cmd.category, cmd.note);
    }
  }

  // --- game lifecycle ----------------------------------------------------------

  newGame(partial: Partial<GameSettings> = {}): void {
    const settings = this.validateSettings(partial);
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
    this.system(
      `New game: ${settings.size}×${settings.size}, you play ${settings.humanColor === "B" ? "Black" : "White"} against a ${settings.botRank} bot (komi ${settings.komi}${handicap}).`,
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
    this.status = "playing";
    this.botFailures = 0;
    this.evaluating = null;
  }

  private validateSettings(partial: Partial<GameSettings>): GameSettings {
    const size = partial.size ?? DEFAULT_SETTINGS.size;
    if (size !== 9 && size !== 13 && size !== 19) throw new UserError(`Board size must be 9, 13 or 19 (got ${String(size)}).`);
    const komi = partial.komi ?? DEFAULT_SETTINGS.komi;
    if (typeof komi !== "number" || !Number.isInteger(komi * 2) || Math.abs(komi) > 150) {
      throw new UserError("Komi must be a whole or half number, e.g. 7 or 6.5.");
    }
    const humanColor = partial.humanColor ?? DEFAULT_SETTINGS.humanColor;
    if (humanColor !== "B" && humanColor !== "W") throw new UserError('Color must be "B" or "W".');
    const handicap = partial.handicap ?? DEFAULT_SETTINGS.handicap;
    if (!Number.isInteger(handicap) || handicap < 0 || handicap > 9 || handicap === 1) {
      throw new UserError("Handicap must be 0 or 2–9 stones.");
    }
    let botRank: string;
    try {
      botRank = normalizeBotRank(partial.botRank ?? this.profile.botRank);
    } catch (err) {
      throw new UserError((err as Error).message);
    }
    return { size, komi, humanColor, botRank, handicap };
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
      record.eval = moveEvalFrom(before, after);
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
      this.startMoment(record);
    } else {
      this.maybeBotMove();
    }
    this.changed();
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
    if (waiting) {
      const id = this.moment.id;
      this.momentTimer = this.clock.setTimeout(() => {
        this.momentTimer = null;
        if (this.moment?.id === id && this.moment.state === "waiting") {
          this.applyFallback();
          this.changed();
        }
      }, this.tutorTimeoutMs);
    } else {
      this.applyFallback();
    }
  }

  /** KataGo answers instead of the tutor: best move and its line on the board, plus plain words. */
  private applyFallback(): void {
    const moment = this.moment;
    const game = this.game;
    if (!moment || !game || !this.settings) return;
    this.cancelMomentTimer();
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
    if (!game || !settings || this.result || this.status !== "playing") return;
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
    if (this.gen !== gen || this.game !== game || game.moves.length !== moveCount || this.status !== "playing") {
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
    const momentId = this.activeMomentId();
    this.addChat("user", trimmed, momentId);
    this.emit({ type: "user_message", text: trimmed, gameId: this.gameId, ...(momentId && { momentId }) });
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
    if (points.length === 0) throw new UserError("mark needs at least one point.");
    return points.map((gtp) => ({ point: this.parsePoint(gtp, settings.size, false)!, kind, ...(text && { text }) }));
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
      const analysis = await this.analysisOf(game.moves.map((r) => r.move), { includeOwnership: true });
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
    this.result = result;
    this.status = "finished";
    this.moment = null;
    this.overlay = null;
    this.summary = this.buildSummary();
    const dead = deadCount ? ` (${plural(deadCount, "dead stone")} removed)` : "";
    this.system(`Game over: ${formatScore(result, settings.humanColor)}${dead}.`);
    this.saveNow();
    this.updateProfileAfterGame(result);
    this.emit({ type: "game_end", gameId: this.gameId!, result, summary: this.summary });
    this.changed();
  }

  private buildSummary(): GameSummary {
    const game = this.game!;
    const settings = this.settings!;
    const human = game.moves.filter((r) => r.move.color === settings.humanColor && r.eval);
    const mistakes = human
      .filter((r) => r.eval!.pointLoss >= this.profile.mistakeThreshold)
      .sort((a, b) => b.eval!.pointLoss - a.eval!.pointLoss)
      .map((r) => {
        const category = this.tags[r.number]?.category;
        return {
          moveNumber: r.number,
          move: moveGtp(r.move, settings.size),
          pointLoss: round1(r.eval!.pointLoss),
          bestMove: r.eval!.bestMove,
          ...(category && { category }),
        };
      });
    const total = human.reduce((sum, r) => sum + r.eval!.pointLoss, 0);
    return { moves: game.moves.length, mistakes, totalPointLoss: round1(total) };
  }

  /** Minimal for now: count the game and record the rating; adaptation arrives with profile.ts. */
  private updateProfileAfterGame(result: GameResult): void {
    const settings = this.settings!;
    const profile = this.store.loadProfile();
    profile.gamesPlayed++;
    profile.ratingHistory.push({
      ts: this.clock.now(),
      gameId: this.gameId!,
      rating: profile.rating,
      botRank: settings.botRank,
      won: result.winner === settings.humanColor,
    });
    this.store.saveProfile(profile);
    this.profile = profile;
  }

  /** Tag a mistake with a category (current or saved game). Updates the summary and the profile tallies. */
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
    const previous = tags[moveNumber];
    tags[moveNumber] = { category, ...(note && { note }) };

    const profile = this.store.loadProfile();
    if (previous) profile.mistakeCounts[previous.category] = Math.max(0, profile.mistakeCounts[previous.category] - 1);
    profile.mistakeCounts[category]++;
    profile.recentMistakes = [
      { ts: this.clock.now(), gameId, moveNumber, category, pointLoss: round1(record.eval?.pointLoss ?? 0), ...(note && { note }) },
      ...profile.recentMistakes.filter((m) => m.gameId !== gameId || m.moveNumber !== moveNumber),
    ].slice(0, 50);
    this.store.saveProfile(profile);
    this.profile = profile;

    if (saved) {
      const entry = saved.summary?.mistakes.find((m) => m.moveNumber === moveNumber);
      if (entry) entry.category = category;
      this.store.saveGame({ ...saved, updatedAt: this.clock.now() }, this.sgfFor(saved.settings, saved.moves, saved.result, tags));
    } else {
      if (this.summary) this.summary = this.buildSummary();
      this.save();
    }
    this.changed();
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

  /** Cached analysis of the position after `moves` (ownership queries are cached separately). */
  private analysisOf(moves: Move[], extra: AnalyzeOptions = {}): Promise<Analysis> {
    const pos = this.position(moves);
    const key = `${extra.includeOwnership ? "own:" : ""}${pos.moves.map((m) => m[1]).join(" ")}`;
    let pending = this.analyses.get(key);
    if (!pending) {
      const opts: AnalyzeOptions = { ...extra, ...(this.analysisVisits !== undefined && { maxVisits: this.analysisVisits }) };
      pending = this.engine.analyze(pos, opts);
      this.analyses.set(key, pending);
      pending.catch(() => this.analyses.delete(key));
    }
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

