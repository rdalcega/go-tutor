// Problem mode: one practice problem on the board, judged against KataGo, while any game waits
// underneath in the GameController (game.ts), which starts and ends sessions, keeps the chat and
// writes the problem's progress and the profile. Once a problem is answered the learner can play it
// out against full-strength KataGo (Playout): unjudged, unrecorded, and kept out of the tutor's stream.

import { toAscii, type GoGame } from "../engine/index.ts";
import type { PlayoutState } from "../shared/allowed.ts";
import { samePoint, toGtp, tryFromGtp } from "../shared/coords.ts";
import { plural, round1 } from "../shared/text.ts";
import { sizeText } from "../shared/threshold.ts";
import type { ClientAction, Color, GameSettings, GameView, Gtp, LessonInfo, Overlay, Point, ProblemAttempt, ProblemReview, RecentMove, TutorCommand } from "../shared/types.ts";
import { ILLEGAL_TEXT, PV_STONES, UserError, alternatingStones, lineStones, type TutorEventInput } from "./common.ts";
import { moveEvalFrom, trustedCandidate, type Analysis, type Engine } from "./katago.ts";
import { ANSWER_MARGIN, MAX_ATTEMPTS, gameSource, generatedInfo, problemGame, problemPosition, promptFor, recentMovesView, type StoredProblem } from "./problems.ts";

/** Moves of the follow-up drawn after a correct answer: the answer, the opponent's best reply, the next move. */
const ANSWER_LINE_LENGTH = 3;

/** What the tutor is told when it tries to comment on a problem being played out. */
export const PLAYOUT_REFUSAL =
  "The learner is playing the answered problem out against full-strength KataGo: nothing is judged and you don't comment on it. Only a chat message (or the result you hadn't answered when they started) gets one say.";

/** A say about the game's open moment waiting under the problem (not just any moment id). */
function aboutGame(cmd: TutorCommand, gameMomentId: string | undefined): boolean {
  return cmd.type === "say" && !!cmd.momentId && cmd.momentId === gameMomentId;
}

/**
 * Playing an answered problem out against KataGo. One line, no branches: playing a move after
 * stepping back drops the moves that were ahead. KataGo's side answers by itself whenever a move
 * leaves it to play; only stepping back onto its turn waits, so the learner can look at that position.
 */
interface Playout {
  /** The whole line from the problem position, the learner first, moves ahead of the cursor included. */
  line: Gtp[];
  /** Moves of `line` on the board (0: the problem position). */
  cursor: number;
  /** The rules engine at the cursor: the problem position plus line[0..cursor), so ko and passes count from the problem. */
  game: GoGame;
  /** Bumped by every step, play and exit: KataGo's answer for an older one is dropped. */
  gen: number;
  /** KataGo is choosing a move. */
  thinking: boolean;
  /** Cancels KataGo's search for the move being chosen, once nobody wants it. */
  abort: AbortController | null;
}

/**
 * KataGo's move in a play-out: its best candidate that is legal here (its rules can disagree with
 * ours on a repeated position), or a pass when it prefers one or none is legal.
 */
export function playoutMove(analysis: Pick<Analysis, "moveInfos">, game: GoGame): Gtp {
  for (const info of analysis.moveInfos) {
    if (info.move === "pass") return "pass";
    const point = tryFromGtp(info.move, game.size);
    if (point && game.isLegal(point)) return info.move;
  }
  return "pass";
}

function withoutAnswer(lesson: LessonInfo): LessonInfo {
  const { answer: _, ...rest } = lesson;
  return rest;
}

/** What a session needs from the controller. */
export interface PracticeDeps {
  engine: Pick<Engine, "analyze">;
  /** Visits for checking an attempt. */
  problemVisits: number;
  /** Why KataGo can't check a move right now, or null when it can. */
  engineNotReady(): string | null;
  system(text: string): void;
  /** A tutor's chat message. */
  say(text: string, momentId?: string): void;
  emit(event: TutorEventInput): void;
  changed(): void;
  /** Runs `p` with the view showing KataGo as busy. */
  busyWhile<T>(p: Promise<T>): Promise<T>;
  /** KataGo found a new move as good as the answers: keep it with the problem. */
  addAnswer(problemId: string, move: Gtp): void;
  /** The problem is over: schedule it and count it in the profile. Returns the problem as stored now. */
  recordResult(problem: StoredProblem, solved: boolean, attempts: number): StoredProblem | undefined;
}

