import type { Board, Color, Move, MoveRecord, Point } from "../shared/types.ts";
import { inBounds } from "../shared/coords.ts";
import { cloneBoard, emptyBoard, getCell, groupAt, handicapPoints, neighbors, opponent, positionKey, setCell } from "./board.ts";

export type IllegalReason = "occupied" | "suicide" | "ko" | "not_your_turn" | "game_over" | "off_board";

export type PlayResult = { ok: true; record: MoveRecord } | { ok: false; reason: IllegalReason };

export interface GameSetup {
  /** Extra stones placed before the first move (e.g. for problems). Added after handicap stones. */
  stones?: { color: Color; point: Point }[];
  /** Who moves first. Defaults to W with handicap stones, B otherwise. */
  toPlay?: Color;
}

interface Snapshot {
  board: Board;
  toPlay: Color;
  captures: { B: number; W: number };
  consecutivePasses: number;
}

/** The pure rules of Go: legality (suicide illegal, positional superko), captures, passes and undo. */
export class GoGame {
  readonly size: number;
  readonly komi: number;
  readonly handicap: number;
  /** Stones on the board before move 1 (handicap plus any setup stones). */
  readonly initialStones: readonly { color: Color; point: Point }[];
  readonly initialPlayer: Color;

  private grid: Board;
  private turn: Color;
  private prisoners = { B: 0, W: 0 };
  private passes = 0;
  private readonly records: MoveRecord[] = [];
  private readonly history: Snapshot[] = [];
  /** How many times each position (board contents only) has occurred in the game so far. */
  private readonly seen = new Map<string, number>();

  constructor(size: number, komi: number, handicap = 0, setup: GameSetup = {}) {
    if (!Number.isInteger(size) || size < 2 || size > 25) throw new RangeError(`Unsupported board size ${size}`);
    this.size = size;
    this.komi = komi;
    this.handicap = handicap;
    const stones = [
      ...handicapPoints(size, handicap).map((point) => ({ color: "B" as Color, point })),
      ...(setup.stones ?? []),
    ];
    this.grid = emptyBoard(size);
    for (const s of stones) {
      if (!inBounds(s.point, size)) throw new RangeError(`Setup stone (${s.point.x}, ${s.point.y}) is off the board`);
      setCell(this.grid, s.point, s.color);
    }
    this.initialStones = stones;
    this.initialPlayer = setup.toPlay ?? (handicap >= 2 ? "W" : "B");
    this.turn = this.initialPlayer;
    this.remember(this.grid);
  }

  /** Rebuild a game from a move list. Throws if any move is illegal. */
  static fromMoves(size: number, komi: number, handicap: number, moves: readonly Move[], setup?: GameSetup): GoGame {
    const game = new GoGame(size, komi, handicap, setup);
    for (const move of moves) {
      const result = game.play(move);
      if (!result.ok) throw new Error(`Move ${game.moves.length + 1} is illegal: ${result.reason}`);
    }
    return game;
  }

  /** A copy of the current board, board[y][x]. */
  get board(): Board {
    return cloneBoard(this.grid);
  }

  get toPlay(): Color {
    return this.turn;
  }

  /** The move records so far (a new array; the records themselves are shared so callers can attach evals). */
  get moves(): MoveRecord[] {
    return this.records.slice();
  }

  get lastMove(): MoveRecord | null {
    return this.records.at(-1) ?? null;
  }

  /** Prisoners: captures.B is the number of white stones black has captured, and vice versa. */
  get captures(): { B: number; W: number } {
    return { ...this.prisoners };
  }

  get consecutivePasses(): number {
    return this.passes;
  }

  /** True after two consecutive passes. */
  get isOver(): boolean {
    return this.passes >= 2;
  }

  /** Why `color` (default: the player to move) cannot play at `point`, or null if the move is legal. */
  illegalReason(point: Point, color: Color = this.turn): IllegalReason | null {
    if (this.isOver) return "game_over";
    if (color !== this.turn) return "not_your_turn";
    const placed = this.place(point, color);
    return "reason" in placed ? placed.reason : null;
  }

  isLegal(point: Point, color: Color = this.turn): boolean {
    return this.illegalReason(point, color) === null;
  }

  play(move: Move): PlayResult {
    if (this.isOver) return { ok: false, reason: "game_over" };
    if (move.color !== this.turn) return { ok: false, reason: "not_your_turn" };
    if ("pass" in move) return { ok: true, record: this.commit({ color: move.color, pass: true }, this.grid, [], this.passes + 1) };
    const placed = this.place(move.point, move.color);
    if ("reason" in placed) return { ok: false, reason: placed.reason };
    return { ok: true, record: this.commit({ color: move.color, point: { ...move.point } }, placed.board, placed.captured, 0) };
  }

  /** Play a stone for the player to move. */
  playAt(point: Point): PlayResult {
    return this.play({ color: this.turn, point });
  }

  /** Pass for the player to move. */
  pass(): PlayResult {
    return this.play({ color: this.turn, pass: true });
  }

  /** Take back up to `n` moves (default 1). Returns the number actually undone. */
  undo(n = 1): number {
    let undone = 0;
    while (undone < n && this.records.length > 0) {
      this.forget(this.grid);
      const snap = this.history.pop()!;
      this.records.pop();
      this.grid = snap.board;
      this.turn = snap.toPlay;
      this.prisoners = snap.captures;
      this.passes = snap.consecutivePasses;
      undone++;
    }
    return undone;
  }

  /** Place a stone on a scratch board: resolve captures, reject occupied, suicide and superko. */
  private place(point: Point, color: Color): { board: Board; captured: Point[] } | { reason: IllegalReason } {
    if (!inBounds(point, this.size)) return { reason: "off_board" };
    if (getCell(this.grid, point) !== null) return { reason: "occupied" };
    const board = cloneBoard(this.grid);
    setCell(board, point, color);
    const captured: Point[] = [];
    const enemy = opponent(color);
    for (const n of neighbors(point, this.size)) {
      if (getCell(board, n) !== enemy) continue;
      const group = groupAt(board, n);
      if (group.liberties > 0) continue;
      for (const stone of group.stones) {
        setCell(board, stone, null);
        captured.push(stone);
      }
    }
    if (captured.length === 0 && groupAt(board, point).liberties === 0) return { reason: "suicide" };
    if (this.seen.has(positionKey(board))) return { reason: "ko" };
    return { board, captured };
  }

  private commit(move: Move, board: Board, captured: Point[], passes: number): MoveRecord {
    this.history.push({ board: this.grid, toPlay: this.turn, captures: this.prisoners, consecutivePasses: this.passes });
    this.grid = board === this.grid ? cloneBoard(board) : board;
    this.prisoners = { ...this.prisoners, [move.color]: this.prisoners[move.color] + captured.length };
    this.turn = opponent(move.color);
    this.passes = passes;
    this.remember(this.grid);
    const record: MoveRecord = { number: this.records.length + 1, move, captures: captured };
    this.records.push(record);
    return record;
  }

  private remember(board: Board): void {
    const key = positionKey(board);
    this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
  }

  private forget(board: Board): void {
    const key = positionKey(board);
    const count = (this.seen.get(key) ?? 0) - 1;
    if (count > 0) this.seen.set(key, count);
    else this.seen.delete(key);
  }
}

