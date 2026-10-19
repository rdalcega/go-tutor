// Dev-only in-memory stand-in for the server, enabled with `?mock` in the URL.
// Serves a realistic paused game and reacts to actions well enough to eyeball the UI.

import { GoGame, boardFromDiagram, opponent } from "../../src/engine/index.ts";
import type {
  ActionResponse,
  ChatMessage,
  ClientAction,
  Color,
  GameSettings,
  GameView,
  GeneratedProblemInfo,
  GenerationStatus,
  LessonInfo,
  MistakeCategory,
  MoveEval,
  MoveRecord,
  Point,
  Profile,
  ProfileResponse,
} from "../../src/shared/types.ts";
import type { ConnectionState, Transport } from "./api.ts";
import { allowedActions } from "../../src/shared/allowed.ts";
import { fromGtp, moveGtp, toGtp, tryFromGtp } from "../../src/shared/coords.ts";
import { BOX_INTERVALS, nextBox, resultOf } from "../../src/shared/schedule.ts";
import { colorName, judgeModeChangedText, round1, tutorLevelChangedText } from "../../src/shared/text.ts";
import { atLevelOf, judgedLoss } from "../../src/shared/judge.ts";
import { thresholdFor } from "../../src/shared/threshold.ts";

/** The mock bot's move that is a pass (its third), to show how the UI marks the bot's pass. */
const MOCK_BOT_PASS_AT = 3;

/** A batch of generated problems halfway done, for the progress card. */
const MOCK_GENERATION: GenerationStatus = {
  state: "waiting",
  current: {
    id: "batch1",
    number: 1,
    weakerRank: "20k",
    strongerRank: "15k",
    trigger: "first",
    found: 7,
    target: 20,
    sizes: [
      { size: 9, found: 4, target: 7, games: 5, minutes: 9 },
      { size: 13, found: 2, target: 7, games: 2, minutes: 8 },
      { size: 19, found: 1, target: 6, games: 1, minutes: 7 },
    ],
    band: "20k–16k",
    createdAt: Date.now() - 30 * 60_000,
  },
  last: null,
  batches: 0,
};

/** A practice problem for the mock: a board diagram (top row first; X black, O white) and its answers. */
interface MockProblem {
  id: string;
  category: MistakeCategory;
  toPlay: Color;
  prompt: string;
  board: readonly string[];
  answers: readonly string[];
  generated?: GeneratedProblemInfo;
  /** The last moves before the position, oldest first (labeled −5 … −1 on the board). */
  recent?: readonly [Color, string][];
  /** One variant of a lesson (a run of mistakes that missed the same point). */
  lesson?: LessonInfo;
}

const MOCK_PROBLEMS: readonly MockProblem[] = [
  {
    id: "p1",
    category: "life_and_death",
    toPlay: "B",
    prompt: "Black to play. One of the groups here is fighting for its life. Find the move that settles it in your favor.",
    board: [
      ". . . . . . . . .",
      ". . . . . . . . .",
      ". . . . . . . . .",
      "X X X X X X X X X",
      "O O O O O O O O O",
      ". . . . . . . . .",
      "O O O O O O O O O",
      ". O X X X X X O .",
      ". O X . . . X O .",
    ],
    answers: ["E1"],
    lesson: { id: "p1", variant: 1, variants: 3, gameId: "g1", answer: "E1", fromMove: 14, toMove: 20 },
    recent: [
      ["W", "H2"],
      ["B", "G1"],
      ["W", "H1"],
      ["B", "C1"],
      ["W", "B1"],
    ],
  },
  {
    id: "gen1",
    category: "tactics",
    toPlay: "B",
    prompt: "Black to play. Stones can be captured or saved here. Find the sharpest move.",
    board: [
      ". . . . . . . . . . . . .",
      ". . . . . . . . . . . . .",
      ". . . O . . . . . X . . .",
      ". . X O . . . . . . . . .",
      ". . X O . . . . . . . . .",
      ". . . . . . . . . . . . .",
      ". . . . . . . . . . . . .",
      ". . . . . . . . . . . . .",
      ". . . . . . . . . . O . .",
      ". . X . . . . . . O X . .",
      ". . . O X . . . . O X . .",
      ". . . . . . . . . . . . .",
      ". . . . . . . . . . . . .",
    ],
    answers: ["L4"],
    generated: { batchId: "batch1", difficultyRank: "17k", weakerRank: "20k", strongerRank: "15k" },
  },
];

