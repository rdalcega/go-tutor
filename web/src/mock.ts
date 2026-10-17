// Dev-only in-memory stand-in for the server, enabled with `?mock` in the URL.
// Serves a realistic paused game and reacts to actions well enough to eyeball the UI.

import { GoGame, boardFromDiagram, opponent } from "../../src/engine/index.ts";
import type {
  ActionResponse,
  ChatMessage,
  ClientAction,
  GameSettings,
  GameView,
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
import { colorName, round1, tutorLevelChangedText } from "../../src/shared/text.ts";
import { thresholdFor } from "../../src/shared/threshold.ts";
import { BUILTIN_PROBLEMS, type BuiltinProblem } from "../../src/server/builtin-problems.ts";

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
  private problemDef: BuiltinProblem | null = null;
  private problemIndex = 0;

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
      problem: v.problem ? { revealed: v.problem.revealed, checking: false } : null,
      overlay: v.overlay !== null,
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
      engineBusy: false,
      problem: null,
      profileVersion: this.view?.profileVersion ?? 0,
      allowed: [],
      mistakeThreshold: thresholdFor(4, settings.size),
    };
  }

  private tick(): void {
    const m = this.view.moment;
    if (m?.state === "waiting" && m.deadline !== undefined && Date.now() >= m.deadline) {
      m.state = "fallback";
      delete m.deadline;
      const rec = this.game?.moves[m.moveNumber - 1];
      const best = rec?.eval?.bestMove ?? "pass";
      const size = this.game?.size ?? 9;
      const bestPoint = tryFromGtp(best, size);
      this.view.overlay = {
        ...(bestPoint && { best: bestPoint }),
        variation: {
          label: "KataGo's line",
          fromMove: m.moveNumber,
          moves: (rec?.eval?.bestPv ?? []).flatMap((g, i) => {
            const point = tryFromGtp(g, size);
            return point ? [{ color: i % 2 === 0 ? rec!.move.color : opponent(rec!.move.color), point }] : [];
          }),
        },
      };
      this.msg("system", `That move cost about ${m.pointLoss.toFixed(1)} points. KataGo preferred ${best}.`, m.id);
      this.emit();
    }
  }

  private apply(a: ClientAction): string | null {
    const v = this.view;
    const s = v.settings;
    const game = this.game;
    if (v.mode === "problem" && a.type === "play") return this.problemPlay(a.point);
    switch (a.type) {
      case "next_problem":
        this.startProblem();
        return null;
      case "leave_problem":
        if (this.gameView) ({ view: this.view, game: this.game } = this.gameView);
        this.gameView = null;
        this.problemDef = null;
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
      case "new_game": {
        this.gameView = null;
        this.problemDef = null;
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
    }
  }

  /** Problem mode with the built-in problems in turn; the game view waits underneath. */
  private startProblem(): void {
    const def = BUILTIN_PROBLEMS[this.problemIndex++ % BUILTIN_PROBLEMS.length]!;
    this.gameView ??= { view: this.view, game: this.game };
    this.game = null;
    this.problemDef = def;
    this.view = {
      ...this.freshView({ size: 9, komi: 7, humanColor: def.toPlay, botRank: "20k", handicap: 0 }),
      gameId: null,
      mode: "problem",
      board: boardFromDiagram(def.board),
      toPlay: def.toPlay,
      chat: this.gameView.view.chat,
      problem: {
        id: def.id,
        prompt: def.prompt,
        attempts: 0,
        solved: false,
        kind: "builtin",
        category: def.category,
        toPlay: def.toPlay,
        maxAttempts: 2,
        revealed: false,
        box: 1,
      },
    };
    this.msg("system", `Practice problem: ${def.prompt}`);
  }

  private problemPlay(point: Point): string | null {
    const v = this.view;
    const p = v.problem;
    const def = this.problemDef;
    if (!p || !def) return "No problem on the board.";
    if (p.revealed) return "This problem is over. Press Next problem, or Back to playing.";
    if (!GoGame.fromBoard(v.board, def.toPlay).isLegal(point)) return "That point is already taken.";
    const gtp = toGtp(point, 9);
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
      const shown = fromGtp(correct ? gtp : answer, 9)!;
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
    v.engineBusy = false;
    // On Silent a mistake is recorded but the game doesn't pause.
    if (loss >= 4 && v.tutorLevel !== "silent") {
      const id = `mom-${rec.number}`;
      v.status = "paused";
      v.moment = { id, moveNumber: rec.number, pointLoss: loss, state: "waiting", deadline: Date.now() + 15_000 };
      this.msg("system", `Paused at move ${rec.number}: that move lost ${loss.toFixed(1)} points.`, id);
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
      for (let tries = 0; tries < 50; tries++) {
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
