import { describe, expect, it } from "vitest";
import { GoGame, boardFromDiagram, gameFromLine } from "../../src/engine/index.ts";
import { fromGtp } from "../../src/shared/coords.ts";
import {
  BOX_INTERVALS,
  acceptedAnswers,
  addProblems,
  candidatesThin,
  gameSource,
  generatedInfo,
  generatedSource,
  hasKoBan,
  isLegacyBuiltin,
  listItem,
  nextProblemId,
  pickNextProblem,
  positionHash,
  problemBoard,
  problemFromMistake,
  problemGame,
  problemPosition,
  problemsResponse,
  promptFor,
  recentFromGame,
  recentMovesOf,
  recentMovesView,
  resultOf,
  schedule,
  stonesOf,
  type MistakeSnapshot,
  type StoredProblem,
} from "../../src/server/problems.ts";
import { liveProblem } from "./fakes.ts";

const NOW = Date.UTC(2026, 9, 16, 12);

const DIAGRAM = [
  ". . . . . . . . .",
  ". . . . . . . . .",
  ". . . . . . . . .",
  ". . . . . . . . .",
  ". . . . . . . . .",
  ". . . . . . . . .",
  ". . O . . . . . .",
  ". X X O . . . . .",
  ". . X O . . . . .",
];

function gameProblem(over: Partial<StoredProblem> = {}): StoredProblem {
  const board = boardFromDiagram(DIAGRAM);
  return {
    id: "p1",
    kind: "game",
    size: 9,
    komi: 7,
    stones: stonesOf(board),
    toPlay: "B",
    prompt: promptFor("tactics", "B"),
    category: "tactics",
    answers: ["D7"],
    hash: positionHash(board, "B"),
    createdAt: NOW - 1000,
    box: 1,
    due: NOW - 1000,
    seen: 0,
    solves: 0,
    ...over,
  };
}

describe("problem sources", () => {
  it("tells a problem from the learner's game from a generated one, and recognizes the old built-ins", () => {
    const own = gameProblem({ source: { gameId: "g1", moveNumber: 5, played: "A1" } });
    const generated = liveProblem();
    expect(gameSource(own)).toEqual({ gameId: "g1", moveNumber: 5, played: "A1" });
    expect(generatedSource(own)).toBeUndefined();
    expect(gameSource(generated)).toBeUndefined();
    expect(generatedSource(generated)).toMatchObject({ batchId: "batch1", difficultyRating: 13.2, swapped: false });
    expect(generatedInfo(generated)).toEqual({ batchId: "batch1", difficultyRank: "17k", weakerRank: "20k", strongerRank: "15k" });
    expect(generatedInfo(own)).toBeUndefined();
    expect(isLegacyBuiltin({ id: "b-live-straight-three", kind: "builtin" })).toBe(true);
    expect(isLegacyBuiltin(own)).toBe(false);
    expect(isLegacyBuiltin(generated)).toBe(false);
  });

  it("keeps generated problems apart from game ones when adding: only the position decides", () => {
    const problems = [gameProblem({ id: "p1", source: { gameId: "g1", moveNumber: 30, played: "A1" } })];
    // Same move number as p1's source, but generated: not a duplicate.
    const added = addProblems(problems, [liveProblem({ id: "gen1" }), liveProblem({ id: "gen2" })]);
    expect(added.map((p) => p.id)).toEqual(["gen1"]); // gen2 is the same position
    expect(problems.map((p) => p.id)).toEqual(["p1", "gen1"]);
  });

  it("lists a problem's board size, and a generated problem's origin", () => {
    const item = listItem(liveProblem({ size: 9 }), NOW);
    expect(item).toMatchObject({ id: "gen1", kind: "generated", size: 9, generated: { batchId: "batch1", difficultyRank: "17k" } });
    expect(item.source).toBeUndefined();
  });
});

