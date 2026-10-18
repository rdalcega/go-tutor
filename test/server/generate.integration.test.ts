// Problem generation against the real KataGo (skipped without it): a small batch at 20k vs 15k,
// two problems on 9×9 and one on 13×13, each checked against the filters. Takes a few minutes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toAscii } from "../../src/engine/index.ts";
import { tryFromGtp } from "../../src/shared/coords.ts";
import { MISTAKE_CATEGORIES } from "../../src/shared/types.ts";
import { systemClock } from "../../src/server/common.ts";
import { FIRST_CANDIDATE_MOVE, MAX_ANSWERS, ProblemGenerator, SIZE_SETTINGS, type BoardSize } from "../../src/server/generate.ts";
import { KataGo } from "../../src/server/katago.ts";
import { generatedSource, problemGame } from "../../src/server/problems.ts";
import { hasKataGo, tempStore } from "./fakes.ts";

describe.skipIf(!hasKataGo())("problem generation (real KataGo)", () => {
  const kg = new KataGo({ onLog: (l) => process.env.KATAGO_VERBOSE && console.log(`[katago] ${l}`) });

  beforeAll(async () => {
    await kg.start();
  }, 600_000);

  afterAll(async () => {
    await kg.stop();
  });

  it("generates problems at 20k vs 15k on 9×9 and 13×13 that meet the filters", async () => {
    const store = tempStore();
    const accepted: string[] = [];
    const lines: string[] = [];
    const generator = new ProblemGenerator({
      engine: kg,
      store,
      clock: systemClock,
      log: (msg) => lines.push(msg),
      debug: (msg) => {
        lines.push(msg);
        if (msg.includes("-> ok")) accepted.push(msg);
      },
      rating: () => 10,
      mayRun: () => true,
      updateProblems: (change) => {
        const problems = store.loadProblems();
        const out = change(problems);
        store.saveProblems(problems);
        return out;
      },
      changed: () => {},
      emit: () => {},
      system: () => {},
      quotas: () => ({ 9: 2, 13: 1, 19: 0 }),
    });
    const t0 = performance.now();
    generator.start();
    while (!generator.batches[0]?.finishedAt) await new Promise((r) => setTimeout(r, 500));
    generator.stop();
    await generator.idle();
    const minutes = (performance.now() - t0) / 60_000;

    const batch = generator.batches[0]!;
    const problems = store.loadProblems();
    console.log(
      `generated ${problems.length} problems in ${minutes.toFixed(1)} min: ` +
        (["9", "13"] as const).map((s) => `${s}x${s} ${(batch.stats[Number(s) as BoardSize].ms / 60_000).toFixed(1)} min, ${batch.stats[Number(s) as BoardSize].games} games, rejected ${JSON.stringify(batch.stats[Number(s) as BoardSize].rejected)}`).join("; "),
    );
    for (const p of problems) console.log(`${p.id} ${p.size}x${p.size} ${p.category} answers ${p.answers.join(",")} ${JSON.stringify(generatedSource(p))}\n${toAscii(problemGame(p).board, null)}`);
    expect(problems.filter((p) => p.size === 9)).toHaveLength(2);
    expect(problems.filter((p) => p.size === 13)).toHaveLength(1);
    expect(new Set(problems.map((p) => p.hash)).size).toBe(problems.length);

    for (const p of problems) {
      const size = p.size as BoardSize;
      const source = generatedSource(p)!;
      expect(p).toMatchObject({ kind: "generated", toPlay: "B", komi: 7, box: 1 });
      expect(source).toMatchObject({ kind: "generated", batchId: "batch1", weakerRank: "20k", strongerRank: "15k" });
      expect(MISTAKE_CATEGORIES).toContain(p.category);
      expect(p.prompt).toMatch(/^Black to play\./);
      // Big (confirmed by the deeper analysis), not in the opening moves, at most 3 answers.
      expect(p.difficulty!).toBeGreaterThanOrEqual(SIZE_SETTINGS[size].minLoss);
      expect(source.moveNumber).toBeGreaterThanOrEqual(FIRST_CANDIDATE_MOVE);
      expect(p.answers.length).toBeGreaterThanOrEqual(1);
      expect(p.answers.length).toBeLessThanOrEqual(MAX_ANSWERS);
      // Every answer is a legal move, and the mistake isn't one of them.
      const game = problemGame(p);
      for (const a of p.answers) expect(game.illegalReason(tryFromGtp(a, size)!), `${p.id} answer ${a}`).toBeNull();
      expect(p.answers).not.toContain(source.played);
      expect(game.illegalReason(tryFromGtp(source.played, size)!)).toBeNull();
      // The difficulty is a rank on KataGo's human-SL scale.
      expect(source.difficultyRating).toBeGreaterThanOrEqual(10);
      expect(source.difficultyRating).toBeLessThanOrEqual(38);
    }
    // Clear and local, as measured when it was accepted.
    for (const line of accepted.slice(0, problems.length)) {
      const size = Number(/ (\d+)x\d+ /.exec(line)![1]) as BoardSize;
      const gap = /gap (Infinity|[\d.]+)/.exec(line)![1]!;
      expect(gap === "Infinity" || Number(gap) >= SIZE_SETTINGS[size].minWrongGap, line).toBe(true);
      expect(line).toMatch(/, local ->/);
    }
  }, 30 * 60_000);
});
