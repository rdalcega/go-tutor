import { describe, expect, it } from "vitest";
import type { ProblemView } from "../../src/shared/types.ts";
import { categoryLabel } from "../../src/shared/text.ts";
import { attemptsLeftText, generationFact, problemHeading, problemResult, recentMoveLabels } from "../../web/src/geometry.ts";

const base: ProblemView = {
  id: "p4",
  prompt: "Black to play.",
  attempts: 0,
  solved: false,
  kind: "game",
  category: "life_and_death",
  toPlay: "B",
  maxAttempts: 2,
  revealed: false,
  box: 1,
  source: { gameId: "g1", moveNumber: 14 },
};

describe("problem card helpers", () => {
  it("names the category and where the problem comes from", () => {
    expect(categoryLabel("capturing_race", { capitalize: true })).toBe("Capturing race");
    expect(problemHeading(base)).toBe("Life and death · from your game, move 14");
    const { source: _source, ...rest } = base;
    const generated = { batchId: "batch1", difficultyRank: "17k", weakerRank: "20k", strongerRank: "15k" };
    expect(problemHeading({ ...rest, kind: "generated", generated, category: "tactics" }, 13)).toBe("Tactics · 13×13 · about 17k");
  });

  it("shows problem generation in the progress card: the batch in progress, else the mastery count", () => {
    expect(generationFact(undefined)).toBeNull();
    expect(generationFact({ state: "idle", current: null, last: null, batches: 0 })).toBeNull();
    const batch = {
      id: "batch1",
      number: 1,
      weakerRank: "20k",
      strongerRank: "15k",
      trigger: "first" as const,
      found: 7,
      target: 20,
      sizes: [
        { size: 9 as const, found: 4, target: 7, games: 5, minutes: 9 },
        { size: 13 as const, found: 2, target: 7, games: 2, minutes: 8 },
        { size: 19 as const, found: 1, target: 6, games: 1, minutes: 7 },
      ],
      band: "20k–16k",
      createdAt: 0,
    };
    const generating = generationFact({ state: "waiting", current: batch, last: null, batches: 0 })!;
    expect(generating.short).toBe("Generating 7/20");
    expect(generating.long).toContain("4/7 on 9×9, 2/7 on 13×13, 1/6 on 19×19");
    expect(generating.long).toContain("pauses while you play");
    const done = generationFact({ state: "idle", current: null, last: { ...batch, found: 20, problems: 20, mastered: 9, needed: 15 }, batches: 1 })!;
    expect(done.short).toBe("9/15 mastered");
    expect(done.long).toContain("Master 15 of them");
  });

  it("counts the attempts left until the problem is over", () => {
    expect(attemptsLeftText(base)).toBe("2 attempts left");
    expect(attemptsLeftText({ ...base, attempts: 1 })).toBe("1 attempt left");
    expect(attemptsLeftText({ ...base, attempts: 2, revealed: true })).toBe("");
  });

  it("explains each verdict with KataGo's point loss and the answer once shown", () => {
    expect(problemResult(base)).toBeNull();
    expect(problemResult({ ...base, attempts: 1, lastAttempt: { move: "C7", correct: false, pointLoss: 5.24 } })).toEqual({
      text: "C7 loses about 5.2 points. Look again and try another move.",
      tone: "bad",
    });
    expect(
      problemResult({ ...base, attempts: 2, revealed: true, lastAttempt: { move: "C7", correct: false, pointLoss: 5 }, answer: { move: "D5", pv: ["D5"] } }),
    ).toEqual({ text: "C7 loses about 5.0 points. The answer is D5; the numbered stones show KataGo's line.", tone: "bad" });
    expect(
      problemResult({ ...base, attempts: 1, solved: true, revealed: true, lastAttempt: { move: "D5", correct: true, pointLoss: 0 }, answer: { move: "D5", pv: [] } }),
    ).toEqual({ text: "Correct on the first try: D5. The numbered stones show how play goes on.", tone: "good" });
    expect(
      problemResult({ ...base, attempts: 2, solved: true, revealed: true, lastAttempt: { move: "E5", correct: true, pointLoss: null }, answer: { move: "D5", pv: [] } })!.text,
    ).toBe("Correct: E5. KataGo's favorite is D5, and yours is about as good. The numbered stones show how play goes on.");
  });

  it("says when a finished problem comes back", () => {
    const now = 1_000_000;
    const failed: ProblemView = {
      ...base,
      attempts: 2,
      revealed: true,
      lastAttempt: { move: "C7", correct: false, pointLoss: 5 },
      answer: { move: "D5", pv: ["D5"] },
      nextDue: now + 10 * 60_000,
    };
    expect(problemResult(failed, now)!.text).toBe(
      "C7 loses about 5.0 points. The answer is D5; the numbered stones show KataGo's line. You'll see this one again in about 10 minutes.",
    );
    const solved: ProblemView = { ...base, attempts: 1, solved: true, revealed: true, lastAttempt: { move: "D5", correct: true, pointLoss: 0 }, nextDue: now + 86_400_000 };
    expect(problemResult(solved, now)!.text).toMatch(/You'll see this one again tomorrow\.$/);
    // Not while an attempt is left (nothing is scheduled yet).
    expect(problemResult({ ...failed, revealed: false, attempts: 1 }, now)!.text).not.toMatch(/again in/);
  });
});

describe("recent move labels", () => {
  const recentMoves = [
    { color: "B" as const, point: { x: 2, y: 6 }, ago: 2 },
    { color: "W" as const, point: { x: 3, y: 5 }, ago: 1 },
  ];

  it("labels a problem's last moves −2, −1, except under a drawn stone or mark", () => {
    expect(recentMoveLabels({ problem: { ...base, recentMoves }, overlay: null })).toEqual([
      { point: { x: 2, y: 6 }, text: "\u22122" },
      { point: { x: 3, y: 5 }, text: "\u22121" },
    ]);
    const variation = { moves: [{ color: "B" as const, point: { x: 3, y: 5 } }] };
    expect(recentMoveLabels({ problem: { ...base, recentMoves }, overlay: { variation } }).map((l) => l.text)).toEqual(["\u22122"]);
    expect(recentMoveLabels({ problem: { ...base, recentMoves }, overlay: { marks: [{ point: { x: 2, y: 6 }, kind: "x" }] } }).map((l) => l.text)).toEqual(["\u22121"]);
    expect(recentMoveLabels({ problem: base, overlay: null })).toEqual([]);
    expect(recentMoveLabels({ overlay: null })).toEqual([]);
  });
});
