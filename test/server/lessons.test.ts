import { describe, expect, it } from "vitest";
import { BOX_INTERVALS } from "../../src/shared/schedule.ts";
import type { MistakeCategory } from "../../src/shared/types.ts";
import {
  LATER_SESSION_MS,
  SESSION_GAP_MS,
  pickNextProblem,
  pickVariant,
  recordLessonResult,
  sessionStart,
  setEntry,
  type SetEntry,
} from "../../src/server/lessons.ts";
import { promptFor, type StoredProblem } from "../../src/server/problems.ts";
import { liveProblem } from "./fakes.ts";
import { areaUnchanged, findRuns, gameRuns, linkGameLessons, runLead } from "../../src/server/lessons.ts";
import { fromGtp } from "../../src/shared/coords.ts";
import type { GameSummary, MoveRecord } from "../../src/shared/types.ts";
import { boardFrom } from "../engine/helpers.ts";

const NOW = Date.UTC(2026, 9, 19, 20);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A due problem from the learner's game `gameId` at `moveNumber` (generated with kind "generated"). */
function prob(id: string, over: Partial<StoredProblem> & { gameId?: string; moveNumber?: number } = {}): StoredProblem {
  const { gameId = `g-${id}`, moveNumber = 10, ...rest } = over;
  const category: MistakeCategory = rest.category ?? "tactics";
  const base = liveProblem({ id, kind: "game", category, prompt: promptFor(category, "B"), due: NOW - 1000, createdAt: NOW - 5000 });
  const source = rest.kind === "generated" ? base.source : { gameId, moveNumber, played: "A1" };
  return { ...base, source, ...rest };
}

/** Variants of one lesson from game `gameId`, at the given moves; the first names it. */
function lesson(ids: string[], moves: number[], over: Partial<StoredProblem> & { gameId?: string } = {}): StoredProblem[] {
  return ids.map((id, i) => prob(id, { gameId: "g1", moveNumber: moves[i], lesson: { id: ids[0]!, answer: "E1" }, ...over }));
}

/** Pick problems one after another as a practice set: each picked one is no longer due. */
function runSet(problems: StoredProblem[], n: number, focus?: MistakeCategory): string[] {
  const set: SetEntry[] = [];
  for (let i = 0; i < n; i++) {
    const next = pickNextProblem(problems, { now: NOW, focus, set });
    if (!next) break;
    set.push(setEntry(next.problem));
    next.problem.due = NOW + 1000 + i;
  }
  return set.map((e) => e.id);
}

