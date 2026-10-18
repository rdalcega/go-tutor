// Runs against the real KataGo. Skipped when `katago` is not on PATH.
// Prints measured latencies so the server can size its timeouts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KataGo, isAbortError, moveEvalFrom, type Position } from "../../src/server/katago.ts";
import { hasKataGo } from "./fakes.ts";

const empty9: Position = { size: 9, komi: 7, moves: [], rules: "chinese" };
const opening9: Position = {
  ...empty9,
  moves: [
    ["B", "E5"],
    ["W", "C4"],
    ["B", "D3"],
    ["W", "G5"],
  ],
};

describe.skipIf(!hasKataGo())("KataGo (real engine)", () => {
  const kg = new KataGo({ onLog: (l) => process.env.KATAGO_VERBOSE && console.log(`[katago] ${l}`) });
  const timings: Record<string, number> = {};

  async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    const out = await fn();
    timings[label] = Math.round(performance.now() - t0);
    return out;
  }

  beforeAll(async () => {
    await timed("startup", () => kg.start());
  }, 600_000);

  afterAll(async () => {
    await kg.stop();
    console.log("KataGo latencies (ms):", JSON.stringify(timings, null, 1));
  });

  it("analyzes the empty 9x9 board", async () => {
    await timed("warmup analysis (400 visits)", () => kg.analyze(empty9, { maxVisits: 400 }));
    const a = await timed("analysis empty 9x9 (400 visits, ownership)", () =>
      kg.analyze(empty9, { maxVisits: 400, includeOwnership: true }),
    );
    expect(a.toPlay).toBe("B");
    expect(a.rootInfo.visits).toBeGreaterThanOrEqual(400);
    expect(a.rootInfo.winrate).toBeGreaterThan(0);
    expect(a.rootInfo.winrate).toBeLessThan(1);
    // Komi 7 on 9x9 is close to fair for Black.
    expect(Math.abs(a.rootInfo.scoreLead)).toBeLessThan(5);
    expect(a.moveInfos.length).toBeGreaterThan(0);
    expect(a.moveInfos[0]!.order).toBe(0);
    expect(a.moveInfos[0]!.pv.length).toBeGreaterThan(0);
    expect(a.ownership).toHaveLength(81);
  }, 300_000);

  it("analyzes a position after a few moves for either side to move", async () => {
    const a = await timed("analysis after 4 moves (400 visits)", () => kg.analyze(opening9, { maxVisits: 400 }));
    expect(a.toPlay).toBe("B");
    const w = await kg.analyze({ ...opening9, moves: opening9.moves.slice(0, 3) }, { maxVisits: 100, includeOwnership: true });
    expect(w.toPlay).toBe("W");
    // Ownership is from Black's view: the center stone at E5 (index 4*9+4) belongs to Black.
    expect(w.ownership![40]!).toBeGreaterThan(0.5);
  }, 300_000);

  it("runs concurrent queries and matches them by id", async () => {
    const results = await timed("3 concurrent analyses (100 visits)", () =>
      Promise.all([
        kg.analyze(empty9, { maxVisits: 100 }),
        kg.analyze(opening9, { maxVisits: 100 }),
        kg.analyze({ ...opening9, moves: opening9.moves.slice(0, 1) }, { maxVisits: 100 }),
      ]),
    );
    expect(results.map((r) => r.toPlay)).toEqual(["B", "B", "W"]);
    expect(new Set(results.map((r) => r.id)).size).toBe(3);
  }, 300_000);

  it("reports query errors without breaking the engine", async () => {
    await expect(kg.analyze({ ...empty9, moves: [["B", "Z99"]] })).rejects.toThrow(/KataGo rejected/);
    const a = await kg.analyze(empty9, { maxVisits: 10 });
    expect(a.rootInfo.visits).toBeGreaterThan(0);
  }, 300_000);

  it("plays bot moves at 20k and 1d", async () => {
    const legal = /^[A-HJ][1-9]$|^pass$/;
    const m20k = await timed("bot move 20k (40 visits)", () => kg.botMove(opening9, "20k"));
    const m1d = await timed("bot move 1d (40 visits)", () => kg.botMove(opening9, "rank_1d"));
    expect(m20k).toMatch(legal);
    expect(m1d).toMatch(legal);
    expect(m1d).not.toBe("pass");
    const occupied = new Set(opening9.moves.map(([, g]) => g));
    expect(occupied.has(m20k)).toBe(false);
    expect(occupied.has(m1d)).toBe(false);
    console.log(`bot moves after E5 C4 D3 G5: 20k=${m20k} 1d=${m1d}`);
  }, 300_000);

  it("scores A1 as a big mistake and E5 as a good move", async () => {
    const evalMove = async (move: string) => {
      const [before, after] = await Promise.all([
        kg.analyze(empty9, { maxVisits: 400 }),
        kg.analyze({ ...empty9, moves: [["B", move]] }, { maxVisits: 400 }),
      ]);
      return moveEvalFrom(before, after);
    };
    const bad = await timed("evaluate A1 (400 visits x2)", () => evalMove("A1"));
    const good = await evalMove("E5");
    console.log(`A1: pointLoss=${bad.pointLoss.toFixed(2)} lead ${bad.leadBefore.toFixed(2)} -> ${bad.leadAfter.toFixed(2)}`);
    console.log(`E5: pointLoss=${good.pointLoss.toFixed(2)} lead ${good.leadBefore.toFixed(2)} -> ${good.leadAfter.toFixed(2)}`);
    expect(bad.pointLoss).toBeGreaterThan(5);
    expect(bad.winrateAfter).toBeLessThan(bad.winrateBefore);
    expect(good.pointLoss).toBeLessThan(1.5);
    expect(good.bestMove).toMatch(/^[A-HJ][1-9]$/);
    expect(good.candidates.length).toBeGreaterThan(0);
    expect(good.candidates.length).toBeLessThanOrEqual(5);
  }, 300_000);

  // Problem generation cancels its queries when the learner needs KataGo (generate.ts).
  it("cancels a query in flight and one still waiting, and keeps answering others", async () => {
    const empty19: Position = { size: 19, komi: 7, moves: [], rules: "chinese" };
    const abort = new AbortController();
    const t0 = performance.now();
    // Concurrency 2: two long searches fill KataGo, the third waits in our queue.
    const running = [kg.analyze(empty19, { maxVisits: 100_000, signal: abort.signal }), kg.analyze({ ...empty19, komi: 6.5 }, { maxVisits: 100_000, signal: abort.signal })];
    const waiting = kg.analyze({ ...empty19, komi: 6 }, { maxVisits: 100_000, signal: abort.signal });
    // Settled together: the waiting query rejects the moment it is cancelled.
    const settled = Promise.allSettled([...running, waiting]);
    await new Promise((r) => setTimeout(r, 300));
    abort.abort();
    for (const r of await settled) expect(r.status === "rejected" && isAbortError(r.reason)).toBe(true);
    const cancelMs = Math.round(performance.now() - t0);
    timings["cancel two 100k-visit searches"] = cancelMs;
    expect(cancelMs).toBeLessThan(10_000);
    const after = await kg.analyze(empty9, { maxVisits: 50 });
    expect(after.rootInfo.visits).toBeGreaterThan(0);
    await expect(kg.analyze(empty9, { maxVisits: 50, signal: abort.signal })).rejects.toSatisfy(isAbortError);
  }, 300_000);
});