/** The practice problem on the board. The problem's stored progress is the controller's to write. */
export class PracticeSession {
  /** The problem as it was when the session started (its box is the one shown). */
  readonly problem: StoredProblem;
  /** The rules engine at the problem position (it never changes; attempts are checked on copies). */
  private readonly game: GoGame;
  overlay: Overlay | null = null;
  private attempts = 0;
  /** An attempt is with KataGo. */
  private checking = false;
  private lastAttempt: ProblemAttempt | undefined;
  /** KataGo's best move and line, once the problem is over. */
  private answer: { move: Gtp; pv: Gtp[] } | undefined;
  /** When the problem is due again, once its result is recorded. */
  private nextDue: number | undefined;
  private closed = false;
  /** Analyses of the problem position (key "") and after each attempt (key = the move). */
  private readonly analyses = new Map<string, Promise<Analysis>>();
  /** The last moves before the position that the board labels (the position never changes). */
  private readonly recentMoves: RecentMove[] | undefined;
  /** The answer's line as drawn when the problem was revealed: a play-out starts with it ahead. */
  private answerLine: Gtp[] = [];
  /** The learner is playing the answered problem out. */
  private playout: Playout | null = null;
  /** The drawing the reveal left on the board, put back when the play-out ends. */
  private answerOverlay: Overlay | null = null;
  /**
   * The tutor hasn't answered the reveal or the learner's latest chat yet: during a play-out that is
   * the one say it may still send (a reply that crossed the learner's Play it out, or to their chat).
   */
  private tutorOwed = false;

  /** The problem's place in a review of one game's mistakes. */
  private readonly review: ProblemReview | undefined;
  /** The problem's lesson, when it is one variant of several (as it was when the session started). */
  private readonly lesson: LessonInfo | undefined;

  /**
   * Throws a UserError when the problem can't be set up. `review`: the problem's place in a review of
   * one game's mistakes; `lesson`: its lesson (lessonInfo), shown with it.
   */
  constructor(
    problem: StoredProblem,
    private readonly deps: PracticeDeps,
    opts: { review?: ProblemReview; lesson?: LessonInfo } = {},
  ) {
    this.problem = problem;
    this.review = opts.review;
    this.lesson = opts.lesson;
    try {
      this.game = problemGame(problem);
    } catch (err) {
      throw new UserError(`Problem ${problem.id} can't be set up: ${(err as Error).message}`);
    }
    this.recentMoves = recentMovesView(problem, this.game.board);
  }

  /** Solved, or out of attempts: the answer is shown and the board is locked. */
  get revealed(): boolean {
    return this.answer !== undefined;
  }

  get solved(): boolean {
    return this.lastAttempt?.correct === true;
  }

  /** The learner is playing the answered problem out against KataGo: nothing about it is the tutor's. */
  get playingOut(): boolean {
    return this.playout !== null;
  }

  /** Put the problem on the board: tell the learner and the tutor, and let KataGo read the position. */
  start(early: boolean): void {
    const { problem } = this;
    const source = gameSource(problem);
    const generated = generatedInfo(problem);
    const firstTry = source?.takenBack !== undefined ? ", your first try before the take-back" : "";
    const from = source
      ? ` from your game ${source.gameId} (move ${source.moveNumber}${firstTry})`
      : generated
        ? ` on ${sizeText(problem.size)} (about ${generated.difficultyRank} level)`
        : "";
    const what = this.review ? `Review ${this.review.index}/${this.review.total}, mistake` : "Practice problem";
    this.deps.system(`${what}${from}: ${problem.prompt}${early ? " (Nothing is due right now, so this is an early review.)" : ""}`);
    this.deps.emit({
      type: "problem_start",
      problemId: problem.id,
      kind: problem.kind,
      category: problem.category,
      toPlay: problem.toPlay,
      prompt: problem.prompt,
      answers: [...problem.answers],
      box: problem.box,
      size: problem.size,
      ...(source && { source: { gameId: source.gameId, moveNumber: source.moveNumber } }),
      ...(generated && { generated }),
      ...(this.review && { review: { ...this.review } }),
      ...(this.lesson && { lesson: { ...this.lesson } }),
      board: toAscii(this.game.board, null),
    });
    if (this.deps.engineNotReady() === null) this.analysis([]).catch(() => {});
  }