describe("pickNextProblem", () => {
  it("picks a due problem: the focus category first (own before generated), then own problems, then generated", () => {
    const own = prob("p1", { category: "shape" });
    const ownFocus = prob("p2", { category: "tactics", box: 2 });
    const generatedFocus = prob("gen1", { kind: "generated", category: "tactics" });
    const generated = prob("gen2", { kind: "generated", category: "shape" });
    const notDue = prob("p9", { category: "tactics", due: NOW + 1000 });
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
  });

  it("orders due problems by due time within a group: a just-missed one doesn't jump the queue", () => {
    const old = prob("p5", { box: 3, due: NOW - 60 * MINUTE });
    const justMissed = prob("p6", { box: 1, due: NOW - MINUTE });
    expect(pickNextProblem([justMissed, old], { now: NOW })!.problem.id).toBe("p5");
  });

  it("reviews early when nothing is due, and has nothing without problems", () => {
    const later = [prob("p1", { due: NOW + 5000 }), prob("p2", { due: NOW + 1000 })];
    expect(pickNextProblem(later, { now: NOW })).toMatchObject({ early: true, problem: { id: "p2" } });
    // Not the lesson just shown while another is there.
    expect(pickNextProblem(later, { now: NOW, set: [setEntry(later[1]!)] })).toMatchObject({ early: true, problem: { id: "p1" } });
    expect(pickNextProblem([prob("p1")], { now: NOW, set: [setEntry(prob("p1"))] })!.problem.id).toBe("p1");
    expect(pickNextProblem([], { now: NOW })).toBeNull();
  });

  it("picks lessons, not problems: a lesson's variants come up once, the variant seen least recently", () => {
    const run = lesson(["p1", "p2", "p3"], [57, 59, 69]);
    const other = prob("p9", { gameId: "g2", due: NOW - 500 });
    const problems = [...run, other];
    // The lesson's first variant in move order, never shown, comes first.
    const first = pickNextProblem(problems, { now: NOW, set: [] })!;
    expect(first.problem.id).toBe("p1");
    // Then not the same lesson: the other problem, though p2 and p3 are due.
    expect(pickNextProblem(problems, { now: NOW, set: [setEntry(first.problem)] })!.problem.id).toBe("p9");
    // After it, the lesson again in another variant: p1 was shown, p2 never.
    run[0]!.lastSeen = NOW - MINUTE;
    const set = [setEntry(run[0]!), setEntry(other)];
    expect(pickNextProblem(problems, { now: NOW, set })!.problem.id).toBe("p2");
  });

  it("rotates a lesson's variants: never shown first in move order, then the one shown longest ago, not the one just shown", () => {
    const [a, b, c] = lesson(["p1", "p2", "p3"], [57, 59, 69]);
    expect(pickVariant([c!, b!, a!])!.id).toBe("p1");
    a!.lastSeen = NOW - 3 * MINUTE;
    b!.lastSeen = NOW - 2 * MINUTE;
    c!.lastSeen = NOW - 1 * MINUTE;
    expect(pickVariant([a!, b!, c!])!.id).toBe("p1");
    expect(pickVariant([a!, b!, c!], "p1")!.id).toBe("p2");
    expect(pickVariant([a!], "p1")!.id).toBe("p1");
    expect(pickVariant([])).toBeUndefined();
  });

  it("doesn't show two problems from the same game back to back while something else is due", () => {
    const problems = [prob("p1", { gameId: "g1", due: NOW - 3000 }), prob("p2", { gameId: "g1", due: NOW - 2000 }), prob("p3", { gameId: "g2", due: NOW - 1000 })];
    expect(runSet(problems, 3)).toEqual(["p1", "p3", "p2"]);
    // Only the same game left: it comes anyway.
    const same = [prob("p1", { gameId: "g1" }), prob("p2", { gameId: "g1" })];
    expect(runSet(same, 2)).toEqual(["p1", "p2"]);
  });

  it("keeps the focus category to about half of a set while other problems are due", () => {
    const focus = ["t1", "t2", "t3", "t4"].map((id, i) => prob(id, { category: "tactics", due: NOW - 10_000 + i }));
    const others = ["s1", "s2"].map((id, i) => prob(id, { category: "shape", due: NOW - 5000 + i }));
    expect(runSet([...focus, ...others], 6, "tactics")).toEqual(["t1", "s1", "t2", "s2", "t3", "t4"]);
  });
});

describe("recordLessonResult", () => {
  it("counts a result for the whole lesson: every variant takes the schedule and category; only the one shown counts as seen", () => {
    const run = lesson(["p1", "p2", "p3"], [57, 59, 69], { box: 3, due: NOW - 1000 });
    run[2]!.category = "shape";
    const stored = recordLessonResult(run, "p2", "failed", NOW)!;
    expect(stored.id).toBe("p2");
    for (const p of run) {
      expect(p).toMatchObject({ box: 1, due: NOW + BOX_INTERVALS[1]!, lastResult: "failed", missedAt: [NOW], category: "tactics" });
    }
    expect(run[2]!.prompt).toBe(promptFor("tactics", "B"));
    expect(run.map((p) => [p.seen, p.lastSeen])).toEqual([
      [0, undefined],
      [1, NOW],
      [0, undefined],
    ]);
    recordLessonResult(run, "p3", "first_try", NOW + DAY);
    expect(run.map((p) => p.box)).toEqual([2, 2, 2]);
    expect(recordLessonResult(run, "nope", "failed", NOW)).toBeUndefined();
  });

  it("pushes a lesson missed twice in one session to a later day", () => {
    const run = lesson(["p1", "p2"], [57, 59]);
    recordLessonResult(run, "p1", "failed", NOW);
    const later = NOW + 15 * MINUTE;
    recordLessonResult(run, "p2", "failed", later);
    expect(run.map((p) => p.due)).toEqual([later + LATER_SESSION_MS, later + LATER_SESSION_MS]);
    expect(run[0]!.missedAt).toEqual([NOW, later]);
  });

  it("doesn't count a miss from an earlier session", () => {
    const p = prob("p1", { missedAt: [NOW - SESSION_GAP_MS - 60 * MINUTE], lastSeen: NOW - SESSION_GAP_MS - 60 * MINUTE });
    recordLessonResult([p], "p1", "failed", NOW);
    expect(p.due).toBe(NOW + BOX_INTERVALS[1]!);
    expect(p.missedAt).toHaveLength(2);
  });

  it("keeps the last few misses", () => {
    const p = prob("p1");
    for (let i = 0; i < 5; i++) recordLessonResult([p], "p1", "failed", NOW + i * DAY);
    expect(p.missedAt).toEqual([NOW + 2 * DAY, NOW + 3 * DAY, NOW + 4 * DAY]);
  });
});

