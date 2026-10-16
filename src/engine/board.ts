import type { Board, Cell, Color, Point } from "../shared/types.ts";
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

/** The connected chain of same-colored cells containing `start` (empty regions work too), and its liberties. */
export function groupAt(board: Board, start: Point): { stones: Point[]; liberties: number } {
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
  return { stones, liberties: libs.size };
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
  if (size !== 9 && size !== 13 && size !== 19) return [];
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