  /**
   * End the session. A problem left unfinished after a wrong attempt counts as failed (box 1); one
   * left before any judged attempt keeps its schedule. Returns the problem as rescheduled, if it was.
   */
  close(): StoredProblem | undefined {
    this.closed = true;
    if (this.playout) this.cancelRequest(this.playout);
    this.playout = null;
    // Unrevealed means unsolved, so any judged attempt was wrong.
    if (this.revealed || !this.lastAttempt) return undefined;
    return this.deps.recordResult(this.problem, false, this.attempts);
  }

  /** A tag changed what the mistake behind this problem was about: this showing counts for the new category. */
  retag(category: StoredProblem["category"]): void {
    this.problem.category = category;
    this.problem.prompt = promptFor(category, this.problem.toPlay);
  }

  /** The browser's game actions while a problem is on the board: only a stone counts as an answer. */
  handleAction(
    action: Extract<
      ClientAction,
      { type: "play" | "pass" | "resign" | "continue" | "retry" | "take_back" | "ask_tutor" | "playout_start" | "playout_back" | "playout_forward" | "playout_exit" }
    >,
  ): void {
    switch (action.type) {
      case "playout_start":
        return this.startPlayout();
      case "playout_back":
        return this.stepBack();
      case "playout_forward":
        return this.stepForward();
      case "playout_exit":
        return this.exitPlayout();
    }
    if (this.playout) return this.playoutAction(this.playout, action);
    switch (action.type) {
      case "play":
        return this.play(action.point);
      case "pass":
        throw new UserError("In a problem, answer by playing a stone on the board.");
      case "resign":
        throw new UserError("You're on a practice problem. Press Back to playing to return to your game first.");
      case "continue":
        return; // Enter on the problem screen: nothing to continue
      case "retry":
      case "take_back":
        throw new UserError("Taking moves back is for games. In a problem, just play another move while you have attempts left.");
      case "ask_tutor":
        throw new UserError("Hints are for games. In a problem, ask your tutor in the chat.");
    }
  }

  /** The tutor's moment commands while a problem is on the board (drawing is the controller's). */
  handleTutor(cmd: Extract<TutorCommand, { type: "say" | "rethink" | "resume" }>): void {
    switch (cmd.type) {
      case "say":
        return this.deps.say(cmd.text, cmd.momentId);
      case "rethink":
        throw new UserError("The learner is on a practice problem; rethink is for games. Use say, show or mark.");
      case "resume":
        return; // the game stays paused underneath until the learner goes back to it
    }
  }

  /** A tutor's `show`: always from the problem position, the learner's color first by default. */
  variation(moves: Gtp[], start: Color | undefined, label: string | undefined): NonNullable<Overlay["variation"]> {
    return { moves: alternatingStones(moves, start ?? this.problem.toPlay, this.problem.size), ...(label && { label }) };
  }

  /**
   * The rule that keeps the tutor out of a play-out, checked before any tutor command runs. A show
   * or mark isn't drawn (false: it is skipped, not refused, so the say chained after it still goes,
   * and the command's output says it wasn't drawn); a say about the problem goes only when a reply
   * is owed (the result's, or the learner's chat). A say about the game moment waiting underneath
   * (`gameMomentId`, the open one) is the game's; any other moment id counts as a say about the problem.
   */
  admitTutor(cmd: TutorCommand, gameMomentId: string | undefined): boolean {
    if (!this.playout) return true;
    if (cmd.type === "show" || cmd.type === "mark") return false;
    if (cmd.type === "say" && !aboutGame(cmd, gameMomentId) && !this.tutorOwed) throw new UserError(PLAYOUT_REFUSAL);
    return true;
  }

