import type { Board, Cell, Color, GameResult, Point } from "../shared/types.ts";
import { pointKey } from "../shared/coords.ts";
import { cloneBoard, getCell, groupAt, neighbors, setCell } from "./board.ts";

export interface AreaScore {
  /** Black stones + black territory (after removing dead stones). */
  black: number;
  /** White stones + white territory (komi not included). */
  white: number;
  komi: number;
  /** black - (white + komi). */
  margin: number;
  winner: Color | null;
  /** Who owns each point after scoring; null = dame / neutral. board[y][x]. */
  owner: Cell[][];
  /** The dead stones that were removed before counting. */
  dead: Point[];
}

/**
 * Dead stones from a KataGo ownership array (row-major from the top-left, length size*size,
 * +1 = black owns, -1 = white owns). Callers must normalize KataGo's output to black's perspective.
 * A stone is dead when ownership favors the other color by more than `threshold`.
 */
export function deadStonesFromOwnership(board: Board, ownership: readonly number[], threshold = 0.5): Point[] {
  const size = board.length;
  if (ownership.length !== size * size) {
    throw new RangeError(`Ownership has ${ownership.length} values; expected ${size * size}`);
  }
  const dead: Point[] = [];
  board.forEach((row, y) =>
    row.forEach((cell, x) => {
      const own = ownership[y * size + x]!;
      if ((cell === "B" && own < -threshold) || (cell === "W" && own > threshold)) dead.push({ x, y });
    }),
  );
  return dead;
}

/** Area (Chinese-style) scoring: stones + surrounded empty points, with komi added to white. */
export function scoreArea(board: Board, komi: number, dead: Iterable<Point> = []): AreaScore {
  const size = board.length;
  const live = cloneBoard(board);
  const removed: Point[] = [];
  for (const p of dead) {
    if (getCell(live, p) === null) continue;
    setCell(live, p, null);
    removed.push(p);
  }

  const owner: Cell[][] = cloneBoard(live);
  const visited = new Set<string>();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const start = { x, y };
      if (getCell(live, start) !== null || visited.has(pointKey(start))) continue;
      const region = groupAt(live, start).stones;
      const borders = regionBorders(live, region);
      const regionOwner = borders.size === 1 ? [...borders][0]! : null;
      for (const p of region) {
        visited.add(pointKey(p));
        setCell(owner, p, regionOwner);
      }
    }
  }

  let black = 0;
  let white = 0;
  for (const row of owner) {
    for (const cell of row) {
      if (cell === "B") black++;
      else if (cell === "W") white++;
    }
  }
  const margin = black - white - komi;
  return { black, white, komi, margin, winner: margin > 0 ? "B" : margin < 0 ? "W" : null, owner, dead: removed };
}

/** Score using KataGo ownership to decide which stones are dead. */
export function scoreWithOwnership(board: Board, komi: number, ownership: readonly number[], threshold = 0.5): AreaScore {
  return scoreArea(board, komi, deadStonesFromOwnership(board, ownership, threshold));
}

export function toGameResult(score: AreaScore): GameResult {
  return { winner: score.winner, margin: score.margin, reason: "score" };
}

function regionBorders(board: Board, region: Point[]): Set<Color> {
  const size = board.length;
  const colors = new Set<Color>();
  for (const p of region) {
    for (const n of neighbors(p, size)) {
      const cell = getCell(board, n);
      if (cell !== null) colors.add(cell);
    }
  }
  return colors;
}
