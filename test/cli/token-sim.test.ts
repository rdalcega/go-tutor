import { describe, expect, it } from "vitest";
import { simulate } from "../../scripts/token-sim.ts";

describe("token-cost simulation", () => {
  it("costs far less per session than the stream that printed every event, on every level", { timeout: 120_000 }, async () => {
    for (const level of ["silent", "point_out", "coach"] as const) {
      const before = await simulate("before", level);
      const after = await simulate("after", level);
      // The old stream woke the tutor for every move; the calibration session cost about $3.35.
      expect(before.byKind.MOVE).toBeGreaterThan(1);
      expect(before.dollars).toBeGreaterThan(3);
      // Nothing the tutor doesn't act on reaches it.
      for (const kind of ["MOVE", "UNDO", "LEVEL", "JUDGE", "RATING"]) expect(after.byKind[kind], `${level} ${kind}`).toBeUndefined();
      expect(after.dollars, level).toBeLessThan(before.dollars * 0.45);
    }
  });
});