  /** The tutor said or drew something: an answer about the problem (not a say about the game's moment) settles what it owed. */
  tutorAnswered(cmd: TutorCommand, gameMomentId: string | undefined): void {
    if (cmd.type === "show" || cmd.type === "mark" || (cmd.type === "say" && !aboutGame(cmd, gameMomentId))) this.tutorOwed = false;
  }

  /** The learner chatted about the problem: the tutor owes an answer (also one it reads later, from a replay). */
  questionAsked(): void {
    this.tutorOwed = true;
  }

  /** What the shared allowed-actions rules read of the problem. */
  get actionState(): { revealed: boolean; checking: boolean; playout: PlayoutState | null } {
    const po = this.playout;
    return {
      revealed: this.revealed,
      checking: this.checking,
      playout: po && {
        cursor: po.cursor,
        length: po.line.length,
        thinking: po.thinking,
        learnerToPlay: po.game.toPlay === this.problem.toPlay,
        over: po.game.isOver,
      },
    };
  }

  view(common: Pick<GameView, "chat" | "tutorAttached" | "tutorLevel" | "judgeMode" | "engineBusy" | "profileVersion" | "allowed" | "mistakeThreshold" | "generation">, botRank: string): GameView {
    const { problem } = this;
    const source = gameSource(problem);
    const generated = generatedInfo(problem);
    // Playing out, the board is the play-out's position; its moves carry no evaluation.
    const po = this.playout;
    const game = po?.game ?? this.game;
    return {
      gameId: null,
      mode: "problem",
      settings: { size: problem.size as GameSettings["size"], komi: problem.komi, humanColor: problem.toPlay, botRank, handicap: 0 },
      status: this.revealed ? "finished" : "playing",
      board: game.board,
      toPlay: game.toPlay,
      moves: po ? po.game.moves : [],
      captures: game.captures,
      result: null,
      moment: null,
      overlay: this.overlay,
      ...common,
      engineBusy: common.engineBusy || this.checking || (po?.thinking ?? false),
      problem: {
        id: problem.id,
        prompt: problem.prompt,
        ...(source && { source: { gameId: source.gameId, moveNumber: source.moveNumber } }),
        ...(generated && { generated }),
        attempts: this.attempts,
        solved: this.solved,
        kind: problem.kind,
        category: problem.category,
        toPlay: problem.toPlay,
        maxAttempts: MAX_ATTEMPTS,
        revealed: this.revealed,
        box: problem.box,
        ...(this.lastAttempt && { lastAttempt: { ...this.lastAttempt } }),
        ...(this.answer && { answer: { move: this.answer.move, pv: [...this.answer.pv] } }),
        ...(this.nextDue !== undefined && { nextDue: this.nextDue }),
        ...(this.recentMoves && { recentMoves: this.recentMoves }),
        ...(this.review && { review: { ...this.review } }),
        // The lesson's point is its answer: the browser gets it once the problem is over.
        ...(this.lesson && { lesson: this.revealed ? { ...this.lesson } : withoutAnswer(this.lesson) }),
        ...(po && { playout: { line: [...po.line], cursor: po.cursor, thinking: po.thinking, over: po.game.isOver, ...(this.tutorOwed && { replyOwed: true }) } }),
      },
    };
  }

  // --- playing the answered problem out ------------------------------------------------

