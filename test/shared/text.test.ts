import { describe, expect, it } from "vitest";
import { TUTOR_LEVEL_TEXT, categoryLabel, colorName, comeBackText, formatScore, round1, tutorLevelChangedText } from "../../src/shared/text.ts";
import { TUTOR_LEVELS } from "../../src/shared/types.ts";

describe("shared wording", () => {
  it("names colors and categories", () => {
    expect(colorName("B")).toBe("Black");
    expect(colorName("W")).toBe("White");
    expect(categoryLabel("life_and_death")).toBe("life and death");
    expect(categoryLabel("capturing_race", { capitalize: true })).toBe("Capturing race");
  });

  it("rounds to one decimal", () => {
    expect(round1(6.25)).toBe(6.3);
    expect(round1(-1.04)).toBe(-1);
  });

  it("describes a result, from the learner's side when given", () => {
    expect(formatScore({ winner: "W", margin: -4.5, reason: "score" })).toBe("White wins by 4.5 points");
    expect(formatScore({ winner: "B", margin: 0, reason: "resign" }, "W")).toBe("Black (bot) wins by resignation");
    expect(formatScore({ winner: "B", margin: 2.5, reason: "score" }, "B")).toBe("Black (you) wins by 2.5 points");
    expect(formatScore({ winner: null, margin: 0, reason: "score" })).toBe("a draw");
    expect(formatScore({ winner: null, margin: 0, reason: "abandon" })).toBe("game abandoned");
  });

  it("says when a problem comes back, for each Leitner interval", () => {
    const MIN = 60_000;
    const DAY = 24 * 60 * MIN;
    expect(comeBackText(10 * MIN, 0)).toBe("in about 10 minutes");
    expect(comeBackText(10 * MIN, 30_000)).toBe("in about 10 minutes"); // rounded, not "9.5"
    expect(comeBackText(30_000, 0)).toBe("in a minute or so");
    expect(comeBackText(5 * 60 * MIN, 0)).toBe("in about 5 hours");
    expect(comeBackText(DAY, 0)).toBe("tomorrow");
    expect(comeBackText(3 * DAY, 0)).toBe("in 3 days");
    expect(comeBackText(7 * DAY, 0)).toBe("in 7 days");
    expect(comeBackText(21 * DAY, 0)).toBe("in 3 weeks");
  });

  it("has a label and both descriptions for every tutor level", () => {
    expect(TUTOR_LEVELS.map((l) => TUTOR_LEVEL_TEXT[l].label)).toEqual(["Silent", "Point out", "Coach"]);
    for (const l of TUTOR_LEVELS) {
      expect(TUTOR_LEVEL_TEXT[l].learner).not.toBe("");
      expect(TUTOR_LEVEL_TEXT[l].tutor).not.toBe("");
    }
  });

  it("announces a new tutor level the same way for the server and the mock", () => {
    expect(tutorLevelChangedText("point_out")).toBe(`Tutor help: Point out. ${TUTOR_LEVEL_TEXT.point_out.learner}`);
    expect(tutorLevelChangedText("silent")).toMatch(/^Tutor help: Silent\. No pauses/);
  });
});
