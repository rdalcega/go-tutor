// Dev-only in-memory stand-in for the server, enabled with `?mock` in the URL.
// Serves a realistic paused game and reacts to actions well enough to eyeball the UI.

import type {
  Board,
  ChatMessage,
  ClientAction,
  Color,
  GameSettings,
  GameView,
  MoveEval,
  MoveRecord,
  Point,
} from "../../src/shared/types.ts";
import type { ActionResponse, ConnectionState, Transport } from "./api.ts";
import { fromGtp, toGtp, tryFromGtp } from "../../src/shared/coords.ts";

const other = (c: Color): Color => (c === "B" ? "W" : "B");

function emptyBoard(size: number): Board {
  return Array.from({ length: size }, () => Array<Color | null>(size).fill(null));
}

function neighbors(p: Point, size: number): Point[] {
  return [
    { x: p.x - 1, y: p.y },
    { x: p.x + 1, y: p.y },
    { x: p.x, y: p.y - 1 },
    { x: p.x, y: p.y + 1 },
  ].filter((q) => q.x >= 0 && q.y >= 0 && q.x < size && q.y < size);
}

/** The group containing `p` and whether it has any liberty. */
function group(board: Board, p: Point): { stones: Point[]; free: boolean } {
  const color = board[p.y]![p.x];
  const seen = new Set<string>();
  const stones: Point[] = [];
  let free = false;
  const stack = [p];
  while (stack.length) {
    const q = stack.pop()!;
    const k = `${q.x},${q.y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    stones.push(q);
    for (const n of neighbors(q, board.length)) {
      const c = board[n.y]![n.x];
      if (c === null) free = true;
      else if (c === color) stack.push(n);
    }
  }
  return { stones, free };
}

/** Places a stone and removes captured neighbors. Returns null when the point is taken or suicide. */
function place(board: Board, p: Point, color: Color): Point[] | null {
  if (board[p.y]![p.x] !== null) return null;
  board[p.y]![p.x] = color;
  const captured: Point[] = [];
  for (const n of neighbors(p, board.length)) {
    if (board[n.y]![n.x] !== other(color)) continue;
    const g = group(board, n);
    if (!g.free) for (const s of g.stones) captured.push(s);
  }
  for (const s of captured) board[s.y]![s.x] = null;
  if (!group(board, p).free) {
    board[p.y]![p.x] = null;
    return null;
  }
  return captured;
}

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
  private listeners = new Set<(v: GameView) => void>();
  private msgId = 0;

  constructor() {
    this.view = this.sampleView();
    setInterval(() => this.tick(), 500);
  }

  // --- Transport ---------------------------------------------------------

  async getState(): Promise<GameView> {
    return structuredClone(this.view);
  }

  async send(action: ClientAction): Promise<ActionResponse> {
    await delay(120);
    const error = this.apply(action);
    if (error) return { ok: false, error };
    this.emit();
    return { ok: true, view: structuredClone(this.view) };
  }

  subscribe(onView: (v: GameView) => void, onConnection: (s: ConnectionState) => void): () => void {
    this.listeners.add(onView);
    onConnection("connecting");
    setTimeout(() => {
      onConnection("open");
      onView(structuredClone(this.view));
    }, 150);
    return () => this.listeners.delete(onView);
  }

  // --- state -------------------------------------------------------------

  private emit(): void {
    for (const l of this.listeners) l(structuredClone(this.view));
  }

  private msg(from: ChatMessage["from"], text: string, momentId?: string): void {
    this.view.chat.push({ id: `m${++this.msgId}`, ts: Date.now(), from, text, momentId });
  }

  private sampleView(): GameView {
    const settings: GameSettings = { size: 9, komi: 7, humanColor: "B", botRank: "18k", handicap: 0 };
    const v = this.freshView(settings);
    let lead = 3.5;
    for (const s of SAMPLE) {
      const color = v.toPlay;
      const point = fromGtp(s.gtp, 9)!;
      const captures = place(v.board, point, color) ?? [];
      const rec: MoveRecord = { number: v.moves.length + 1, move: { color, point }, captures };
      if (s.loss !== undefined) {
        rec.eval = fakeEval(9, s.loss, s.best!, lead, s.pv);
        lead -= s.loss;
      }
      v.moves.push(rec);
      v.toPlay = other(color);
    }
    const momentId = "mom-13";
    v.status = "paused";
    v.moment = { id: momentId, moveNumber: 13, pointLoss: 6.2, state: "waiting", deadline: Date.now() + 25_000 };
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
      board: emptyBoard(settings.size),
      toPlay: "B",
      moves: [],
      captures: { B: 0, W: 0 },
      result: null,
      moment: null,
      overlay: null,
      chat: [],
      tutorAttached: this.view?.tutorAttached ?? true,
      engineBusy: false,
      problem: null,
    };
  }

  private tick(): void {
    const m = this.view.moment;
    if (m?.state === "waiting" && m.deadline !== undefined && Date.now() >= m.deadline) {
      m.state = "fallback";
      delete m.deadline;
      const rec = this.view.moves[m.moveNumber - 1];
      const best = rec?.eval?.bestMove ?? "pass";
      const size = this.view.board.length;
      this.view.overlay = {
        variation: {
          label: "KataGo's line",
          fromMove: m.moveNumber,
          moves: (rec?.eval?.bestPv ?? []).flatMap((g, i) => {
            const point = tryFromGtp(g, size);
            return point ? [{ color: i % 2 === 0 ? rec!.move.color : other(rec!.move.color), point }] : [];
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
    switch (a.type) {
      case "new_game": {
        const settings: GameSettings = {
          size: 9, komi: 7, humanColor: "B", botRank: s?.botRank ?? "18k", handicap: 0, ...a.settings,
        };
        this.view = this.freshView(settings);
        this.msg("system", `New game: ${settings.size}×${settings.size}. You play ${settings.humanColor === "B" ? "Black" : "White"} against a ${settings.botRank} bot.`);
        if (settings.humanColor === "W") this.botReply();
        return null;
      }
      case "play": {
        if (!s || v.status !== "playing" || v.toPlay !== s.humanColor) return "It isn't your turn.";
        const captures = place(v.board, a.point, s.humanColor);
        if (!captures) return "That point is not a legal move.";
        const rec: MoveRecord = { number: v.moves.length + 1, move: { color: s.humanColor, point: a.point }, captures };
        v.moves.push(rec);
        v.captures[s.humanColor] += captures.length;
        v.toPlay = other(s.humanColor);
        v.overlay = null;
        v.engineBusy = true;
        setTimeout(() => this.evaluate(rec), 500);
        return null;
      }
      case "pass": {
        if (!s || v.toPlay !== s.humanColor || v.status !== "playing") return "It isn't your turn.";
        v.moves.push({ number: v.moves.length + 1, move: { color: s.humanColor, pass: true }, captures: [] });
        v.toPlay = other(s.humanColor);
        v.engineBusy = true;
        setTimeout(() => {
          v.moves.push({ number: v.moves.length + 1, move: { color: v.toPlay, pass: true }, captures: [] });
          this.finish({ winner: "W", margin: -4.5, reason: "score" });
        }, 700);
        return null;
      }
      case "resign":
        if (!s || v.status === "finished") return "No game in progress.";
        this.finish({ winner: other(s.humanColor), margin: 0, reason: "resign" });
        return null;
      case "continue":
        if (v.status !== "paused") return "Nothing to continue.";
        v.status = "playing";
        v.moment = null;
        v.overlay = null;
        if (s && v.toPlay !== s.humanColor) this.botReply();
        return null;
      case "retry": {
        if (!s) return "No game in progress.";
        let idx = v.moves.length - 1;
        while (idx >= 0 && v.moves[idx]!.move.color !== s.humanColor) idx--;
        if (idx < 0) return "No move to take back.";
        // Rebuild the board without the last human move and anything after it.
        const kept = v.moves.slice(0, idx);
        v.board = emptyBoard(s.size);
        v.captures = { B: 0, W: 0 };
        for (const m of kept) {
          if ("point" in m.move) v.captures[m.move.color] += place(v.board, m.move.point, m.move.color)?.length ?? 0;
        }
        v.moves = kept;
        v.toPlay = s.humanColor;
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
        const p = this.randomEmpty();
        if (p) v.overlay = { marks: [{ point: p, kind: "circle" }] };
        this.msg("system", p ? `Hint: consider ${toGtp(p, s.size)}.` : "No hint available.");
        return null;
      }
      case "next_problem":
        return "Problems are not available in the mock.";
    }
  }

  private evaluate(rec: MoveRecord): void {
    const v = this.view;
    const size = v.board.length;
    const loss = Math.round(-Math.log(1 - Math.random() * 0.97) * 1.8 * 10) / 10;
    const best = this.randomEmpty() ?? { x: 0, y: 0 };
    rec.eval = fakeEval(size, loss, toGtp(best, size), 1);
    v.engineBusy = false;
    if (loss >= 4) {
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
    v.engineBusy = true;
    this.emit();
    setTimeout(() => {
      const color = v.toPlay;
      for (let tries = 0; tries < 50; tries++) {
        const p = this.randomEmpty();
        if (!p) break;
        const captures = place(v.board, p, color);
        if (!captures) continue;
        v.moves.push({ number: v.moves.length + 1, move: { color, point: p }, captures });
        v.captures[color] += captures.length;
        break;
      }
      v.toPlay = other(color);
      v.engineBusy = false;
      this.emit();
    }, 800);
  }

  private finish(result: NonNullable<GameView["result"]>): void {
    const v = this.view;
    v.status = "finished";
    v.result = result;
    v.moment = null;
    v.engineBusy = false;
    this.msg("system", "Game over.");
    this.emit();
  }

  private randomEmpty(): Point | null {
    const empty: Point[] = [];
    this.view.board.forEach((row, y) => row.forEach((c, x) => c === null && empty.push({ x, y })));
    return empty[Math.floor(Math.random() * empty.length)] ?? null;
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMockTransport(): Transport {
  return new MockServer();
}