function fakeEval(size: number, pointLoss: number, bestMove: string, lead: number, line?: string[]): MoveEval {
  const winBefore = 0.5 + Math.tanh(lead / 10) / 2;
  const winAfter = 0.5 + Math.tanh((lead - pointLoss) / 10) / 2;
  const best = tryFromGtp(bestMove, size);
  const near = (dx: number, dy: number) =>
    best ? toGtp({ x: Math.min(size - 1, Math.max(0, best.x + dx)), y: Math.min(size - 1, Math.max(0, best.y + dy)) }, size) : "pass";
  const pv = line ?? [bestMove, near(1, 0), near(0, 1), near(-1, 1)];
  return {
    leadBefore: lead,
    leadAfter: lead - pointLoss,
    pointLoss,
    winrateBefore: winBefore,
    winrateAfter: winAfter,
    bestMove,
    bestPv: pv,
    candidates: [
      { move: bestMove, lead, winrate: winBefore, visits: 312, pv },
      { move: near(1, 1), lead: lead - 0.8, winrate: winBefore - 0.03, visits: 54, pv: [near(1, 1)] },
    ],
  };
}

const SAMPLE: { gtp: string; loss?: number; best?: string; pv?: string[] }[] = [
  { gtp: "E5", loss: 0.2, best: "E5" },
  { gtp: "G4" },
  { gtp: "C4", loss: 1.4, best: "C6" },
  { gtp: "F6" },
  { gtp: "F5", loss: 0.0, best: "F5" },
  { gtp: "G6" },
  { gtp: "D7", loss: 2.8, best: "E7" },
  { gtp: "G7" },
  { gtp: "F3", loss: 0.6, best: "F3" },
  { gtp: "G3" },
  { gtp: "F2", loss: 0.4, best: "G2" },
  { gtp: "C6" },
  { gtp: "B7", loss: 6.2, best: "C7", pv: ["C7", "B6", "C5", "B5"] },
];

class MockServer implements Transport {
  private view: GameView;
  /** The rules engine behind the game view (null in problem mode, where the game waits in `gameView`). */
  private game: GoGame | null = null;
  private listeners = new Set<(v: GameView) => void>();
  private msgId = 0;
  /** In problem mode: the game view underneath, and the problem on the board. */
  private gameView: { view: GameView; game: GoGame | null } | null = null;
  private problemDef: MockProblem | null = null;
  private problemIndex = 0;
  /** A review of the finished game's mistakes (the mock problems in turn stand in for them). */
  private review: { gameId: string; index: number; total: number } | null = null;
  /** Playing the answered problem out: the line, the rules engine at the cursor, the problem board and the answer's drawing to put back. */
  private playout: {
    line: string[];
    cursor: number;
    game: GoGame;
    thinking: boolean;
    gen: number;
    answerOverlay: GameView["overlay"];
    base: GameView["board"];
  } | null = null;
  /** The answer's line as drawn at the reveal (kept even if the learner hides the drawing): a play-out starts with it ahead. */
  private answerLine: string[] = [];

  constructor() {
    this.view = this.sampleView();
    setInterval(() => this.tick(), 500);
  }

  // --- Transport ---------------------------------------------------------

  async send(action: ClientAction): Promise<ActionResponse> {
    await delay(120);
    const error = this.apply(action);
    if (error) return { ok: false, error };
    this.emit();
    return { ok: true, view: this.snapshot() };
  }

