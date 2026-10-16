import { describe, expect, it } from "vitest";
import { BOX_INTERVALS, MAX_BOX, nextBox, resultOf, schedule } from "../../src/shared/schedule.ts";
import { comeBackText } from "../../src/shared/text.ts";

describe("shared spaced repetition", () => {
  it("first try moves up a box, a later try keeps it, failing goes back to box 1", () => {
    expect(nextBox(2, resultOf(true, 1))).toBe(3);
    expect(nextBox(3, resultOf(true, 2))).toBe(3); // solved on a later try: same box, not box 1
    expect(nextBox(4, resultOf(false, 2))).toBe(1);
    expect(nextBox(MAX_BOX, "first_try")).toBe(MAX_BOX);
    expect(nextBox(0, "solved")).toBe(1);
  });

  it("schedules by the new box, so the come-back text follows from the due time", () => {
    const now = 1_000_000;
    const p = { box: 3, due: 0, seen: 0, solves: 0 };
    schedule(p, resultOf(true, 2), now);
    expect(p).toMatchObject({ box: 3, due: now + BOX_INTERVALS[3]!, seen: 1, solves: 1, lastResult: "solved", lastSeen: now });
    expect(comeBackText(p.due, now)).toBe("in 3 days");
  });
});
