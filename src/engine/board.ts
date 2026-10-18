import { isBoardSize, type Board, type Cell, type Color, type Point } from "../shared/types.ts";
import { pointKey } from "../shared/coords.ts";

export function opponent(color: Color): Color {
  return color === "B" ? "W" : "B";
}

export function emptyBoard(size: number): Board {
  return Array.from({ length: size }, () => Array<Cell>(size).fill(null));
}

export function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice());
}

export function getCell(board: Board, p: Point): Cell {
  return board[p.y]?.[p.x] ?? null;
}

export function setCell(board: Board, p: Point, cell: Cell): void {
  const row = board[p.y];
  if (!row || p.x < 0 || p.x >= row.length) throw new RangeError(`Point (${p.x}, ${p.y}) is off the board`);
  row[p.x] = cell;
}

export function neighbors(p: Point, size: number): Point[] {
  const out: Point[] = [];
  if (p.x > 0) out.push({ x: p.x - 1, y: p.y });
  if (p.x < size - 1) out.push({ x: p.x + 1, y: p.y });
  if (p.y > 0) out.push({ x: p.x, y: p.y - 1 });
  if (p.y < size - 1) out.push({ x: p.x, y: p.y + 1 });
  return out;
}

/**
 * The connected chain of same-colored cells containing `start` (empty regions work too), its
 * liberty count and its liberties (as `pointKey`s).
 */
export function groupAt(board: Board, start: Point): { stones: Point[]; liberties: number; libertySet: Set<string> } {
  const size = board.length;
  const color = getCell(board, start);
  const seen = new Set([pointKey(start)]);
  const libs = new Set<string>();
  const stones: Point[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const p = stack.pop()!;
    stones.push(p);
    for (const n of neighbors(p, size)) {
      const key = pointKey(n);
      const cell = getCell(board, n);
      if (cell === color) {
        if (!seen.has(key)) {
          seen.add(key);
          stack.push(n);
        }
      } else if (cell === null) {
        libs.add(key);
      }
    }
  }
  return { stones, liberties: libs.size, libertySet: libs };
}

/** A board from a diagram: one string per row, top row first, cells X (Black) / O (White) / . (spaces ignored). */
export function boardFromDiagram(rows: readonly string[]): Board {
  const size = rows.length;
  const board = emptyBoard(size);
  rows.forEach((row, y) => {
    const cells = row.replace(/\s+/g, "");
    if (cells.length !== size) throw new Error(`Diagram row ${y + 1} has ${cells.length} cells, expected ${size}: "${row}"`);
    [...cells].forEach((c, x) => {
      if (c === "X") setCell(board, { x, y }, "B");
      else if (c === "O") setCell(board, { x, y }, "W");
      else if (c !== ".") throw new Error(`Diagram row ${y + 1} has an unknown cell "${c}"`);
    });
  });
  return board;
}

/** The stones on a board, row by row from the top-left. */
export function boardStones(board: Board): { color: Color; point: Point }[] {
  const stones: { color: Color; point: Point }[] = [];
  board.forEach((row, y) => row.forEach((c, x) => c && stones.push({ color: c, point: { x, y } })));
  return stones;
}

/** Compact string of the board's contents, for positional-superko checks. */
export function positionKey(board: Board): string {
  return board.map((row) => row.map((c) => c ?? ".").join("")).join("/");
}

function edgeOffset(size: number): number {
  return size >= 13 ? 3 : 2;
}

/** Star points (hoshi) for 9×9, 13×13 and 19×19; none for other sizes. */
export function starPoints(size: number): Point[] {
  if (!isBoardSize(size)) return [];
  const lo = edgeOffset(size);
  const hi = size - 1 - lo;
  const mid = (size - 1) / 2;
  const coords = size === 19 ? [lo, mid, hi] : [lo, hi];
  const points = coords.flatMap((y) => coords.map((x) => ({ x, y })));
  if (size !== 19) points.push({ x: mid, y: mid });
  return points;
}

/**
 * Standard fixed handicap placement (GTP `fixed_handicap` order), 2–9 stones on odd boards ≥ 7.
 * 0 and 1 mean no stones.
 */
export function handicapPoints(size: number, stones: number): Point[] {
  if (!Number.isInteger(stones) || stones < 0 || stones > 9) {
    throw new RangeError(`Handicap must be an integer from 0 to 9 (got ${stones})`);
  }
  if (stones < 2) return [];
  if (size < 7 || size % 2 === 0) throw new RangeError(`No standard handicap placement on a ${size}×${size} board`);
  const lo = edgeOffset(size);
  const hi = size - 1 - lo;
  const mid = (size - 1) / 2;
  // [x, y] with y measured from the top. Order: D4 Q16 D16 Q4, then center/sides per GTP.
  const lowerLeft: [number, number] = [lo, hi];
  const upperRight: [number, number] = [hi, lo];
  const upperLeft: [number, number] = [lo, lo];
  const lowerRight: [number, number] = [hi, hi];
  const center: [number, number] = [mid, mid];
  const leftSide: [number, number] = [lo, mid];
  const rightSide: [number, number] = [hi, mid];
  const bottomSide: [number, number] = [mid, hi];
  const topSide: [number, number] = [mid, lo];
  const corners = [lowerLeft, upperRight, upperLeft, lowerRight];
  const layouts: Record<number, [number, number][]> = {
    2: corners.slice(0, 2),
    3: corners.slice(0, 3),
    4: corners,
    5: [...corners, center],
    6: [...corners, leftSide, rightSide],
    7: [...corners, leftSide, rightSide, center],
    8: [...corners, leftSide, rightSide, bottomSide, topSide],
    9: [...corners, leftSide, rightSide, bottomSide, topSide, center],
  };
  return layouts[stones]!.map(([x, y]) => ({ x, y }));
}

/** The handicap stones themselves (Black's) for `stones` on a `size` board, as placed stones. */
export function handicapStones(size: number, stones: number): { color: Color; point: Point }[] {
  return handicapPoints(size, stones).map((point) => ({ color: "B" as const, point }));
}