  async getProfile(): Promise<ProfileResponse> {
    const games = [9.2, 10.4, 11.1, 10.6, 11.4];
    const profile: Profile = {
      botRank: "19k",
      rating: games.at(-1)!,
      handicap: 0,
      ratingHistory: games.map((rating, i) => ({
        ts: Date.now() - (games.length - i) * 3_600_000,
        gameId: `mock-${i + 1}`,
        rating,
        botRank: "20k",
        won: i === 0 || rating > games[i - 1]!,
        delta: i === 0 ? 1.2 : round1(rating - games[i - 1]!),
        estimate: { rating: Math.max(10, rating + 0.3), floor: rating + 0.3 <= 10, moves: 28 + i, hints: i % 3, takeBacks: i % 2, rethinks: 1 },
      })),
      ratingModel: 2,
      mistakeThreshold: 4,
      thresholdHistory: [],
      mistakeCounts: { life_and_death: 4, capturing_race: 1, opening: 2, direction: 1, shape: 3, endgame: 0, tactics: 2, other: 1 },
      recentMistakes: [],
      recentGames: [],
      practiced: {},
      gamesPlayed: games.length,
      problemsSolved: 0,
      tutorLevel: this.view.tutorLevel,
      judgeMode: this.view.judgeMode,
    };
    return {
      profile,
      focus: { category: "life_and_death", reason: "life and death keeps costing points.", suggestion: "problems" },
    };
  }

  subscribe(onView: (v: GameView) => void, onConnection: (s: ConnectionState) => void): () => void {
    this.listeners.add(onView);
    onConnection("connecting");
    setTimeout(() => {
      onConnection("open");
      onView(this.snapshot());
    }, 150);
    return () => this.listeners.delete(onView);
  }

  // --- state -------------------------------------------------------------

  /** The view as the server would send it: the game's position and the actions it accepts now. */
  private snapshot(): GameView {
    const v = this.view;
    if (this.game) {
      v.board = this.game.board;
      v.moves = this.game.moves;
      v.captures = this.game.captures;
      v.toPlay = this.game.toPlay;
    }
    const po = this.playout;
    if (po && v.problem) {
      v.board = po.game.board;
      v.moves = po.game.moves;
      v.captures = po.game.captures;
      v.toPlay = po.game.toPlay;
      v.engineBusy = po.thinking;
      v.problem.playout = { line: [...po.line], cursor: po.cursor, thinking: po.thinking, over: po.game.isOver };
    } else if (v.problem) {
      delete v.problem.playout;
    }
    v.allowed = this.allowed();
    return structuredClone(v);
  }

  /** The server's rules (src/shared/allowed.ts); the mock engine is always ready and checks attempts at once. */
  private allowed(): GameView["allowed"] {
    const v = this.view;
    return allowedActions({
      mode: v.mode,
      status: v.status,
      finished: v.result !== null,
      humanColor: v.mode === "game" && v.settings ? v.settings.humanColor : null,
      toPlay: v.toPlay,
      moves: v.moves,
      moment: v.moment,
      engineReady: true,
      tutorAttached: v.tutorAttached,
      problem: v.problem
        ? {
            revealed: v.problem.revealed,
            checking: false,
            playout: this.playout && {
              cursor: this.playout.cursor,
              length: this.playout.line.length,
              thinking: this.playout.thinking,
              learnerToPlay: this.playout.game.toPlay === v.problem.toPlay,
              over: this.playout.game.isOver,
            },
          }
        : null,
      overlay: v.overlay !== null,
      reviewProblems: v.reviewProblems ?? 0,
      inReview: this.review !== null,
    });
  }

  private emit(): void {
    for (const l of this.listeners) l(this.snapshot());
  }

