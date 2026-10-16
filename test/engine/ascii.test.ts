import { describe, expect, it } from "vitest";
import { toAscii } from "../../src/engine/ascii.ts";
import { emptyBoard } from "../../src/engine/board.ts";
import { GoGame } from "../../src/engine/game.ts";
import { fromGtp } from "../../src/shared/coords.ts";

describe("toAscii", () => {
  it("renders an empty 9×9 board with star points", () => {
    expect(toAscii(emptyBoard(9))).toBe(
      [
        "  A B C D E F G H J",
        "9 . . . . . . . . . 9",
        "8 . . . . . . . . . 8",
        "7 . . + . . . + . . 7",
        "6 . . . . . . . . . 6",
        "5 . . . . + . . . . 5",
        "4 . . . . . . . . . 4",
        "3 . . + . . . + . . 3",
        "2 . . . . . . . . . 2",
        "1 . . . . . . . . . 1",
        "  A B C D E F G H J",
      ].join("\n"),
    );
  });

  it("shows stones and wraps the last move in parentheses", () => {
    const g = new GoGame(9, 7);
    g.playAt(fromGtp("E5", 9)!);
    g.playAt(fromGtp("C3", 9)!);
    g.playAt(fromGtp("D5", 9)!);
    const lines = toAscii(g.board, fromGtp("D5", 9)).split("\n");
    expect(lines[5]).toBe("5 . . .(X)X . . . . 5");
    expect(lines[7]).toBe("3 . . O . . . + . . 3");
  });

  it("marks last moves on the edges", () => {
    const g = new GoGame(9, 7);
    g.playAt(fromGtp("A9", 9)!);
    g.playAt(fromGtp("J1", 9)!);
    expect(toAscii(g.board, fromGtp("A9", 9)).split("\n")[1]).toBe("9(X). . . . . . . . 9");
    expect(toAscii(g.board, fromGtp("J1", 9)).split("\n")[9]).toBe("1 . . . . . . . .(O)1");
  });

  it("right-aligns two-digit row labels on 19×19", () => {
    const lines = toAscii(emptyBoard(19)).split("\n");
    expect(lines[0]).toBe("   A B C D E F G H J K L M N O P Q R S T");
    expect(lines[1]).toBe("19 . . . . . . . . . . . . . . . . . . . 19");
    expect(lines[4]).toBe("16 . . . + . . . . . + . . . . . + . . . 16");
    expect(lines[19]).toBe(" 1 . . . . . . . . . . . . . . . . . . . 1");
    expect(lines).toHaveLength(21);
  });

  it("puts five star points on 13×13", () => {
    const text = toAscii(emptyBoard(13));
    expect(text.match(/\+/g)).toHaveLength(5);
    expect(text.split("\n")[4]).toBe("10 . . . + . . . . . + . . . 10");
  });
});
