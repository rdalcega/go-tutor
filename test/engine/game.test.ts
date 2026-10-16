import { describe, expect, it } from "vitest";
import { GoGame } from "../../src/engine/game.ts";
import { handicapPoints, starPoints } from "../../src/engine/board.ts";
import { fromGtp, toGtp } from "../../src/shared/coords.ts";
import type { Color, Point } from "../../src/shared/types.ts";
import { diagram, stonesFrom } from "./helpers.ts";

function position(rows: string[], toPlay: Color = "B"): GoGame {
  return new GoGame(rows.length, 0, 0, { stones: stonesFrom(rows), toPlay });
}

function at(x: number, y: number): Point {
  return { x, y };
}

describe("basic play", () => {
  it("alternates colors starting with black", () => {
    const g = new GoGame(9, 7);
    expect(g.toPlay).toBe("B");
    const r = g.playAt(fromGtp("E5", 9)!);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record).toEqual({ number: 1, move: { color: "B", point: { x: 4, y: 4 } }, captures: [] });
    expect(g.toPlay).toBe("W");
    expect(g.board[4]![4]).toBe("B");
  });

  it("rejects moving out of turn, occupied points and off-board points", () => {
    const g = new GoGame(9, 7);
    expect(g.play({ color: "W", point: at(0, 0) })).toEqual({ ok: false, reason: "not_your_turn" });
    g.playAt(at(2, 2));
    expect(g.playAt(at(2, 2))).toEqual({ ok: false, reason: "occupied" });
    expect(g.playAt(at(9, 0))).toEqual({ ok: false, reason: "off_board" });
    expect(g.moves).toHaveLength(1);
  });

  it("returns a copy of the board", () => {
    const g = new GoGame(9, 7);
    g.board[0]![0] = "W";
    expect(g.board[0]![0]).toBeNull();
  });

  it("shares move records so evals attached by callers persist", () => {
    const g = new GoGame(9, 7);
    g.playAt(at(0, 0));
    g.moves[0]!.eval = { leadBefore: 0, leadAfter: 0, pointLoss: 0, winrateBefore: 0.5, winrateAfter: 0.5, bestMove: "E5", bestPv: [], candidates: [] };
    g.playAt(at(1, 1));
    expect(g.moves[0]!.eval?.bestMove).toBe("E5");
  });

  it("does not let callers mutate the played move", () => {
    const g = new GoGame(9, 7);
    const point = at(3, 3);
    g.playAt(point);
    point.x = 0;
    expect(g.moves[0]!.move).toEqual({ color: "B", point: { x: 3, y: 3 } });
  });
});

describe("captures", () => {
  it("captures a single stone", () => {
    const g = position([
      ". X . . .",
      "X O X . .",
      ". . . . .",
      ". . . . .",
      ". . . . .",
    ]);
    const r = g.playAt(at(1, 2));
    expect(r.ok && r.record.captures).toEqual([at(1, 1)]);
    expect(g.board[1]![1]).toBeNull();
    expect(g.captures).toEqual({ B: 1, W: 0 });
  });

  it("captures several groups with one move", () => {
    const g = position([
      "X O . O X",
      "X O X O X",
      ". X . X .",
      ". . . . .",
      ". . . . .",
    ]);
    const r = g.playAt(at(2, 0));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.captures).toHaveLength(4);
    expect(diagram(g.board).slice(0, 2)).toEqual(["X . X . X", "X . X . X"]);
    expect(g.captures.B).toBe(4);
  });

  it("captures on the edge", () => {
    const g = position([
      ". X O X .",
      ". . . . .",
      ". . . . .",
      ". . . . .",
      ". . . . .",
    ]);
    const r = g.playAt(at(2, 1));
    expect(r.ok && r.record.captures).toEqual([at(2, 0)]);
  });

  it("captures in the corner", () => {
    const g = position(
      [
        ". . . . .",
        ". . . . .",
        ". . . . .",
        ". . . . .",
        ". . . O X",
      ],
      "W",
    );
    const r = g.playAt(at(4, 3));
    expect(r.ok && r.record.captures).toEqual([at(4, 4)]);
    expect(g.captures).toEqual({ B: 0, W: 1 });
  });

  it("captures a larger group", () => {
    const g = position([
      "O O O X .",
      "X X O X .",
      ". X . . .",
      ". . . . .",
      ". . . . .",
    ]);
    const r = g.playAt(at(2, 2));
    expect(r.ok && r.record.captures).toHaveLength(4);
    expect(diagram(g.board)[0]).toBe(". . . X .");
  });
});