describe("positions", () => {
  it("round-trips a diagram through stones, and builds the KataGo position with the learner first", () => {
    const board = boardFromDiagram(DIAGRAM);
    const stones = stonesOf(board);
    expect(stones).toEqual({ B: ["B2", "C2", "C1"], W: ["C3", "D2", "D1"] });
    expect(problemBoard({ size: 9, stones })).toEqual(board);
    const pos = problemPosition({ size: 9, komi: 7, stones, toPlay: "W" }, ["E2", "E1"]);
    expect(pos.initialPlayer).toBe("W");
    expect(pos.initialStones).toContainEqual(["B", "B2"]);
    expect(pos.moves).toEqual([
      ["W", "E2"],
      ["B", "E1"],
    ]);
    expect(problemGame({ size: 9, komi: 7, stones, toPlay: "W" }).toPlay).toBe("W");
    expect(() => boardFromDiagram([". X", "O ."].concat([]))).not.toThrow();
    expect(() => boardFromDiagram([". X Q", ". . .", ". . ."])).toThrow(/unknown cell/);
  });

  it("hashes the position and the side to move", () => {
    const board = boardFromDiagram(DIAGRAM);
    expect(positionHash(board, "B")).toBe(positionHash(boardFromDiagram(DIAGRAM), "B"));
    expect(positionHash(board, "B")).not.toBe(positionHash(board, "W"));
  });
});

describe("problems from mistakes", () => {
  const snapshot = (over: Partial<MistakeSnapshot> = {}): MistakeSnapshot => ({
    gameId: "g1",
    moveNumber: 14,
    played: "C3",
    pointLoss: 6.24,
    category: "life_and_death",
    size: 9,
    komi: 7,
    board: boardFromDiagram(DIAGRAM),
    toPlay: "B",
    candidates: [
      { move: "D5", lead: 3, visits: 300, pv: ["D5", "E4"] },
      { move: "E5", lead: 2.2, visits: 80, pv: ["E5"] },
      { move: "C3", lead: 2.5, visits: 20, pv: ["C3"] },
      { move: "F5", lead: 1.5, visits: 10, pv: ["F5"] },
    ],
    ...over,
  });

  it("accepts KataGo's moves within a point of its best, never a pass or the mistake itself", () => {
    expect(acceptedAnswers(snapshot().candidates, "C3")).toEqual(["D5", "E5"]);
    expect(acceptedAnswers([{ move: "pass", lead: 1, visits: 9, pv: [] }, { move: "A1", lead: 0.5, visits: 60, pv: [] }])).toEqual(["A1"]);
    expect(acceptedAnswers([])).toEqual([]);
  });

  it("doesn't accept a barely searched move, however good its lead looks", () => {
    const candidates = [
      { move: "D5", lead: 3, visits: 8, pv: ["D5"] }, // KataGo's best always counts
      { move: "E5", lead: 3.4, visits: 49, pv: ["E5"] },
      { move: "F5", lead: 2.5, visits: 50, pv: ["F5"] },
    ];
    expect(acceptedAnswers(candidates)).toEqual(["D5", "F5"]);
    expect(problemFromMistake(snapshot({ candidates }), "p9", NOW)?.answers).toEqual(["D5", "F5"]);
  });

  it("knows when candidates are too thin to trust", () => {
    expect(candidatesThin(snapshot().candidates)).toBe(false);
    expect(candidatesThin([{ visits: 400 }])).toBe(true);
    expect(candidatesThin([{ visits: 50 }, { visits: 40 }])).toBe(true);
  });

  it("builds a problem: the position before the mistake, the learner to play, a prompt by category, answers, source and difficulty", () => {
    const p = problemFromMistake(snapshot(), "p3", NOW)!;
    expect(p).toMatchObject({
      id: "p3",
      kind: "game",
      toPlay: "B",
      category: "life_and_death",
      answers: ["D5", "E5"],
      bestMove: "D5",
      difficulty: 6.2,
      source: { gameId: "g1", moveNumber: 14, played: "C3" },
      box: 1,
      due: NOW,
    });
    expect(p.prompt).toBe("Black to play. One of the groups here is fighting for its life. Find the move that settles it in your favor.");
    expect(p.stones).toEqual(stonesOf(boardFromDiagram(DIAGRAM)));
    expect(p.recent).toEqual([]); // the first move: none, but known
    expect(problemFromMistake(snapshot({ recent: [{ color: "W", move: "C4" }] }), "p3", NOW)!.recent).toEqual([{ color: "W", move: "C4" }]);
    expect(promptFor("endgame", "W")).toBe("White to play. It's the endgame. Find the biggest move left.");
    // Nothing to find when KataGo would pass.
    expect(problemFromMistake(snapshot({ candidates: [{ move: "pass", lead: 0, visits: 400, pv: [] }] }), "p4", NOW)).toBeNull();
  });

  it("numbers problems and skips positions (or source moves) that are already problems", () => {
    expect(nextProblemId([{ id: "b-net" }, { id: "p2" }, { id: "p10" }])).toBe("p11");
    expect(nextProblemId([])).toBe("p1");
    const problems = [gameProblem({ source: { gameId: "g9", moveNumber: 3, played: "A1" } })];
    const same = gameProblem({ id: "p2" });
    const sameSource = gameProblem({ id: "p3", hash: "other", source: { gameId: "g9", moveNumber: 3, played: "A1" } });
    const fresh = gameProblem({ id: "p4", hash: "fresh" });
    const added = addProblems(problems, [same, sameSource, fresh]);
    expect(added.map((p) => p.id)).toEqual(["p4"]);
    expect(problems.map((p) => p.id)).toEqual(["p1", "p4"]);
  });
});

