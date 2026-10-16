import { describe, expect, it } from "vitest";
import { categoryLabel, colorName, formatScore, round1 } from "../../src/shared/text.ts";

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
});
