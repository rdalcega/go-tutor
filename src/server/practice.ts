// Problem mode: one practice problem on the board, judged against KataGo, while any game waits
// underneath in the GameController (game.ts), which starts and ends sessions, keeps the chat and
// writes the problem's progress and the profile.

import { toAscii, type GoGame } from "../engine/index.ts";
import { samePoint, toGtp } from "../shared/coords.ts";
import { round1 } from "../shared/text.ts";
import type { ClientAction, Color, GameSettings, GameView, Gtp, Overlay, Point, ProblemAttempt, TutorCommand } from "../shared/types.ts";
import { ILLEGAL_TEXT, PV_STONES, UserError, alternatingStones, lineStones, plural, type TutorEventInput } from "./common.ts";
import { moveEvalFrom, trustedCandidate, type Analysis, type Engine } from "./katago.ts";
import { ANSWER_MARGIN, MAX_ATTEMPTS, problemGame, problemPosition, promptFor, type StoredProblem } from "./problems.ts";

/** Moves of the follow-up drawn after a correct answer: the answer, the opponent's best reply, the next move. */
const ANSWER_LINE_LENGTH = 3;

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

  /** Throws a UserError when the problem can't be set up. */
  constructor(
    problem: StoredProblem,
    private readonly deps: PracticeDeps,
  ) {
    this.problem = problem;
    try {
      this.game = problemGame(problem);
    } catch (err) {
      throw new UserError(`Problem ${problem.id} can't be set up: ${(err as Error).message}`);
    }
  }

  /** Solved, or out of attempts: the answer is shown and the board is locked. */
  get revealed(): boolean {
    return this.answer !== undefined;
  }

  get solved(): boolean {
    return this.lastAttempt?.correct === true;
  }

  /** Put the problem on the board: tell the learner and the tutor, and let KataGo read the position. */
  start(early: boolean): void {
    const { problem } = this;
    const source = problem.source;
    const firstTry = source?.takenBack !== undefined ? ", your first try before the take-back" : "";
    const from = source ? ` from your game ${source.gameId} (move ${source.moveNumber}${firstTry})` : "";
    this.deps.system(`Practice problem${from}: ${problem.prompt}${early ? " (Nothing is due right now, so this is an early review.)" : ""}`);
    this.deps.emit({
      type: "problem_start",
      problemId: problem.id,
      kind: problem.kind,
      category: problem.category,
      toPlay: problem.toPlay,
      prompt: problem.prompt,
      answers: [...problem.answers],
      box: problem.box,
      ...(problem.source && { source: { gameId: problem.source.gameId, moveNumber: problem.source.moveNumber } }),
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
  handleAction(action: Extract<ClientAction, { type: "play" | "pass" | "resign" | "continue" | "retry" | "take_back" | "ask_tutor" }>): void {
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

  /** What the shared allowed-actions rules read of the problem. */
  get actionState(): { revealed: boolean; checking: boolean } {
    return { revealed: this.revealed, checking: this.checking };
  }

  view(common: Pick<GameView, "chat" | "tutorAttached" | "tutorLevel" | "judgeMode" | "engineBusy" | "profileVersion" | "allowed" | "mistakeThreshold">, botRank: string): GameView {
    const { problem } = this;
    return {
      gameId: null,
      mode: "problem",
      settings: { size: problem.size as GameSettings["size"], komi: problem.komi, humanColor: problem.toPlay, botRank, handicap: 0 },
      status: this.revealed ? "finished" : "playing",
      board: this.game.board,
      toPlay: problem.toPlay,
      moves: [],
      captures: { B: 0, W: 0 },
      result: null,
      moment: null,
      overlay: this.overlay,
      ...common,
      engineBusy: common.engineBusy || this.checking,
      problem: {
        id: problem.id,
        prompt: problem.prompt,
        ...(problem.source && { source: { gameId: problem.source.gameId, moveNumber: problem.source.moveNumber } }),
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
      },
    };
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
    if (this.revealed) this.nextDue = this.deps.recordResult(problem, this.solved, this.attempts)?.due;
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