describe("sessionStart", () => {
  it("goes back through the times problems were shown or missed while no gap is longer than SESSION_GAP_MS", () => {
    expect(sessionStart([], NOW)).toBe(NOW);
    const problems = [
      { lastSeen: NOW - 30 * MINUTE },
      { missedAt: [NOW - 30 * MINUTE - SESSION_GAP_MS + MINUTE] },
      { lastSeen: NOW - 5 * 60 * MINUTE - SESSION_GAP_MS },
      { lastSeen: NOW + MINUTE }, // later than now: ignored
    ];
    expect(sessionStart(problems, NOW)).toBe(NOW - 30 * MINUTE - SESSION_GAP_MS + MINUTE);
    expect(sessionStart([{ lastSeen: NOW - SESSION_GAP_MS - 1 }], NOW)).toBe(NOW);
  });
});

describe("runs of mistakes that missed one point", () => {
  const EMPTY = Array(9).fill(". . . . . . . . .");
  const withStone = (rows: string[], x: number, y: number) => rows.map((r, i) => (i === y ? r.split(" ").map((c, j) => (j === x ? "X" : c)).join(" ") : r));

  it("areaUnchanged looks at the point and the eight around it", () => {
    const empty = boardFrom(EMPTY);
    // E5 is (4, 4).
    expect(areaUnchanged(empty, boardFrom(withStone(EMPTY, 6, 6)), "E5")).toBe(true);
    expect(areaUnchanged(empty, boardFrom(withStone(EMPTY, 3, 5)), "E5")).toBe(false); // D4, diagonal
    expect(areaUnchanged(empty, boardFrom(withStone(EMPTY, 4, 4)), "E5")).toBe(false);
    // On the edge, only the points on the board count.
    expect(areaUnchanged(empty, boardFrom(withStone(EMPTY, 2, 7)), "A1")).toBe(true); // C2
    expect(areaUnchanged(empty, boardFrom(withStone(EMPTY, 1, 7)), "A1")).toBe(false); // B2
    expect(areaUnchanged(empty, boardFrom(withStone(EMPTY, 1, 8)), "A1")).toBe(false);
    expect(areaUnchanged(empty, empty, "Z9")).toBe(false);
  });

  it("findRuns joins mistakes that share an answer while its area stays the same, keeping the answers all share", () => {
    const empty = boardFrom(EMPTY);
    const near = boardFrom(withStone(EMPTY, 3, 5)); // D4: next to E5, not to A2
    expect(
      findRuns([
        { board: empty, answers: ["E5", "A2"] },
        { board: empty, answers: ["C7"] },
        { board: empty, answers: ["A2", "E5"] },
        { board: near, answers: ["E5", "A2"] }, // E5's area changed; A2's didn't
        { board: near, answers: ["E5"] }, // A2 is gone from the run's answers
      ]),
    ).toEqual([{ answer: "A2", members: [0, 2, 3] }]);
    expect(findRuns([{ board: empty, answers: ["E5"] }])).toEqual([]);
  });

  it("runLead is a tutor-tagged member (the last), else the worst", () => {
    const m = (moveNumber: number, pointLoss: number, categorySource: "tutor" | "heuristic" = "heuristic") => ({ moveNumber, move: "A1", pointLoss, bestMove: "E5", category: "other" as const, categorySource });
    expect(runLead([m(3, 5), m(5, 7), m(7, 6)])).toEqual({ moveNumber: 5 });
    expect(runLead([m(3, 5, "tutor"), m(5, 7), m(7, 6, "tutor")])).toEqual({ moveNumber: 7 });
  });

  it("findRuns ends a run when a move between two mistakes touched the answer's area, even if the board looks the same again", () => {
    const empty = boardFrom(EMPTY);
    const items = [0, 1, 2].map(() => ({ board: empty, answers: ["E5"] }));
    expect(findRuns(items)).toEqual([{ answer: "E5", members: [0, 1, 2] }]);
    // A stone played (and later captured) next to E5 between the first and the second mistake.
    expect(findRuns(items, (from, to) => from < 1 && to >= 1)).toEqual([{ answer: "E5", members: [1, 2] }]);
  });

  it("gameRuns judges each mistake in the position before it, a taken-back first try in its own", () => {
    const settings = { size: 9 as const, komi: 7, handicap: 0 };
    const evalTo = (best: string, loss: number) => ({
      leadBefore: 2,
      leadAfter: 2 - loss,
      pointLoss: loss,
      winrateBefore: 0.5,
      winrateAfter: 0.3,
      bestMove: best,
      bestPv: [best],
      candidates: [{ move: best, lead: 2, winrate: 0.5, visits: 300, pv: [best] }],
    });
    const rec = (number: number, gtp: string, loss?: number): MoveRecord => ({
      number,
      move: { color: number % 2 ? "B" : "W", point: fromGtp(gtp, 9)! },
      captures: [],
      ...(loss !== undefined && { eval: evalTo("E5", loss) }),
    });
    // E5 stays open through C3 (1), a first try at A1 taken back, B2 (3); then White's D4 comes next to it.
    const moves = [rec(1, "C3", 5), rec(2, "G7"), rec(3, "B2", 6), rec(4, "D4"), rec(5, "J1", 7)];
    const takenBack = [{ moveNumber: 3, record: rec(3, "A1", 8), by: "human" as const, ts: 0, before: ["C3", "G7"] }];
    const entry = (moveNumber: number, move: string, pointLoss: number, takenBack?: number): GameSummary["mistakes"][number] => ({
      moveNumber,
      move,
      pointLoss,
      bestMove: "E5",
      category: "direction",
      categorySource: "heuristic",
      ...(takenBack !== undefined && { takenBack }),
    });
    const mistakes = [entry(3, "A1", 8, 0), entry(5, "J1", 7), entry(3, "B2", 6), entry(1, "C3", 5)];
    expect(gameRuns({ settings, moves, takenBack }, mistakes)).toEqual([
      { answer: "E5", mistakes: [{ moveNumber: 1 }, { moveNumber: 3, takenBack: 0 }, { moveNumber: 3 }], lead: { moveNumber: 3, takenBack: 0 } },
    ]);
    // A mistake that can't be replayed is left out.
    expect(gameRuns({ settings, moves, takenBack: [] }, mistakes)).toEqual([{ answer: "E5", mistakes: [{ moveNumber: 1 }, { moveNumber: 3 }], lead: { moveNumber: 3 } }]);
  });

  it("linkGameLessons makes a run's problems one lesson, leaving problems already in a lesson and runs of one problem alone", () => {
    const a = prob("p1", { gameId: "g1", moveNumber: 1, box: 2, due: NOW + DAY, answers: ["E5"] });
    const b = prob("p2", { gameId: "g1", moveNumber: 3, box: 1, due: NOW - 1000, answers: ["E5", "D4"] });
    // A deeper analysis for the problem at move 5 found another answer: it isn't a variant.
    const d = prob("p5", { gameId: "g1", moveNumber: 5, answers: ["G3"] });
    const c = prob("p3", { gameId: "g1", moveNumber: 9 });
    const other = prob("p4", { gameId: "g2", moveNumber: 1 });
    const runs = [
      { answer: "E5", mistakes: [{ moveNumber: 1 }, { moveNumber: 3 }, { moveNumber: 5 }], lead: { moveNumber: 3 } },
      { answer: "A2", mistakes: [{ moveNumber: 9 }, { moveNumber: 11 }], lead: { moveNumber: 9 } }, // move 11 made no problem
    ];
    const made = linkGameLessons([a, b, d, c, other], "g1", runs);
    expect(made.map((l) => l.map((p) => p.id))).toEqual([["p1", "p2"]]);
    expect([a.lesson, b.lesson]).toEqual([{ id: "p1", answer: "E5" }, { id: "p1", answer: "E5" }]);
    // The variants share the most urgent schedule.
    expect([a.box, a.due, b.box, b.due]).toEqual([1, NOW - 1000, 1, NOW - 1000]);
    expect(c.lesson).toBeUndefined();
    expect(d.lesson).toBeUndefined();
    expect(linkGameLessons([a, b], "g1", runs)).toEqual([]);
  });
});