describe("spaced repetition", () => {
  it("moves a first-try solve up a box, keeps a later solve's box, and sends a failure to box 1", () => {
    expect([resultOf(true, 1), resultOf(true, 2), resultOf(false, 2)]).toEqual(["first_try", "solved", "failed"]);
    const p = gameProblem({ box: 2 });
    schedule(p, "first_try", NOW);
    expect(p).toMatchObject({ box: 3, due: NOW + BOX_INTERVALS[3]!, seen: 1, solves: 1, lastResult: "first_try", lastSeen: NOW });
    schedule(p, "solved", NOW);
    expect(p).toMatchObject({ box: 3, seen: 2, solves: 2 });
    schedule(p, "failed", NOW);
    expect(p).toMatchObject({ box: 1, due: NOW + BOX_INTERVALS[1]!, seen: 3, solves: 2, lastResult: "failed" });
    const top = gameProblem({ box: 5 });
    schedule(top, "first_try", NOW);
    expect(top.box).toBe(5);
    expect(BOX_INTERVALS[1]).toBeLessThan(BOX_INTERVALS[2]!);
  });

  it("picks a due problem: the focus category first (own before generated), then own problems, then generated", () => {
    const own = gameProblem({ id: "p1", category: "shape" });
    const ownFocus = gameProblem({ id: "p2", category: "tactics", box: 2 });
    const generatedFocus = gameProblem({ id: "gen1", kind: "generated", category: "tactics" });
    const generated = gameProblem({ id: "gen2", kind: "generated", category: "shape" });
    const notDue = gameProblem({ id: "p9", category: "tactics", due: NOW + 1000 });
    const all = [generated, generatedFocus, own, ownFocus, notDue];
    const order: string[] = [];
    let pool = all;
    for (;;) {
      const next = pickNextProblem(pool, { now: NOW, focus: "tactics" });
      if (!next || next.early) break;
      order.push(next.problem.id);
      pool = pool.filter((p) => p !== next.problem);
    }
    expect(order).toEqual(["p2", "gen1", "p1", "gen2"]);
    expect(pickNextProblem(all, { now: NOW, focus: "endgame" })!.problem.id).toBe("p1");
    // Lower boxes first within a group.
    expect(pickNextProblem([gameProblem({ id: "p5", box: 3 }), gameProblem({ id: "p6", box: 1 })], { now: NOW })!.problem.id).toBe("p6");
  });

  it("skips the problem just shown, and reviews early when nothing is due", () => {
    const a = gameProblem({ id: "p1" });
    const b = gameProblem({ id: "p2", box: 2 });
    expect(pickNextProblem([a, b], { now: NOW, exclude: "p1" })!.problem.id).toBe("p2");
    expect(pickNextProblem([a], { now: NOW, exclude: "p1" })!.problem.id).toBe("p1");
    const later = [gameProblem({ id: "p1", due: NOW + 5000 }), gameProblem({ id: "p2", due: NOW + 1000 })];
    expect(pickNextProblem(later, { now: NOW })).toMatchObject({ early: true, problem: { id: "p2" } });
    expect(pickNextProblem([], { now: NOW })).toBeNull();
  });
});

describe("GET /api/problems body", () => {
  it("lists due problems first with counts by box and due category", () => {
    const problems = [
      gameProblem({ id: "p1", due: NOW + 1000 }),
      gameProblem({ id: "p2", category: "shape", box: 2, source: { gameId: "g1", moveNumber: 5, played: "A1" }, difficulty: 5 }),
      gameProblem({ id: "gen1", kind: "generated", category: "tactics" }),
    ];
    const r = problemsResponse(problems, NOW, { category: "tactics", reason: "", suggestion: "problems" });
    expect(r.problems.map((p) => [p.id, p.isDue])).toEqual([
      ["gen1", true],
      ["p2", true],
      ["p1", false],
    ]);
    expect(r.counts).toEqual({ total: 3, due: 2, fromGames: 2, generated: 1, byBox: [2, 1, 0, 0, 0], dueByCategory: { tactics: 1, shape: 1 } });
    expect(r.generation).toBeUndefined();
    expect(r.problems[1]).toMatchObject({ source: { gameId: "g1", moveNumber: 5 }, difficulty: 5, answers: ["D7"] });
    expect(r.problems[1]!.source).not.toHaveProperty("played");
  });
});