  private msg(from: ChatMessage["from"], text: string, momentId?: string): void {
    this.view.chat.push({ id: `m${++this.msgId}`, ts: Date.now(), from, text, momentId });
  }

  private sampleView(): GameView {
    const settings: GameSettings = { size: 9, komi: 7, humanColor: "B", botRank: "18k", handicap: 0 };
    const v = this.freshView(settings);
    const game = new GoGame(9, 7);
    let lead = 3.5;
    for (const s of SAMPLE) {
      const result = game.playAt(fromGtp(s.gtp, 9)!);
      if (!result.ok) throw new Error(`mock sample move ${s.gtp} is illegal`);
      if (s.loss !== undefined) {
        result.record.eval = fakeEval(9, s.loss, s.best!, lead, s.pv);
        lead -= s.loss;
      }
    }
    this.game = game;
    const momentId = "mom-13";
    v.status = "paused";
    // The tutor drew a line and resumed: the drawing stays until the learner presses Continue.
    v.moment = { id: momentId, moveNumber: 13, pointLoss: 6.2, state: "tutor", awaitingLearner: true };
    v.overlay = {
      variation: {
        label: "Tutor: C7 keeps the corner connected",
        moves: [
          { color: "B", point: fromGtp("C7", 9)! },
          { color: "W", point: fromGtp("B6", 9)! },
          { color: "B", point: fromGtp("C5", 9)! },
        ],
      },
      marks: [
        { point: fromGtp("C6", 9)!, kind: "triangle" },
        { point: fromGtp("H5", 9)!, kind: "label", text: "A" },
        { point: fromGtp("D3", 9)!, kind: "square" },
      ],
    };
    v.tutorAttached = true;
    this.view = v;
    this.msg("system", "New game: 9×9, komi 7. You play Black against an 18k bot.");
    this.msg("tutor", "Good start. E5 claims the center; watch how White approaches from the side.");
    this.msg("user", "Was C4 too low?");
    this.msg("tutor", "A little. C6 would have pressed White's stones while building your own framework.");
    this.msg("system", "Paused at move 13: B7 lost 6.2 points. Waiting for your tutor…", momentId);
    this.msg("tutor", "Let's look at this one together. What happens to your D7 stone if White plays C7?", momentId);
    return v;
  }

  private freshView(settings: GameSettings): GameView {
    return {
      gameId: `mock-${Date.now().toString(36)}`,
      mode: "game",
      settings,
      status: "playing",
      board: [],
      toPlay: "B",
      moves: [],
      captures: { B: 0, W: 0 },
      result: null,
      moment: null,
      overlay: null,
      chat: [],
      tutorAttached: this.view?.tutorAttached ?? true,
      tutorLevel: this.view?.tutorLevel ?? "coach",
      judgeMode: this.view?.judgeMode ?? "optimal",
      atLevelRank: "18k",
      engineBusy: false,
      problem: null,
      profileVersion: this.view?.profileVersion ?? 0,
      allowed: [],
      mistakeThreshold: thresholdFor(4, settings.size),
      generation: MOCK_GENERATION,
    };
  }

  private tick(): void {
    const m = this.view.moment;
    if (m?.state === "waiting" && m.deadline !== undefined && Date.now() >= m.deadline) {
      m.state = "fallback";
      delete m.deadline;
      const rec = this.game?.moves[m.moveNumber - 1];
      // Judged at level, the answer is the reference move, as on the server.
      const atLevel = rec && atLevelOf(rec);
      const best = atLevel?.move ?? rec?.eval?.bestMove ?? "pass";
      const size = this.game?.size ?? 9;
      const bestPoint = tryFromGtp(best, size);
      this.view.overlay = {
        ...(bestPoint && { best: bestPoint }),
        variation: {
          label: atLevel ? `A ${atLevel.rank}'s line` : "KataGo's line",
          fromMove: m.moveNumber,
          moves: (atLevel?.pv ?? rec?.eval?.bestPv ?? []).flatMap((g, i) => {
            const point = tryFromGtp(g, size);
            return point ? [{ color: i % 2 === 0 ? rec!.move.color : opponent(rec!.move.color), point }] : [];
          }),
        },
      };
      const verdict = atLevel ? `compared with ${best}, the move a ${atLevel.rank} player would most likely play` : `KataGo preferred ${best}`;
      this.msg("system", `That move cost about ${m.pointLoss.toFixed(1)} points${atLevel ? " " : ". "}${verdict}.`, m.id);
      this.emit();
    }
  }