describe("suicide", () => {
  it("forbids single-stone suicide", () => {
    const g = position(
      [
        ". X . . .",
        "X . . . .",
        ". . . . .",
        ". . . . .",
        ". . . . .",
      ],
      "W",
    );
    expect(g.playAt(at(0, 0))).toEqual({ ok: false, reason: "suicide" });
    expect(g.isLegal(at(0, 0))).toBe(false);
    expect(g.board[0]![0]).toBeNull();
    expect(g.toPlay).toBe("W");
  });

  it("forbids multi-stone suicide", () => {
    const g = position(
      [
        ". O X . .",
        "O X . . .",
        "X . . . .",
        ". . . . .",
        ". . . . .",
      ],
      "W",
    );
    expect(g.playAt(at(0, 0))).toEqual({ ok: false, reason: "suicide" });
  });

  it("allows a move without liberties when it captures", () => {
    const g = position([
      ". X O . .",
      "X O . O .",
      ". X O . .",
      ". . . . .",
      ". . . . .",
    ]);
    const r = g.playAt(at(2, 1));
    expect(r.ok && r.record.captures).toEqual([at(1, 1)]);
  });
});

describe("ko", () => {
  const koShape = [
    ". X O . .",
    "X O . O .",
    ". X O . .",
    ". . . . .",
    ". . . . .",
  ];

  it("forbids the immediate retake", () => {
    const g = position(koShape);
    expect(g.playAt(at(2, 1)).ok).toBe(true);
    expect(g.illegalReason(at(1, 1))).toBe("ko");
    expect(g.playAt(at(1, 1))).toEqual({ ok: false, reason: "ko" });
  });

  it("allows the retake after a ko threat exchange", () => {
    const g = position(koShape);
    g.playAt(at(2, 1));
    g.playAt(at(4, 4)); // white threat elsewhere
    g.playAt(at(4, 3)); // black answers
    const r = g.playAt(at(1, 1));
    expect(r.ok && r.record.captures).toEqual([at(2, 1)]);
  });

  it("lifts the ko ban when the capture is undone", () => {
    const g = position(koShape);
    g.playAt(at(2, 1));
    g.undo();
    // The position after the capture was forgotten, so repeating the capture is not a superko repeat.
    expect(g.playAt(at(2, 1)).ok).toBe(true);
  });

  it("applies positional superko beyond the simple ko", () => {
    // On 2×2: B a, W b, B c captured by W d, B a again, W fills c capturing a,
    // then B a would capture all three white stones and recreate the position after move 1.
    const g = new GoGame(2, 0);
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1], [0, 0], [0, 1]] as const) {
      expect(g.playAt(at(x, y)).ok).toBe(true);
    }
    expect(diagram(g.board)).toEqual([". O", "O O"]);
    expect(g.playAt(at(0, 0))).toEqual({ ok: false, reason: "ko" });
  });
});

describe("passing and game end", () => {
  it("ends after two consecutive passes", () => {
    const g = new GoGame(9, 7);
    g.pass();
    expect(g.isOver).toBe(false);
    expect(g.consecutivePasses).toBe(1);
    const r = g.pass();
    expect(r.ok && r.record).toEqual({ number: 2, move: { color: "W", pass: true }, captures: [] });
    expect(g.isOver).toBe(true);
    expect(g.playAt(at(0, 0))).toEqual({ ok: false, reason: "game_over" });
    expect(g.pass()).toEqual({ ok: false, reason: "game_over" });
  });

  it("resets the pass count after a stone", () => {
    const g = new GoGame(9, 7);
    g.pass();
    g.playAt(at(0, 0));
    expect(g.consecutivePasses).toBe(0);
    g.pass();
    expect(g.isOver).toBe(false);
  });

  it("can resume after undoing the final pass", () => {
    const g = new GoGame(9, 7);
    g.pass();
    g.pass();
    expect(g.undo()).toBe(1);
    expect(g.isOver).toBe(false);
    expect(g.toPlay).toBe("W");
    expect(g.playAt(at(4, 4)).ok).toBe(true);
  });
});