describe("recent moves", () => {
  const setup = { size: 9, komi: 7, handicap: 0 };
  // White's B1 captures Black's A1, and White fills A1 afterwards.
  const line = ["C3", "E5", "A1", "A2", "pass", "B1", "pass", "A1"];
  const at = (gtp: string) => fromGtp(gtp, 9)!;

  it("keeps the last five stones played (passes left out), oldest first, colors swapped on request", () => {
    const game = gameFromLine(setup, line);
    expect(recentMovesOf(game)).toEqual([
      { color: "W", move: "E5" },
      { color: "B", move: "A1" },
      { color: "W", move: "A2" },
      { color: "W", move: "B1" },
      { color: "W", move: "A1" },
    ]);
    expect(recentMovesOf(game, true)[0]).toEqual({ color: "B", move: "E5" });
    expect(recentMovesOf(new GoGame(9, 7))).toEqual([]);
  });

  it("labels only stones still on the board, the later move where a point was played twice", () => {
    const game = gameFromLine(setup, line);
    const view = recentMovesView({ size: 9, recent: recentMovesOf(game) }, game.board);
    // Black's A1 (-4) was captured, and White's A1 (-1) is there now.
    expect(view).toEqual([
      { color: "W", point: at("E5"), ago: 5 },
      { color: "W", point: at("A2"), ago: 3 },
      { color: "W", point: at("B1"), ago: 2 },
      { color: "W", point: at("A1"), ago: 1 },
    ]);
    const twice = [
      { color: "W" as const, move: "A1" },
      { color: "W" as const, move: "A1" },
    ];
    expect(recentMovesView({ size: 9, recent: twice }, game.board)).toEqual([{ color: "W", point: at("A1"), ago: 1 }]);
    expect(recentMovesView({ size: 9 }, game.board)).toBeUndefined();
    expect(recentMovesView({ size: 9, recent: [{ color: "B", move: "J9" }] }, game.board)).toBeUndefined();
  });

  it("finds an older game problem's recent moves in its game record, if the record still leads to its position", () => {
    const moves = gameFromLine(setup, [...line, "D4"]).moves;
    const before = gameFromLine(setup, line);
    const p = { source: { gameId: "g1", moveNumber: 9, played: "D4" }, hash: positionHash(before.board, "B"), toPlay: "B" as const };
    const settings = { size: 9 as const, komi: 7, humanColor: "B" as const, botRank: "20k", handicap: 0 };
    expect(recentFromGame(p, { settings, moves })).toEqual(recentMovesOf(before));
    expect(recentFromGame({ ...p, hash: "other" }, { settings, moves })).toBeUndefined();
    expect(recentFromGame({ ...p, source: { ...p.source, takenBack: 0 } }, { settings, moves })).toBeUndefined();
    expect(recentFromGame({ ...p, source: undefined }, { settings, moves })).toBeUndefined();
  });
});

describe("hasKoBan", () => {
  const play = (g: GoGame, moves: [number, number][]) => {
    for (const [x, y] of moves) expect(g.playAt({ x, y }).ok).toBe(true);
    return g;
  };

  it("finds the immediate retake of a single stone", () => {
    // On 2×2 White's last move takes one stone, and retaking it would repeat an earlier position.
    const g = play(new GoGame(2, 0), [[0, 0], [1, 0], [0, 1], [1, 1], [0, 0], [0, 1]]);
    expect(g.lastMove?.captures).toHaveLength(1);
    expect(hasKoBan(g)).toBe(true);
    expect(hasKoBan(new GoGame(9, 7))).toBe(false);
  });

  it("finds a superko ban that is not the retake of a single stone", () => {
    // On 3×3 the last move takes two stones; White replaying C3 would recreate the position after move 7.
    const g = play(new GoGame(3, 0), [[2, 2], [2, 0], [1, 1], [1, 2], [0, 1], [0, 0], [1, 0], [2, 1], [2, 2]]);
    expect(g.lastMove?.captures).toHaveLength(2);
    expect(g.illegalReason({ x: 2, y: 0 })).toBe("ko");
    expect(hasKoBan(g)).toBe(true);
  });
});