  private apply(a: ClientAction): string | null {
    const v = this.view;
    const s = v.settings;
    const game = this.game;
    if (v.mode === "problem" && (a.type.startsWith("playout_") || (this.playout && (a.type === "play" || a.type === "pass")))) return this.playoutApply(a);
    if (v.mode === "problem" && a.type === "play") return this.problemPlay(a.point);
    switch (a.type) {
      case "next_problem":
        if (this.review && this.review.index >= this.review.total) {
          this.leaveProblem();
          this.msg("system", "Review done.");
          return null;
        }
        if (this.review) this.review.index++;
        this.startProblem();
        return null;
      case "review_game":
        this.review = { gameId: a.gameId, index: 1, total: v.reviewProblems ?? 0 };
        this.problemIndex = 0;
        this.startProblem();
        return null;
      case "leave_problem":
        this.leaveProblem();
        return null;
      case "clear_overlay":
        v.overlay = null;
        return null;
      case "set_tutor_level":
        v.tutorLevel = a.level;
        if (this.gameView) this.gameView.view.tutorLevel = a.level;
        v.profileVersion++;
        this.msg("system", tutorLevelChangedText(a.level));
        return null;
      case "set_judge_mode":
        v.judgeMode = a.mode;
        if (this.gameView) this.gameView.view.judgeMode = a.mode;
        v.profileVersion++;
        this.msg("system", judgeModeChangedText(a.mode, v.atLevelRank ?? "18k"));
        return null;
      case "new_game": {
        this.playout = null;
        this.gameView = null;
        this.problemDef = null;
        this.review = null;
        const settings: GameSettings = {
          size: 9, komi: 7, humanColor: "B", botRank: s?.botRank ?? "18k", handicap: 0, ...a.settings,
        };
        this.view = this.freshView(settings);
        this.game = new GoGame(settings.size, settings.komi);
        this.msg("system", `New game: ${settings.size}×${settings.size}. You play ${colorName(settings.humanColor)} against a ${settings.botRank} bot.`);
        if (settings.humanColor === "W") this.botReply();
        return null;
      }
      case "play": {
        if (!s || !game || v.status !== "playing" || game.toPlay !== s.humanColor) return "It isn't your turn.";
        const result = game.playAt(a.point);
        if (!result.ok) return "That point is not a legal move.";
        v.overlay = null;
        v.engineBusy = true;
        setTimeout(() => this.evaluate(result.record), 500);
        return null;
      }
      case "pass": {
        if (!s || !game || game.toPlay !== s.humanColor || v.status !== "playing") return "It isn't your turn.";
        game.pass();
        // Passing after the bot passed ends the game; otherwise the bot passes too.
        if (game.isOver) {
          this.finish({ winner: "W", margin: -4.5, reason: "score" });
          return null;
        }
        v.engineBusy = true;
        setTimeout(() => {
          game.pass();
          this.finish({ winner: "W", margin: -4.5, reason: "score" });
        }, 700);
        return null;
      }
      case "resign":
        if (!s || v.status === "finished") return "No game in progress.";
        this.finish({ winner: opponent(s.humanColor), margin: 0, reason: "resign" });
        return null;
      case "continue":
        if (v.status !== "paused") return "Nothing to continue.";
        v.status = "playing";
        v.moment = null;
        v.overlay = null;
        if (s && game && game.toPlay !== s.humanColor) this.botReply();
        return null;
      case "retry":
      case "take_back": {
        if (!s || !game) return "No game in progress.";
        const moves = game.moves;
        let idx = moves.length - 1;
        while (idx >= 0 && moves[idx]!.move.color !== s.humanColor) idx--;
        if (idx < 0) return "No move to take back.";
        game.undo(moves.length - idx);
        v.status = "playing";
        v.moment = null;
        v.overlay = null;
        this.msg("system", "Took back your move. Try again.");
        return null;
      }
      case "chat":
        this.msg("user", a.text, v.moment?.id);
        setTimeout(() => {
          if (v.tutorAttached) this.msg("tutor", `Good question. (Mock reply to “${a.text.slice(0, 40)}”.)`);
          else this.msg("system", "The tutor isn't connected.");
          this.emit();
        }, 900);
        return null;
      case "ask_tutor": {
        if (!s) return "Start a game first.";
        if (a.text?.trim()) this.msg("user", a.text.trim(), v.moment?.id);
        const p = this.randomEmpty();
        if (p) v.overlay = { marks: [{ point: p, kind: "circle" }] };
        this.msg("system", p ? `Hint: consider ${toGtp(p, s.size)}.` : "No hint available.");
        return null;
      }
      case "playout_start":
      case "playout_back":
      case "playout_forward":
      case "playout_exit":
        return "Playing out is for a practice problem you have answered.";
    }
  }

