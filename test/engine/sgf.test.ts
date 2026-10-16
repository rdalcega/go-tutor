import { describe, expect, it } from "vitest";
import { formatResult, parseResult, parseSgf, settingsFromSgf, writeSgf } from "../../src/engine/sgf.ts";
import { GoGame } from "../../src/engine/game.ts";
import { fromGtp } from "../../src/shared/coords.ts";
import type { GameSettings, Move } from "../../src/shared/types.ts";

const settings: GameSettings = { size: 9, komi: 7, humanColor: "B", botRank: "20k", handicap: 0 };

function playMoves(game: GoGame, gtps: string[]): void {
  for (const gtp of gtps) {
    const point = fromGtp(gtp, game.size);
    const r = point ? game.playAt(point) : game.pass();
    if (!r.ok) throw new Error(`${gtp}: ${r.reason}`);
  }
}

describe("writeSgf", () => {
  it("writes the root properties and moves", () => {
    const moves: Move[] = [
      { color: "B", point: { x: 4, y: 4 } },
      { color: "W", point: { x: 2, y: 6 } },
      { color: "B", pass: true },
    ];
    const sgf = writeSgf(settings, moves, { winner: "B", margin: 3.5, reason: "score" });
    expect(sgf).toBe(
      "(;GM[1]FF[4]CA[UTF-8]AP[GoTutor]RU[Chinese]SZ[9]KM[7]PB[Human]PW[KataGo 20k]RE[B+3.5]\n;B[ee]\n;W[cg]\n;B[])\n",
    );
  });

  it("writes handicap stones and escapes comments", () => {
    const sgf = writeSgf({ ...settings, size: 19, handicap: 2, komi: 0.5, humanColor: "W" }, [], null, {
      0: "Root note",
    });
    expect(sgf).toContain("HA[2]");
    expect(sgf).toContain("AB[dp][pd]");
    expect(sgf).toContain("PB[KataGo 20k]PW[Human]");
    expect(sgf).toContain("C[Root note]");
    expect(sgf).not.toContain("RE[");

    const escaped = writeSgf(settings, [{ color: "B", point: { x: 0, y: 0 } }], null, new Map([[1, "a]b\\c"]]));
    expect(escaped).toContain("B[aa]C[a\\]b\\\\c]");
  });
});

describe("parseSgf", () => {
  it("round-trips a game with captures, passes, comments and a result", () => {
    const game = new GoGame(9, 7);
    playMoves(game, ["E5", "D5", "D4", "C4", "D6", "C5", "E4", "pass", "D3", "pass"]);
    const comments = new Map([
      [0, "Game start"],
      [3, "Good: D4 [solid]\nnext line"],
      [8, "Pass?"],
    ]);
    const result = { winner: "B" as const, margin: 12, reason: "score" as const };
    const parsed = parseSgf(writeSgf(settings, game.moves, result, comments));

    expect(parsed.size).toBe(9);
    expect(parsed.komi).toBe(7);
    expect(parsed.handicap).toBe(0);
    expect(parsed.setup).toEqual([]);
    expect(parsed.moves).toEqual(game.moves.map((m) => m.move));
    expect(parsed.comments).toEqual(comments);
    expect(parsed.result).toEqual(result);
    expect(parsed.playerBlack).toBe("Human");
    expect(parsed.playerWhite).toBe("KataGo 20k");
    expect(settingsFromSgf(parsed)).toEqual(settings);

    const replay = GoGame.fromMoves(parsed.size, parsed.komi, parsed.handicap, parsed.moves);
    expect(replay.board).toEqual(game.board);
  });

  it("round-trips handicap games", () => {
    const hcSettings: GameSettings = { size: 13, komi: 0.5, humanColor: "B", botRank: "3d", handicap: 4 };
    const game = new GoGame(13, 0.5, 4);
    playMoves(game, ["G7", "C11"]);
    const parsed = parseSgf(writeSgf(hcSettings, game.moves, { winner: "W", margin: 0, reason: "resign" }));
    expect(parsed.handicap).toBe(4);
    expect(parsed.setup.map((s) => s.point)).toEqual(game.initialStones.map((s) => s.point));
    expect(parsed.moves[0]).toEqual({ color: "W", point: { x: 6, y: 6 } });
    expect(parsed.result).toEqual({ winner: "W", margin: 0, reason: "resign" });
    expect(settingsFromSgf(parsed)).toEqual(hcSettings);
  });

  it("follows the main line and ignores variations", () => {
    const parsed = parseSgf("(;SZ[9]KM[6.5];B[ee](;W[cc]C[main];B[gg])(;W[gc];B[cg]))");
    expect(parsed.moves).toEqual([
      { color: "B", point: { x: 4, y: 4 } },
      { color: "W", point: { x: 2, y: 2 } },
      { color: "B", point: { x: 6, y: 6 } },
    ]);
    expect(parsed.comments.get(2)).toBe("main");
    expect(parsed.komi).toBe(6.5);
  });

  it("reads tt passes, compressed AB/AW, whitespace and soft line breaks", () => {
    const parsed = parseSgf(`(;FF[4] SZ [9]
      AB[aa:bb] AW[cc]
      C[line one\\
continued]
      ;B[tt];W[ee])`);
    expect(parsed.setup).toEqual([
      { color: "B", point: { x: 0, y: 0 } },
      { color: "B", point: { x: 1, y: 0 } },
      { color: "B", point: { x: 0, y: 1 } },
      { color: "B", point: { x: 1, y: 1 } },
      { color: "W", point: { x: 2, y: 2 } },
    ]);
    expect(parsed.moves[0]).toEqual({ color: "B", pass: true });
    expect(parsed.comments.get(0)).toBe("line onecontinued");
  });

  it("defaults size to 19 and komi to 0", () => {
    const parsed = parseSgf("(;GM[1];B[pd])");
    expect(parsed.size).toBe(19);
    expect(parsed.komi).toBe(0);
    expect(parsed.result).toBeNull();
    expect(settingsFromSgf(parsed)).toBeNull();
  });

  it("throws on malformed input", () => {
    expect(() => parseSgf("not an sgf")).toThrow(/no game tree/);
    expect(() => parseSgf("(;SZ[9];B[ee]")).toThrow(/Unterminated/);
    expect(() => parseSgf("(;SZ[9];B[ee)")).toThrow(/Unterminated/);
    expect(() => parseSgf("(;SZ[9];B[zz])")).toThrow(/off a 9×9 board/);
  });
});

describe("results", () => {
  it("formats and parses results", () => {
    expect(formatResult({ winner: "B", margin: 3.5, reason: "score" })).toBe("B+3.5");
    expect(formatResult({ winner: "W", margin: -12, reason: "score" })).toBe("W+12");
    expect(formatResult({ winner: "W", margin: 0, reason: "resign" })).toBe("W+R");
    expect(formatResult({ winner: null, margin: 0, reason: "score" })).toBe("0");
    expect(formatResult({ winner: null, margin: 0, reason: "abandon" })).toBe("Void");

    expect(parseResult("W+12")).toEqual({ winner: "W", margin: -12, reason: "score" });
    expect(parseResult("B+R")).toEqual({ winner: "B", margin: 0, reason: "resign" });
    expect(parseResult("W+Resign")).toEqual({ winner: "W", margin: 0, reason: "resign" });
    expect(parseResult("B+T")).toEqual({ winner: "B", margin: 0, reason: "resign" });
    expect(parseResult("Draw")).toEqual({ winner: null, margin: 0, reason: "score" });
    expect(parseResult("Void")).toEqual({ winner: null, margin: 0, reason: "abandon" });
  });
});