  /**
   * Play the answered problem out: from the problem position, with the answer's line ahead (Forward
   * steps through it). The answer's drawing goes until the end, so ghost stones don't sit on real ones.
   */
  private startPlayout(): void {
    if (this.playout) return;
    if (!this.revealed) throw new UserError("Answer the problem first; then you can play it out.");
    if (this.checking) throw new UserError("KataGo is still checking your move.");
    const game = problemGame(this.problem);
    // The drawn line was legal from the problem position (lineStones checked it), so it replays.
    this.playout = { line: [...this.answerLine], cursor: 0, game, gen: 0, thinking: false, abort: null };
    this.answerOverlay = this.overlay;
    this.overlay = null;
    this.deps.system(
      "Playing it out: KataGo answers at full strength, and nothing here is judged. Play any move, or step through the moves with ◀ and ▶ (▶ at the end of the line lets KataGo move for you); KataGo answers every move by itself.",
    );
  }

  /** Back to the answered problem, with its drawing. */
  private exitPlayout(): void {
    const po = this.playout;
    if (!po) return;
    this.cancelRequest(po);
    this.playout = null;
    this.overlay = this.answerOverlay;
    this.answerOverlay = null;
    this.deps.changed();
  }

  /**
   * One move back. Also while KataGo thinks: its answer, for the position left, is dropped. Stepping
   * back over KataGo's move never replays it: the learner went back to look at that position.
   */
  private stepBack(): void {
    const po = this.requirePlayout();
    if (po.cursor === 0) throw new UserError("This is the problem position: there is nothing to step back to.");
    this.cancelRequest(po);
    po.game.undo(1);
    po.cursor--;
    this.deps.changed();
  }

  /** Drop the move KataGo may be choosing: its answer is ignored, and its search stops. */
  private cancelRequest(po: Playout): void {
    po.gen++;
    po.thinking = false;
    po.abort?.abort();
    po.abort = null;
  }

  /**
   * One move forward: the next move of the line, or at its end KataGo's move for the side to play.
   * A move that leaves KataGo to play has it answer.
   */
  private stepForward(): void {
    const po = this.requirePlayout();
    if (po.thinking) throw new UserError("KataGo is thinking.");
    if (po.cursor < po.line.length) {
      this.advance(po, po.line[po.cursor]!);
      po.gen++;
      this.autoAnswer(po);
      return this.deps.changed();
    }
    if (po.game.isOver) throw new UserError("Both sides passed. Step back with ◀ to play on from an earlier move.");
    const notReady = this.deps.engineNotReady();
    if (notReady) throw new UserError(notReady);
    void this.requestMove(po);
  }

  /** The learner's stone or pass in a play-out: it replaces the moves ahead, and KataGo answers it. */
  private playoutAction(po: Playout, action: Parameters<PracticeSession["handleAction"]>[0]): void {
    switch (action.type) {
      case "play":
      case "pass":
        break;
      case "continue":
        return;
      case "retry":
      case "take_back":
        throw new UserError("To take a move back here, step back with ◀.");
      case "resign":
        throw new UserError("You're playing a problem out. Press Back to playing to return to your game first.");
      case "ask_tutor":
        throw new UserError("Hints are for games. Ask your tutor in the chat.");
      default:
        return;
    }
    if (po.thinking) throw new UserError("KataGo is thinking.");
    if (po.game.isOver) throw new UserError("Both sides passed. Step back with ◀ to play on from an earlier move.");
    if (po.game.toPlay !== this.problem.toPlay) throw new UserError("It's KataGo's move: press ▶ to see it.");
    const point = action.type === "play" ? action.point : null;
    if (point) {
      const reason = po.game.illegalReason(point);
      if (reason) throw new UserError(ILLEGAL_TEXT[reason]);
    }
    const gtp = toGtp(point, this.problem.size);
    // The next move of the line itself just steps forward, keeping what follows it.
    const same = po.line[po.cursor] === gtp;
    // KataGo answers unless the line already goes on past this move.
    if (!same || po.cursor + 1 >= po.line.length) {
      const notReady = this.deps.engineNotReady();
      if (notReady) throw new UserError(notReady);
    }
    // Only a legal move replaces the moves that were ahead.
    if (!same) {
      po.line.length = po.cursor;
      po.line.push(gtp);
    }
    this.advance(po, gtp);
    po.gen++;
    this.autoAnswer(po);
    this.deps.changed();
  }

