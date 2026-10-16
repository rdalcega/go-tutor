import { boardFromDiagram } from "../../src/engine/board.ts";
import type { Board } from "../../src/shared/types.ts";

/** A board from a diagram: rows top to bottom, X = black, O = white, . = empty (src/engine). */
export const boardFrom = boardFromDiagram;

export function diagram(board: Board): string[] {
  return board.map((row) => row.map((c) => (c === "B" ? "X" : c === "W" ? "O" : ".")).join(" "));
}