  /** Play-out, as the server does it (src/server/practice.ts), with a random legal point for KataGo. */
  private playoutApply(a: ClientAction): string | null {
    const v = this.view;
    const p = v.problem!;
    const size = v.board.length;
    if (a.type === "playout_start") {
      if (this.playout) return null;
      if (!p.revealed) return "Answer the problem first; then you can play it out.";
      const line = [...this.answerLine];
      this.playout = { line, cursor: 0, game: GoGame.fromBoard(v.board, p.toPlay), thinking: false, gen: 0, answerOverlay: v.overlay, base: v.board };
      v.overlay = null;
      this.msg("system", "Playing it out: KataGo answers at full strength, and nothing here is judged.");
      return null;
    }
    const po = this.playout;
    if (!po) return "Press Play it out first.";
    const advance = (gtp: string) => {
      const point = tryFromGtp(gtp, size);
      const color = po.game.toPlay;
      po.game.play(point ? { color, point } : { color, pass: true });
      po.cursor++;
    };
    const reply = () => {
      const gen = ++po.gen;
      po.thinking = true;
      setTimeout(() => {
        if (this.playout !== po || po.gen !== gen) return;
        po.thinking = false;
        let move = "pass";
        for (let tries = 0; tries < 50; tries++) {
          const q = this.randomEmpty();
          if (q && po.game.isLegal(q)) {
            move = toGtp(q, size);
            break;
          }
        }
        po.line.length = po.cursor;
        po.line.push(move);
        advance(move);
        answer();
        this.emit();
      }, 600);
    };
    // As on the server: a move that leaves KataGo to play has it answer (stepping back never does).
    const answer = () => {
      if (po.game.isOver || po.game.toPlay === p.toPlay) return;
      if (po.cursor < po.line.length) advance(po.line[po.cursor]!);
      else reply();
    };
    switch (a.type) {
      case "playout_exit":
        this.playout = null;
        v.board = po.base;
        v.moves = [];
        v.toPlay = p.toPlay;
        v.captures = { B: 0, W: 0 };
        v.engineBusy = false;
        v.overlay = po.answerOverlay;
        return null;
      case "playout_back":
        if (po.cursor === 0) return "This is the problem position.";
        po.game.undo(1);
        po.cursor--;
        po.gen++;
        po.thinking = false;
        return null;
      case "playout_forward":
        if (po.thinking) return "KataGo is thinking.";
        if (po.cursor < po.line.length) {
          advance(po.line[po.cursor]!);
          answer();
        } else if (po.game.isOver) return "Both sides passed.";
        else reply();
        return null;
      case "play":
      case "pass": {
        if (po.thinking || po.game.isOver || po.game.toPlay !== p.toPlay) return "It isn't your turn.";
        if (a.type === "play" && !po.game.isLegal(a.point)) return "That point is not a legal move.";
        const gtp = a.type === "play" ? toGtp(a.point, size) : "pass";
        // As on the server: the next move of the line itself just steps forward, keeping what follows it.
        if (po.line[po.cursor] !== gtp) {
          po.line.length = po.cursor;
          po.line.push(gtp);
        }
        advance(gtp);
        po.gen++;
        answer();
        return null;
      }
    }
    return null;
  }

