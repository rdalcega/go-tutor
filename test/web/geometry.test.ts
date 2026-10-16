import { describe, expect, it } from "vitest";
import type { GameSettings, GameView, MoveRecord } from "../../src/shared/types.ts";
import {
  backoffDelay,
  canRetry,
  columnLabel,
  computeLayout,
  formatLoss,
  lastHumanMove,
  lossLevel,
  pixelToPoint,
  pointToPixel,
  positionBefore,
  rowLabel,
  secondsLeft,
  sparklinePoints,
} from "../../web/src/geometry.ts";

describe("layout", () => {
  const layout = computeLayout(500, 9);

  it("puts the grid symmetrically inside the board", () => {
    const first = pointToPixel(layout, { x: 0, y: 0 });
    const last = pointToPixel(layout, { x: 8, y: 8 });
    expect(first.x).toBeCloseTo(layout.margin);
    expect(500 - last.x).toBeCloseTo(layout.margin);
    expect(last.y - first.y).toBeCloseTo(8 * layout.cell);
  });

  it("round-trips every intersection", () => {
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const px = pointToPixel(layout, { x, y });
        expect(pixelToPoint(layout, px.x, px.y)).toEqual({ x, y });
        expect(pixelToPoint(layout, px.x + layout.cell * 0.3, px.y - layout.cell * 0.3)).toEqual({ x, y });
      }
    }
  });

  it("rejects clicks between points or off the grid", () => {
    const p = pointToPixel(layout, { x: 3, y: 3 });
    expect(pixelToPoint(layout, p.x + layout.cell * 0.45, p.y + layout.cell * 0.45)).toBeNull();
    expect(pixelToPoint(layout, 2, 2)).toBeNull();
    expect(pixelToPoint(layout, 499, 250)).toBeNull();
  });
});

describe("coordinates", () => {
  it("skips I in column labels and counts rows from the bottom", () => {
    expect(columnLabel(7)).toBe("H");
    expect(columnLabel(8)).toBe("J");
    expect(rowLabel(0, 19)).toBe("19");
    expect(rowLabel(18, 19)).toBe("1");
  });
});

describe("eval helpers", () => {
  it("color codes point loss", () => {
    expect(lossLevel(0)).toBe("good");
    expect(lossLevel(0.99)).toBe("good");
    expect(lossLevel(1)).toBe("inaccuracy");
    expect(lossLevel(3.9)).toBe("inaccuracy");
    expect(lossLevel(4)).toBe("mistake");
  });

  it("formats loss", () => {
    expect(formatLoss(0)).toBe("0.0");
    expect(formatLoss(2.345)).toBe("−2.3");
  });

  it("finds the last human move", () => {
    const rec = (number: number, color: "B" | "W"): MoveRecord => ({
      number,
      move: { color, point: { x: 0, y: number } },
      captures: [],
    });
    expect(lastHumanMove([rec(1, "B"), rec(2, "W")], "B")?.number).toBe(1);
    expect(lastHumanMove([rec(1, "B")], "W")).toBeNull();
  });

  it("scales the sparkline with a floor and dips on bigger losses", () => {
    const pts = sparklinePoints([0, 8, 2], 100, 40, 8, 0);
    expect(pts.map((p) => p.x)).toEqual([0, 50, 100]);
    expect(pts[0]!.y).toBe(0);
    expect(pts[1]!.y).toBe(40);
    expect(pts[2]!.y).toBe(10);
    expect(sparklinePoints([], 100, 40)).toEqual([]);
    expect(sparklinePoints([1], 100, 40)[0]!.x).toBe(50);
  });
});

describe("teaching moments", () => {
  const settings: GameSettings = { size: 9, komi: 7, humanColor: "B", botRank: "20k", handicap: 0 };
  const moves: MoveRecord[] = [
    { number: 1, move: { color: "B", point: { x: 4, y: 4 } }, captures: [] },
    { number: 2, move: { color: "W", point: { x: 2, y: 2 } }, captures: [] },
    { number: 3, move: { color: "B", point: { x: 2, y: 6 } }, captures: [] },
  ];

  it("rebuilds the board from before a move, for a variation drawn there", () => {
    const before = positionBefore(moves, settings, 3)!;
    expect(before.board[6]![2]).toBeNull(); // move 3 isn't on it
    expect(before.board[4]![4]).toBe("B");
    expect(before.board[2]![2]).toBe("W");
    expect(before.lastMove).toEqual({ x: 2, y: 2 });
    expect(positionBefore(moves, settings, 1)!.board.flat().every((c) => c === null)).toBe(true);
    expect(positionBefore(moves, settings, 4)).toBeNull(); // taken back already
  });

  it("offers Try again only while the moment's move is on the board", () => {
    const view = (over: Partial<GameView>): GameView => ({
      gameId: "g",
      mode: "game",
      settings,
      status: "paused",
      board: [],
      toPlay: "W",
      moves,
      captures: { B: 0, W: 0 },
      result: null,
      moment: { id: "m", moveNumber: 3, pointLoss: 6, state: "fallback" },
      overlay: null,
      chat: [],
      tutorAttached: false,
      engineBusy: false,
      ...over,
    });
    expect(canRetry(view({}))).toBe(true);
    // After the tutor's rethink the move is gone and the server would refuse.
    expect(canRetry(view({ status: "playing", toPlay: "B", moves: moves.slice(0, 2), moment: { id: "m", moveNumber: 3, pointLoss: 6, state: "tutor" } }))).toBe(false);
    expect(canRetry(view({ status: "finished" }))).toBe(false);
    expect(canRetry(view({ moves: [], moment: null }))).toBe(false);
  });
});

describe("timing", () => {
  it("counts down whole seconds", () => {
    expect(secondsLeft(10_000, 0)).toBe(10);
    expect(secondsLeft(10_000, 9_001)).toBe(1);
    expect(secondsLeft(10_000, 12_000)).toBe(0);
  });

  it("backs off exponentially with a cap", () => {
    expect(backoffDelay(0)).toBe(500);
    expect(backoffDelay(3)).toBe(4000);
    expect(backoffDelay(20)).toBe(10_000);
  });
});
