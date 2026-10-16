import { describe, expect, it } from "vitest";
import type { ProblemView } from "../../src/shared/types.ts";
import { attemptsLeftText, categoryName, problemHeading, problemResult } from "../../web/src/geometry.ts";

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
    expect(categoryName("capturing_race")).toBe("Capturing race");
    expect(problemHeading(base)).toBe("Life and death · from your game, move 14");
    const { source: _source, ...builtin } = base;
    expect(problemHeading({ ...builtin, kind: "builtin", category: "tactics" })).toBe("Tactics · classic problem");
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
});