  private leaveProblem(): void {
    this.playout = null;
    if (this.gameView) ({ view: this.view, game: this.game } = this.gameView);
    this.gameView = null;
    this.problemDef = null;
    this.review = null;
  }

  /** Problem mode with the mock problems in turn; the game view waits underneath. */
  private startProblem(): void {
    const def = MOCK_PROBLEMS[this.problemIndex++ % MOCK_PROBLEMS.length]!;
    this.playout = null;
    this.gameView ??= { view: this.view, game: this.game };
    this.game = null;
    this.problemDef = def;
    const board = boardFromDiagram(def.board);
    this.view = {
      ...this.freshView({ size: board.length as GameSettings["size"], komi: 7, humanColor: def.toPlay, botRank: "20k", handicap: 0 }),
      gameId: null,
      mode: "problem",
      board,
      toPlay: def.toPlay,
      chat: this.gameView.view.chat,
      problem: {
        id: def.id,
        prompt: def.prompt,
        attempts: 0,
        solved: false,
        kind: def.generated ? "generated" : "game",
        ...(def.generated ? { generated: def.generated } : { source: { gameId: "g1", moveNumber: 14 } }),
        category: def.category,
        toPlay: def.toPlay,
        maxAttempts: 2,
        revealed: false,
        box: 1,
        ...(def.recent && { recentMoves: def.recent.map(([color, gtp], i) => ({ color, point: fromGtp(gtp, board.length)!, ago: def.recent!.length - i })) }),
        ...(this.review && { review: { ...this.review } }),
        ...(def.lesson && { lesson: { ...def.lesson } }),
      },
    };
    this.msg("system", `${this.review ? `Review ${this.review.index}/${this.review.total}` : "Practice problem"}: ${def.prompt}`);
  }

  private problemPlay(point: Point): string | null {
    const v = this.view;
    const p = v.problem;
    const def = this.problemDef;
    if (!p || !def) return "No problem on the board.";
    if (p.revealed) return "This problem is over. Press Next problem, or Back to playing.";
    if (!GoGame.fromBoard(v.board, def.toPlay).isLegal(point)) return "That point is already taken.";
    const size = v.board.length;
    const gtp = toGtp(point, size);
    p.attempts++;
    const correct = def.answers.includes(gtp);
    p.lastAttempt = { move: gtp, correct, pointLoss: correct ? 0 : round1(3 + Math.random() * 5) };
    const answer = def.answers[0]!;
    if (correct || p.attempts >= p.maxAttempts) {
      p.revealed = true;
      p.solved = correct;
      p.answer = { move: answer, pv: [answer] };
      // Scheduled as the server does it (src/shared/schedule.ts); the panel's "see this again" reads nextDue.
      p.box = nextBox(p.box, resultOf(correct, p.attempts));
      p.nextDue = Date.now() + BOX_INTERVALS[p.box]!;
      v.status = "finished";
      const shown = fromGtp(correct ? gtp : answer, size)!;
      this.answerLine = [toGtp(shown, size)];
      v.overlay = {
        variation: { label: correct ? `${gtp} and how play goes on` : `KataGo's answer: ${answer}`, moves: [{ color: def.toPlay, point: shown }] },
        ...(!correct && { marks: [{ point, kind: "x" as const }] }),
      };
    } else {
      v.overlay = { marks: [{ point, kind: "x" }] };
    }
    return null;
  }