  private requirePlayout(): Playout {
    if (!this.playout) throw new UserError("Press Play it out first.");
    return this.playout;
  }

  /**
   * KataGo's side answers when a move left it to play (not after two passes): the line's next move
   * when it goes on, else a fresh request. Without KataGo ready, Forward asks for it later.
   */
  private autoAnswer(po: Playout): void {
    if (po.game.isOver || po.game.toPlay === this.problem.toPlay) return;
    if (po.cursor < po.line.length) {
      this.advance(po, po.line[po.cursor]!);
      po.gen++;
    } else if (!this.deps.engineNotReady()) {
      void this.requestMove(po);
    }
  }

  /** Play `gtp` (a move of the line, legal at the cursor) and move the cursor past it. */
  private advance(po: Playout, gtp: Gtp): void {
    const point = tryFromGtp(gtp, this.problem.size);
    const color = po.game.toPlay;
    const played = po.game.play(point ? { color, point } : { color, pass: true });
    if (!played.ok) throw new Error(`play-out move ${gtp} is illegal: ${played.reason}`);
    po.cursor++;
  }

  /**
   * KataGo's move for the side to play at the cursor, from the main net at full strength (never the
   * human-style bot). Nothing is judged, recorded or sent to the tutor. Every way out checks that
   * the play-out is still at this request (`gen`): a step, play or exit meanwhile drops the answer.
   */
  private async requestMove(po: Playout): Promise<void> {
    const gen = ++po.gen;
    const abort = new AbortController();
    po.abort = abort;
    po.thinking = true;
    this.deps.changed();
    const moves = po.line.slice(0, po.cursor);
    let analysis: Analysis | null = null;
    let failure: Error | null = null;
    try {
      analysis = await this.deps.busyWhile(this.playoutAnalysis(moves, abort.signal));
    } catch (err) {
      failure = err as Error;
    }
    if (this.closed || this.playout !== po || po.gen !== gen) return this.deps.changed();
    po.thinking = false;
    po.abort = null;
    if (!analysis) {
      this.deps.system(`KataGo couldn't answer (${failure?.message ?? "no answer"}). Press ▶ to try again.`);
      return this.deps.changed();
    }
    const move = playoutMove(analysis, po.game);
    po.line.length = po.cursor;
    po.line.push(move);
    this.advance(po, move);
    po.gen++;
    // KataGo moved for the learner (Forward at the end of the line): its own side answers that.
    this.autoAnswer(po);
    this.deps.changed();
  }

  /** The play-out position after `moves`: the attempts' analyses when they are cached, else a fresh one (not kept, a play-out can wander far). */
  private playoutAnalysis(moves: Gtp[], signal: AbortSignal): Promise<Analysis> {
    return (
      this.analyses.get(moves.join(" ")) ??
      this.deps.engine.analyze(problemPosition(this.problem, moves), { maxVisits: this.deps.problemVisits, signal })
    );
  }

  private play(point: Point): void {
    if (this.revealed) throw new UserError("This problem is over. Press Next problem, or Back to playing.");
    if (this.checking) throw new UserError("KataGo is still checking your last move.");
    const notReady = this.deps.engineNotReady();
    if (notReady) throw new UserError(notReady);
    const reason = this.game.illegalReason(point);
    if (reason) throw new UserError(ILLEGAL_TEXT[reason]);
    this.attempts++;
    this.checking = true;
    this.overlay = null;
    this.deps.changed();
    void this.checkAttempt(toGtp(point, this.problem.size), point);
  }

