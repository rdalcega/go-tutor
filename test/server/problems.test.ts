import { describe, expect, it } from "vitest";
import { groupAt } from "../../src/engine/index.ts";
import { tryFromGtp } from "../../src/shared/coords.ts";
import type { MistakeCategory } from "../../src/shared/types.ts";
import { BUILTIN_PROBLEMS } from "../../src/server/builtin-problems.ts";
import {
  BOX_INTERVALS,
  acceptedAnswers,
  addProblems,
  boardFromDiagram,
  builtinProblem,
  candidatesThin,
  nextProblemId,
  pickNextProblem,
  positionHash,
  problemBoard,
  problemFromMistake,
  problemGame,
  problemPosition,
  problemsResponse,
  promptFor,
  resultOf,
  schedule,
  stonesOf,
  withBuiltins,
  type MistakeSnapshot,
  type StoredProblem,
} from "../../src/server/problems.ts";

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

describe("built-in problems", () => {
  it("are a dozen well-formed 9×9 positions covering the classic themes", () => {
    expect(BUILTIN_PROBLEMS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(BUILTIN_PROBLEMS.map((p) => p.id)).size).toBe(BUILTIN_PROBLEMS.length);
    const categories = new Set(BUILTIN_PROBLEMS.map((p) => p.category));
    for (const c of ["life_and_death", "capturing_race", "tactics", "shape"] as MistakeCategory[]) expect(categories).toContain(c);
    for (const def of BUILTIN_PROBLEMS) {
      const p = builtinProblem(def);
      const board = problemBoard(p);
      expect(board).toHaveLength(9);
      // Every group on the board has a liberty (a legal position).
      board.forEach((row, y) =>
        row.forEach((c, x) => {
          if (c) expect(groupAt(board, { x, y }).liberties, `${def.id} stone at ${x},${y}`).toBeGreaterThan(0);
        }),
      );
      // Every answer is a legal move for the side to play.
      const game = problemGame(p);
      for (const answer of def.answers) {
        const point = tryFromGtp(answer, 9);
        expect(point, `${def.id} answer ${answer}`).toBeTruthy();
        expect(game.illegalReason(point!), `${def.id} answer ${answer}`).toBeNull();
      }
      expect(def.prompt).toMatch(/^(Black|White) to play\./);
    }
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

describe("built-ins in the store", () => {
  it("merge stored progress and found answers into the source definitions, and drop removed ones", () => {
    const def = BUILTIN_PROBLEMS[0]!;
    const stored: StoredProblem[] = [
      gameProblem(),
      { ...builtinProblem(def), box: 3, due: NOW + 5, seen: 4, solves: 3, lastResult: "first_try", answers: [...def.answers, "Z9"], prompt: "old" },
      { ...builtinProblem(def), id: "b-gone" },
    ];
    const merged = withBuiltins(stored);
    expect(merged.filter((p) => p.kind === "builtin")).toHaveLength(BUILTIN_PROBLEMS.length);
    expect(merged.find((p) => p.id === "b-gone")).toBeUndefined();
    expect(merged[0]!.id).toBe("p1");
    const b = merged.find((p) => p.id === def.id)!;
    expect(b).toMatchObject({ box: 3, due: NOW + 5, seen: 4, solves: 3, lastResult: "first_try", prompt: def.prompt });
    expect(b.answers).toEqual([...def.answers, "Z9"]);
    const fresh = withBuiltins([]).find((p) => p.id === def.id)!;
    expect(fresh).toMatchObject({ box: 1, due: 0, seen: 0 });
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

  it("picks a due problem: the focus category first (own before built-in), then own problems, then built-ins", () => {
    const own = gameProblem({ id: "p1", category: "shape" });
    const ownFocus = gameProblem({ id: "p2", category: "tactics", box: 2 });
    const builtinFocus = gameProblem({ id: "b-x", kind: "builtin", category: "tactics" });
    const builtin = gameProblem({ id: "b-y", kind: "builtin", category: "shape" });
    const notDue = gameProblem({ id: "p9", category: "tactics", due: NOW + 1000 });
    const all = [builtin, builtinFocus, own, ownFocus, notDue];
    const order: string[] = [];
    let pool = all;
    for (;;) {
      const next = pickNextProblem(pool, { now: NOW, focus: "tactics" });
      if (!next || next.early) break;
      order.push(next.problem.id);
      pool = pool.filter((p) => p !== next.problem);
    }
    expect(order).toEqual(["p2", "b-x", "p1", "b-y"]);
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
      gameProblem({ id: "b-x", kind: "builtin", category: "tactics" }),
    ];
    const r = problemsResponse(problems, NOW, { category: "tactics", reason: "", suggestion: "problems" });
    expect(r.problems.map((p) => [p.id, p.isDue])).toEqual([
      ["b-x", true],
      ["p2", true],
      ["p1", false],
    ]);
    expect(r.counts).toEqual({ total: 3, due: 2, fromGames: 2, builtin: 1, byBox: [2, 1, 0, 0, 0], dueByCategory: { tactics: 1, shape: 1 } });
    expect(r.problems[1]).toMatchObject({ source: { gameId: "g1", moveNumber: 5 }, difficulty: 5, answers: ["D7"] });
    expect(r.problems[1]!.source).not.toHaveProperty("played");
  });
});