  private evaluate(rec: MoveRecord): void {
    const v = this.view;
    const size = this.game?.size ?? 9;
    const loss = round1(-Math.log(1 - Math.random() * 0.97) * 1.8);
    const best = this.randomEmpty() ?? { x: 0, y: 0 };
    rec.eval = fakeEval(size, loss, toGtp(best, size), 1);
    rec.judge = v.judgeMode;
    if (v.judgeMode === "at_level") {
      // A reference move a little worse than KataGo's best, so some moves beat it.
      const reference = toGtp(this.randomEmpty() ?? best, size);
      rec.eval.atLevel = { rank: v.atLevelRank ?? "18k", move: reference, pv: [reference], loss: round1(loss - Math.random() * 3) };
    }
    const judged = judgedLoss(rec)!;
    v.engineBusy = false;
    // On Silent a mistake is recorded but the game doesn't pause.
    if (judged >= 4 && v.tutorLevel !== "silent") {
      const id = `mom-${rec.number}`;
      v.status = "paused";
      v.moment = { id, moveNumber: rec.number, pointLoss: judged, state: "waiting", deadline: Date.now() + 15_000 };
      this.msg("system", `Paused at move ${rec.number}: that move lost ${judged.toFixed(1)} points.`, id);
      this.emit();
      return;
    }
    this.emit();
    this.botReply();
  }

  private botReply(): void {
    const v = this.view;
    const game = this.game;
    if (!game) return;
    v.engineBusy = true;
    this.emit();
    setTimeout(() => {
      // The bot passes on its third move of a game, so the pass banner and status can be eyeballed.
      const botMoves = game.moves.filter((r) => r.move.color !== v.settings?.humanColor).length;
      for (let tries = 0; tries < 50 && botMoves !== MOCK_BOT_PASS_AT - 1; tries++) {
        const p = this.randomEmpty();
        if (!p) break;
        if (game.playAt(p).ok) break;
      }
      if (game.toPlay !== v.settings?.humanColor) game.pass();
      v.engineBusy = false;
      this.emit();
    }, 800);
  }

  private finish(result: NonNullable<GameView["result"]>): void {
    const v = this.view;
    v.status = "finished";
    v.result = result;
    // The server's summary, as far as the result dialog reads it: the human's mistakes, worst first.
    const mistakes = (this.game?.moves ?? [])
      .filter((r) => r.move.color === v.settings?.humanColor && r.eval && r.eval.pointLoss >= v.mistakeThreshold)
      .map((r) => ({ moveNumber: r.number, move: moveGtp(r.move, v.board.length), pointLoss: r.eval!.pointLoss, bestMove: r.eval!.bestMove }))
      .sort((a, b) => b.pointLoss - a.pointLoss);
    v.summary = { moves: this.game?.moves.length ?? 0, threshold: v.mistakeThreshold, mistakes, totalPointLoss: mistakes.reduce((n, m) => n + m.pointLoss, 0) };
    // Each mistake becomes a practice problem (the mock's problems stand in for them).
    v.reviewProblems = Math.min(mistakes.length, MOCK_PROBLEMS.length);
    v.moment = null;
    v.engineBusy = false;
    v.profileVersion++;
    this.msg("system", "Game over.");
    this.emit();
  }

  private randomEmpty(): Point | null {
    const empty: Point[] = [];
    const board = this.game?.board ?? this.view.board;
    board.forEach((row, y) => row.forEach((c, x) => c === null && empty.push({ x, y })));
    return empty[Math.floor(Math.random() * empty.length)] ?? null;
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMockTransport(): Transport {
  return new MockServer();
}
