import type { Board, Point } from "../shared/types.ts";
import { GTP_COLUMNS, pointKey } from "../shared/coords.ts";
import { starPoints } from "./board.ts";

/**
 * Text rendering of a board, e.g. for 9×9 with the last move at E5:
 *
 *     A B C D E F G H J
 *   9 . . . . . . . . . 9
 *   ...
 *   5 . . . .(X). . . . 5
 *   ...
 *     A B C D E F G H J
 *
 * Row labels are right-aligned to the widest label (" 9" on 13×13 and 19×19).
 *
 * X = black, O = white, . = empty, + = star point; the last move is wrapped in parentheses.
 */
export function toAscii(board: Board, lastMove?: Point | null): string {
  const size = board.length;
  const stars = new Set(starPoints(size).map(pointKey));
  const width = String(size).length;
  const header = `${" ".repeat(width + 1)}${[...GTP_COLUMNS.slice(0, size)].join(" ")}`;
  const lines = [header];
  board.forEach((row, y) => {
    const label = String(size - y);
    const marked = lastMove && lastMove.y === y ? lastMove.x : -1;
    let line = label.padStart(width);
    row.forEach((cell, x) => {
      const glyph = cell === "B" ? "X" : cell === "W" ? "O" : stars.has(pointKey({ x, y })) ? "+" : ".";
      line += (x === marked ? "(" : marked >= 0 && x === marked + 1 ? ")" : " ") + glyph;
    });
    line += (marked === size - 1 ? ")" : " ") + label;
    lines.push(line);
  });
  lines.push(header);
  return lines.join("\n");
}
