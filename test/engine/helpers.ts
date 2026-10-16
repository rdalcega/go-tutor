import type { Board, Color, Point } from "../../src/shared/types.ts";

/** Stones from a diagram: rows top to bottom, X = black, O = white, anything else empty. Spaces are ignored. */
export function stonesFrom(rows: string[]): { color: Color; point: Point }[] {
  const out: { color: Color; point: Point }[] = [];
  rows.forEach((row, y) => {
    [...row.replace(/ /g, "")].forEach((ch, x) => {
      if (ch === "X") out.push({ color: "B", point: { x, y } });
      if (ch === "O") out.push({ color: "W", point: { x, y } });
    });
  });
  return out;
}

export function boardFrom(rows: string[]): Board {
  const size = rows.length;
  const board: Board = Array.from({ length: size }, () => Array(size).fill(null));
  for (const s of stonesFrom(rows)) board[s.point.y]![s.point.x] = s.color;
  return board;
}

export function diagram(board: Board): string[] {
  return board.map((row) => row.map((c) => (c === "B" ? "X" : c === "W" ? "O" : ".")).join(" "));
}
