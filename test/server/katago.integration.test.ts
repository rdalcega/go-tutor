// Runs against the real KataGo. Skipped when `katago` is not on PATH.
// Prints measured latencies so the server can size its timeouts.
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_PROBLEMS } from "../../src/server/builtin-problems.ts";
import { KataGo, moveEvalFrom, type Position } from "../../src/server/katago.ts";
import { ANSWER_MARGIN, builtinProblem, problemPosition } from "../../src/server/problems.ts";

function hasKataGo(): boolean {
  try {
    execFileSync("katago", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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

  // The built-in practice problems (src/server/builtin-problems.ts): KataGo's best move is one of
  // the answers, every answer loses at most ANSWER_MARGIN (the server's check for an attempt), and
  // each problem is clear: passing costs at least 3 points and the best wrong move at least 2.
  it("agrees with every built-in problem's answers, and each problem has a clear best move", async () => {
    const VISITS = 1200;
    const reports = await timed("built-in problems (1200 visits)", () =>
      Promise.all(
        BUILTIN_PROBLEMS.map(async (def) => {
          const p = builtinProblem(def);
          const analyze = (moves: string[] = []) => kg.analyze(problemPosition(p, moves), { maxVisits: VISITS });
          const [root, pass, ...answers] = await Promise.all([analyze(), analyze(["pass"]), ...p.answers.map((a) => analyze([a]))]);
          const best = root.moveInfos[0]!;
          const wrong = root.moveInfos.find((m) => !p.answers.includes(m.move) && m.move !== "pass");
          const round = (n: number) => Math.round(n * 10) / 10;
          return {
            id: p.id,
            best: best.move,
            answerLosses: Object.fromEntries(p.answers.map((a, i) => [a, round(moveEvalFrom(root, answers[i]!).pointLoss)])),
            passLoss: round(moveEvalFrom(root, pass).pointLoss),
            wrong: wrong ? { move: wrong.move, gap: round(best.scoreLead - wrong.scoreLead) } : null,
          };
        }),
      ),
    );
    console.log("built-in problems:", JSON.stringify(reports));
    for (const r of reports) {
      const def = BUILTIN_PROBLEMS.find((d) => d.id === r.id)!;
      expect(def.answers, `${r.id}: KataGo's best ${r.best} is an answer`).toContain(r.best);
      for (const [move, loss] of Object.entries(r.answerLosses)) {
        expect(loss, `${r.id}: answer ${move} loses ${loss}`).toBeLessThanOrEqual(ANSWER_MARGIN);
      }
      expect(r.passLoss, `${r.id}: passing loses ${r.passLoss}`).toBeGreaterThanOrEqual(3);
      if (r.wrong) expect(r.wrong.gap, `${r.id}: the best wrong move ${r.wrong.move} is ${r.wrong.gap} worse`).toBeGreaterThanOrEqual(2);
    }
  }, 600_000);
});