describe("undo", () => {
  it("restores board, turn and captures", () => {
    const g = position([
      ". X . . .",
      "X O X . .",
      ". . . . .",
      ". . . . .",
      ". . . . .",
    ]);
    const before = diagram(g.board);
    g.playAt(at(1, 2));
    expect(g.undo()).toBe(1);
    expect(diagram(g.board)).toEqual(before);
    expect(g.captures).toEqual({ B: 0, W: 0 });
    expect(g.toPlay).toBe("B");
    expect(g.moves).toHaveLength(0);
  });

  it("undoes several moves and stops at the start", () => {
    const g = new GoGame(9, 7);
    g.playAt(at(0, 0));
    g.playAt(at(1, 1));
    g.playAt(at(2, 2));
    expect(g.undo(2)).toBe(2);
    expect(g.moves.map((m) => m.number)).toEqual([1]);
    expect(g.toPlay).toBe("W");
    expect(g.undo(5)).toBe(1);
    expect(g.undo()).toBe(0);
    expect(g.board.flat().every((c) => c === null)).toBe(true);
  });

  it("numbers moves correctly after undo", () => {
    const g = new GoGame(9, 7);
    g.playAt(at(0, 0));
    g.playAt(at(1, 1));
    g.undo();
    const r = g.playAt(at(2, 2));
    expect(r.ok && r.record.number).toBe(2);
  });
});

describe("handicap", () => {
  it("places standard stones and lets white move first", () => {
    const g = new GoGame(9, 0.5, 2);
    expect(g.toPlay).toBe("W");
    expect(g.initialPlayer).toBe("W");
    expect(g.initialStones.map((s) => toGtp(s.point, 9))).toEqual(["C3", "G7"]);
    expect(g.board[6]![2]).toBe("B");
    expect(g.play({ color: "B", point: at(0, 0) })).toEqual({ ok: false, reason: "not_your_turn" });
    expect(g.playAt(at(4, 4)).ok).toBe(true);
  });

  it("uses GTP fixed_handicap placement on 19×19", () => {
    const names = (n: number) => handicapPoints(19, n).map((p) => toGtp(p, 19));
    expect(names(2)).toEqual(["D4", "Q16"]);
    expect(names(3)).toEqual(["D4", "Q16", "D16"]);
    expect(names(4)).toEqual(["D4", "Q16", "D16", "Q4"]);
    expect(names(5)).toEqual(["D4", "Q16", "D16", "Q4", "K10"]);
    expect(names(6)).toEqual(["D4", "Q16", "D16", "Q4", "D10", "Q10"]);
    expect(names(7)).toEqual(["D4", "Q16", "D16", "Q4", "D10", "Q10", "K10"]);
    expect(names(8)).toEqual(["D4", "Q16", "D16", "Q4", "D10", "Q10", "K4", "K16"]);
    expect(new Set(names(9))).toEqual(new Set(starPoints(19).map((p) => toGtp(p, 19))));
  });

  it("uses the 4-4 points on 13×13", () => {
    expect(handicapPoints(13, 5).map((p) => toGtp(p, 13))).toEqual(["D4", "K10", "D10", "K4", "G7"]);
  });

  it("treats 0 and 1 as no handicap stones", () => {
    expect(new GoGame(9, 7, 0).toPlay).toBe("B");
    const g = new GoGame(9, 0.5, 1);
    expect(g.initialStones).toHaveLength(0);
    expect(g.toPlay).toBe("B");
  });

  it("rejects impossible handicaps", () => {
    expect(() => new GoGame(9, 0.5, 10)).toThrow(RangeError);
    expect(() => new GoGame(9, 0.5, -1)).toThrow(RangeError);
    expect(() => new GoGame(9, 0.5, 2.5)).toThrow(RangeError);
  });
});

describe("fromMoves", () => {
  it("replays a move list", () => {
    const g = new GoGame(9, 7);
    g.playAt(at(2, 2));
    g.playAt(at(6, 6));
    g.pass();
    const copy = GoGame.fromMoves(9, 7, 0, g.moves.map((m) => m.move));
    expect(copy.board).toEqual(g.board);
    expect(copy.toPlay).toBe(g.toPlay);
    expect(copy.consecutivePasses).toBe(1);
  });

  it("throws on an illegal move", () => {
    expect(() =>
      GoGame.fromMoves(9, 7, 0, [
        { color: "B", point: at(0, 0) },
        { color: "W", point: at(0, 0) },
      ]),
    ).toThrow(/Move 2 is illegal: occupied/);
  });
});