  /**
   * Judge an attempt: a known answer is correct; any other move is correct when KataGo finds it
   * within ANSWER_MARGIN of its best (and becomes an answer). A wrong move with attempts left gets
   * a ✕ and another try; otherwise the problem ends with KataGo's line on the board.
   */
  private async checkAttempt(move: Gtp, point: Point): Promise<void> {
    let before: Analysis | null = null;
    let after: Analysis | null = null;
    let failure: Error | null = null;
    try {
      [before, after] = await this.deps.busyWhile(Promise.all([this.analysis([]), this.analysis([move])]));
    } catch (err) {
      failure = err as Error;
    }
    if (this.closed) {
      this.deps.changed();
      return;
    }
    this.checking = false;
    const problem = this.problem;
    const known = problem.answers.includes(move);
    if (!known && (!before || !after)) {
      this.attempts--; // KataGo's failure doesn't cost the learner an attempt
      this.deps.system(`KataGo couldn't check ${move} (${failure?.message ?? "no answer"}). Try the move again.`);
      this.deps.changed();
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
    if (correct && !known && before && trustedCandidate(before, move)) {
      problem.answers = [...problem.answers, move];
      this.deps.addAnswer(problem.id, move);
    }
    const best = before?.moveInfos[0];
    const bestMove = best && best.move !== "pass" ? best.move : (problem.bestMove ?? problem.answers[0] ?? move);
    const bestPv = best && best.move !== "pass" ? best.pv : (problem.bestPv ?? [bestMove]);
    this.lastAttempt = { move, correct, pointLoss };
    const left = MAX_ATTEMPTS - this.attempts;

    if (correct) {
      this.answer = { move: bestMove, pv: bestPv };
      // The answer, the opponent's best reply and the next move.
      const line = lineStones(this.game.before(1), [move, ...(after?.moveInfos[0]?.pv ?? [])], ANSWER_LINE_LENGTH);
      // Even a line of one stone is drawn: the board is the fixed problem position, so without it
      // the learner's stone would vanish (KataGo's reply on a settled board is usually a pass).
      this.overlay = line.length ? { variation: { label: line.length > 1 ? `${move} and how play goes on` : move, moves: line } } : null;
      this.answerLine = line.map((s) => toGtp(s.point, problem.size));
      const also = bestMove !== move ? ` KataGo's favorite is ${bestMove}, and yours is about as good.` : "";
      const shown = line.length > 1 ? " The board shows the opponent's best reply." : "";
      this.deps.system(`Correct${this.attempts === 1 ? ", first try" : ""}: ${move}.${also}${shown}`);
    } else if (left > 0) {
      this.overlay = { marks: [{ point, kind: "x" }] };
      this.deps.system(`${move} isn't it: it loses about ${loss} points. Try again (${plural(left, "attempt")} left).`);
    } else {
      this.answer = { move: bestMove, pv: bestPv };
      const line = lineStones(this.game.before(1), bestPv, PV_STONES);
      const covered = line.some((s) => samePoint(s.point, point));
      this.answerLine = line.map((s) => toGtp(s.point, problem.size));
      this.overlay = {
        ...(line.length && { variation: { label: `KataGo's answer: ${bestMove}`, moves: line } }),
        ...(!covered && { marks: [{ point, kind: "x" as const }] }),
      };
      this.deps.system(`${move} loses about ${loss} points. The answer is ${bestMove}; the board shows KataGo's line (your move is marked ✕).`);
    }
    this.deps.emit({
      type: "problem_attempt",
      problemId: problem.id,
      move,
      correct,
      category: problem.category,
      attempt: this.attempts,
      firstTry: correct && this.attempts === 1,
      pointLoss,
      revealed: this.revealed,
      bestMove,
      bestPv: bestPv.slice(0, 8),
    });
    if (this.revealed) {
      this.nextDue = this.deps.recordResult(problem, this.solved, this.attempts)?.due;
      this.tutorOwed = true; // the tutor answers the result, even once the learner is playing it out
    }
    this.deps.changed();
  }

  /** Cached analysis of the problem position after `moves` (the learner moving first). */
  private analysis(moves: Gtp[]): Promise<Analysis> {
    const key = moves.join(" ");
    let pending = this.analyses.get(key);
    if (!pending) {
      pending = this.deps.engine.analyze(problemPosition(this.problem, moves), { maxVisits: this.deps.problemVisits });
      this.analyses.set(key, pending);
      pending.catch(() => this.analyses.delete(key));
    }
    return pending;
  }
}
