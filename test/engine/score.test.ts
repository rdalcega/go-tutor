import { describe, expect, it } from "vitest";
import { deadStonesFromOwnership, scoreArea } from "../../src/engine/score.ts";
import { emptyBoard } from "../../src/engine/board.ts";
import { boardFrom } from "./helpers.ts";

const wall = boardFrom([
  ". X O . .",
  ". X O . .",
  ". X O . .",
  ". X O . .",
  ". X O . .",
]);

/** Black-positive ownership: columns 0–1 black, the rest white. */
function splitOwnership(size: number, blackColumns: number): number[] {
  return Array.from({ length: size * size }, (_, i) => (i % size < blackColumns ? 1 : -1));
}

describe("scoreArea", () => {
  it("counts stones plus surrounded territory", () => {
    const s = scoreArea(wall, 0);
    expect(s.black).toBe(10);
    expect(s.white).toBe(15);
    expect(s.margin).toBe(-5);
    expect(s.winner).toBe("W");
  });

  it("adds komi to white", () => {
    const s = scoreArea(wall, 0.5);
    expect(s.margin).toBe(-5.5);
    const reversed = scoreArea(
      boardFrom([". . O X .", ". . O X .", ". . O X .", ". . O X .", ". . O X ."]),
      7,
    );
    expect(reversed.black).toBe(10);
    expect(reversed.white).toBe(15);
    expect(reversed.margin).toBe(-12);
  });

  it("reports a draw as no winner", () => {
    const s = scoreArea(wall, -5);
    expect(s.margin).toBe(0);
    expect(s.winner).toBeNull();
  });

  it("leaves dame neutral", () => {
    const board = boardFrom([
      ". X . O .",
      ". X . O .",
      ". X . O .",
      ". X . O .",
      ". X . O .",
    ]);
    const s = scoreArea(board, 7);
    expect(s.black).toBe(10);
    expect(s.white).toBe(10);
    expect(s.margin).toBe(-7);
    expect(s.owner[0]).toEqual(["B", "B", null, "W", "W"]);
  });

  it("scores an empty board as all neutral", () => {
    const s = scoreArea(emptyBoard(9), 7);
    expect(s.black).toBe(0);
    expect(s.white).toBe(0);
    expect(s.margin).toBe(-7);
  });

  it("removes dead stones before counting", () => {
    const board = boardFrom([
      ". X O . .",
      ". X O . .",
      "O X O . .",
      ". X O X .",
      ". X O . .",
    ]);
    const alive = scoreArea(board, 0);
    // Without removal the white stone at (0,2) spoils black's territory and the black stone at (3,3) white's.
    expect(alive.black).toBe(6);
    expect(alive.white).toBe(6);

    const s = scoreArea(board, 0, [{ x: 0, y: 2 }, { x: 3, y: 3 }]);
    expect(s.black).toBe(10);
    expect(s.white).toBe(15);
    expect(s.dead).toEqual([{ x: 0, y: 2 }, { x: 3, y: 3 }]);
    expect(s.owner[2]![0]).toBe("B");
    expect(s.owner[3]![3]).toBe("W");
  });

  it("ignores dead-stone points that are empty", () => {
    const s = scoreArea(wall, 0, [{ x: 0, y: 0 }]);
    expect(s.dead).toEqual([]);
    expect(s.black).toBe(10);
  });

  it("does not modify the input board", () => {
    const board = boardFrom(["O X .", "X . .", ". . ."]);
    scoreArea(board, 0, [{ x: 0, y: 0 }]);
    expect(board[0]![0]).toBe("W");
  });
});

describe("dead stones from ownership", () => {
  const board = boardFrom([
    ". X O . .",
    ". X O . .",
    "O X O . .",
    ". X O X .",
    ". X O . .",
  ]);

  it("marks stones owned by the other color as dead", () => {
    expect(deadStonesFromOwnership(board, splitOwnership(5, 2))).toEqual([
      { x: 0, y: 2 },
      { x: 3, y: 3 },
    ]);
  });

  it("uses a 0.5 threshold by default", () => {
    const ownership = splitOwnership(5, 2).map((v) => v * 0.4);
    expect(deadStonesFromOwnership(board, ownership)).toEqual([]);
    expect(deadStonesFromOwnership(board, ownership, 0.3)).toHaveLength(2);
    const strong = splitOwnership(5, 2).map((v) => v * 0.6);
    expect(deadStonesFromOwnership(board, strong)).toHaveLength(2);
  });

  it("never marks stones on their own color's ground", () => {
    expect(deadStonesFromOwnership(wall, splitOwnership(5, 2))).toEqual([]);
  });

  it("rejects an ownership array of the wrong size", () => {
    expect(() => deadStonesFromOwnership(board, [0, 0, 0])).toThrow(RangeError);
  });

  it("scores with ownership in one step", () => {
    const s = scoreArea(board, 7, deadStonesFromOwnership(board, splitOwnership(5, 2)));
    expect(s.black).toBe(10);
    expect(s.white).toBe(15);
    expect(s.margin).toBe(-12);
    expect(s.winner).toBe("W");
  });
});
