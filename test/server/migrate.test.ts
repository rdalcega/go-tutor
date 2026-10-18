import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GameController, MAX_MIGRATION_ATTEMPTS, MIGRATION_RETRY_MS } from "../../src/server/game.ts";
import { BACKGROUND_PRIORITY } from "../../src/server/katago.ts";
import { MigrationAborted, migrateRatingModel, pairAttempts, reconstructGame } from "../../src/server/migrate.ts";
import { defaultProfile, type Store } from "../../src/server/store.ts";
import type { Profile, SavedGame, TakenBackMove, TutorEvent } from "../../src/shared/types.ts";
import { FakeClock, FakeEngine, flush, tempStore } from "./fakes.ts";

/** A human-SL policy that likes every move best at 10k (rating 20), less each rank away. */
function tenKyu(engine: FakeEngine): void {
  engine.humanPolicy = (pos, profile) => {
    const n = pos.size * pos.size + 1;
    const kyu = Number(/rank_(\d+)k/.exec(profile)?.[1] ?? 0);
    return new Array(n).fill(Math.exp(-Math.abs(kyu - 10) / 10) / n);
  };
}

/**
 * A finished game played through the controller with an event log, as the server writes one: a
 * KataGo hint before move 1, a mistake at move 3 taken back with Try again, then plain moves to a
 * resignation. Then the game file and profile are put back the way the old server saved them: no
 * first attempts, no help, the old Elo rating.
 */
async function oldGame(): Promise<{ store: Store; engine: FakeEngine; clock: FakeClock; gameId: string; current: SavedGame }> {
  const engine = new FakeEngine();
  const clock = new FakeClock();
  const store = tempStore();
  const ctl = new GameController({ engine, store, clock, botDelayMs: 0 });
  let seq = 0;
  ctl.onEvent((e) => store.appendEvent({ ...e, seq: ++seq, ts: clock.now() } as TutorEvent));
  ctl.setEngineState("ready");
  ctl.newGame();
  await flush();
  const step = async () => {
    await flush();
    clock.advance(1000);
  };
  engine.botMoves = ["J9", "J8", "J7", "J6", "J5", "J4", "J3", "J2", "J1", "H9", "H8", "H7"];
  await ctl.handleAction({ type: "ask_tutor" });
  await step();
  ctl.play({ x: 4, y: 4 }); // 1 E5, after KataGo's hint
  await step();
  engine.lossAfter(["E5", "J9", "C3"], 6);
  ctl.play({ x: 2, y: 6 }); // 3 C3, a mistake
  await step();
  await ctl.handleAction({ type: "retry" });
  await step();
  ctl.play({ x: 3, y: 5 }); // 3 D4, the second try
  await step();
  for (let i = 0; i < 10; i++) {
    ctl.play({ x: i % 8, y: 8 - Math.floor(i / 8) }); // 5 … 23: A1 … H1, A2, B2 (the bot plays on J and H9-H7)
    await step();
  }
  await ctl.handleAction({ type: "resign" });
  await ctl.ratingIdle();
  await flush(10);
  ctl.flush();
  const gameId = ctl.view().gameId!;
  const current = store.loadGame(gameId)!;
  // The old server's record: the first attempt and the help weren't kept.
  const old: SavedGame = {
    ...current,
    moves: current.moves.map(({ assist: _a, ...r }) => r),
    summary: { ...current.summary!, mistakes: current.summary!.mistakes.filter((m) => m.takenBack === undefined), rating: { before: 10, after: 11.5, rated: true, nextBotRank: "18k", nextHandicap: 0 } },
  };
  delete old.takenBack;
  delete old.assistance;
  delete old.summary!.assistance;
  store.saveGame(old, store.loadSgf(gameId)!);
  const profile: Profile = {
    ...defaultProfile(),
    rating: 11.5,
    botRank: "18k",
    gamesPlayed: 1,
    ratingHistory: [{ ts: 5, gameId, rating: 11.5, botRank: "20k", won: false, handicap: 0, delta: 1.5 }],
    recentGames: [{ ts: 5, gameId, size: 9, humanMoves: 11, avgPointLoss: 0, mistakes: 0, threshold: 4 }],
  };
  store.saveProfile(profile);
  store.saveProblems([]);
  return { store, engine, clock, gameId, current };
}

describe("rating model migration", () => {
  it("rebuilds a game's first attempts and help from the event log", async () => {
    const { store, gameId, current } = await oldGame();
    const rebuilt = reconstructGame(store.loadGame(gameId)!, store.readEvents());
    expect(rebuilt.complete).toBe(true);
    expect(rebuilt.assistance).toEqual({ hints: 1, takeBacks: 1, rethinks: 0 });
    // The same first attempt the live server kept, with the eval its teaching moment carried.
    expect(rebuilt.takenBack).toMatchObject([{ moveNumber: 3, by: "human", before: ["E5", "J9"], record: { move: { color: "B", point: { x: 2, y: 6 } } } }]);
    expect(rebuilt.takenBack[0]!.record.eval?.pointLoss).toBe(6);
    expect(rebuilt.takenBack[0]!.before).toEqual(current.takenBack![0]!.before);
    // The hint KataGo answered (circled) and the second try.
    expect(rebuilt.moves[0]!.assist).toEqual(["hint", "shown"]);
    expect(rebuilt.moves[2]!.assist).toEqual(["retry"]);
    expect(rebuilt.moves.map((r) => r.assist)).toEqual(current.moves.map((r) => r.assist));
  });

  it("uses only what survives when the log doesn't replay to the saved game", async () => {
    const { store, gameId } = await oldGame();
    const saved = store.loadGame(gameId)!;
    expect(reconstructGame(saved, [])).toMatchObject({ complete: false, events: 0, takenBack: [] });
    // A log that lost the end of the game: its first attempts are kept, the help on moves is not.
    const events = store.readEvents().filter((e) => e.type !== "move" || e.record.number < 6);
    const partial = reconstructGame(saved, events);
    expect(partial.complete).toBe(false);
    expect(partial.takenBack).toHaveLength(1);
    expect(partial.moves.every((r) => !r.assist)).toBe(true);
  });

  it("pairs the file's first attempts with the log's by move, position and order, not by index", () => {
    const a: TakenBackMove = { moveNumber: 3, by: "human", ts: 1, before: ["E5", "J9"], record: { number: 3, move: { color: "B", point: { x: 2, y: 6 } }, captures: [] } };
    const b: TakenBackMove = { ...a, moveNumber: 5, before: ["E5", "J9", "D4", "J8"] };
    const file = [{ ...b, tag: { category: "tactics" as const } }, a, { ...a, tag: { category: "shape" as const } }];
    // The log has the two identical tries at move 3 first; the second one gets the second file entry's tag.
    expect(pairAttempts(file, [a, a, b]).map(([, t]) => t?.tag?.category)).toEqual([undefined, "shape", "tactics"]);
    expect(pairAttempts(file, [a, a, a]).map(([, t]) => t?.tag?.category)).toEqual([undefined, "shape", undefined]);
    expect(pairAttempts([], [a])).toEqual([[a, undefined]]);
  });

  it("takes the log's first attempts when it replays the game, with what the file knows of them", async () => {
    const { store, gameId, current } = await oldGame();
    // The file kept the attempt, and the tutor tagged it: the log's rebuild carries the tag.
    store.saveGame({ ...current, takenBack: [{ ...current.takenBack![0]!, tag: { category: "shape" } }] }, store.loadSgf(gameId)!);
    const saved = store.loadGame(gameId)!;
    const rebuilt = reconstructGame(saved, store.readEvents());
    expect(rebuilt.complete).toBe(true);
    expect(rebuilt.takenBack).toMatchObject([{ moveNumber: 3, tag: { category: "shape" }, record: { eval: { pointLoss: 6 } } }]);
    expect(rebuilt.takenBack[0]).not.toBe(saved.takenBack![0]); // a copy: the migration's work leaves the file's objects alone
  });

  it("keeps a game's saved first attempts when the log can't rebuild them", async () => {
    const { store, engine, gameId, current } = await oldGame();
    tenKyu(engine);
    // The new server's record (first attempts kept), whose events are gone from the log.
    store.saveGame(current, store.loadSgf(gameId)!);
    writeFileSync(join(store.dir, "events.jsonl"), "");
    expect(reconstructGame(store.loadGame(gameId)!, store.readEvents())).toMatchObject({ complete: false, takenBack: [{ moveNumber: 3, by: "human" }] });
    await migrateRatingModel({ store, engine, now: () => 1_800_000_000_000, log: () => {}, threshold: 4 });
    const saved = store.loadGame(gameId)!;
    expect(saved.takenBack).toHaveLength(1);
    expect(saved.summary!.mistakes).toMatchObject([{ moveNumber: 3, move: "C3", takenBack: 0 }]);
  });

  it("keeps a tag the tutor makes while its KataGo work runs", async () => {
    const { store, engine, gameId, current } = await oldGame();
    tenKyu(engine);
    store.saveGame(current, store.loadSgf(gameId)!); // the first attempt is on file, so the tutor can tag it
    let tagged = false;
    engine.respond = () => {
      if (tagged) return undefined;
      tagged = true;
      // `tutor tag <game> 3 shape --taken-back`, as the controller writes it, during the first KataGo query.
      const game = store.loadGame(gameId)!;
      game.takenBack![0]!.tag = { category: "shape", note: "empty triangle" };
      Object.assign(game.summary!.mistakes.find((m) => m.takenBack === 0)!, { category: "shape", categorySource: "tutor" });
      store.saveGame(game, store.loadSgf(gameId)!);
      return undefined;
    };
    const report = await migrateRatingModel({ store, engine, now: () => 1_800_000_000_000, log: () => {}, threshold: 4 });
    expect(tagged).toBe(true);
    const saved = store.loadGame(gameId)!;
    expect(saved.takenBack![0]!.tag).toEqual({ category: "shape", note: "empty triangle" });
    expect(saved.summary!.mistakes).toMatchObject([{ moveNumber: 3, takenBack: 0, category: "shape", categorySource: "tutor" }]);
    // The practice problem made from it carries the tag's category too, not the heuristic's.
    expect(report.problemsAdded).toHaveLength(1);
    expect(store.loadProblems().find((p) => p.id === report.problemsAdded[0])).toMatchObject({ category: "shape", prompt: expect.stringMatching(/good shape/) });
  });

  it("re-estimates the rating from the moves, adds the first attempts' mistakes and problems, backs up, and is idempotent", async () => {
    const { store, engine, gameId } = await oldGame();
    tenKyu(engine);
    const logs: string[] = [];
    const report = await migrateRatingModel({ store, engine, now: () => 1_800_000_000_000, log: (m) => logs.push(m), threshold: 4 });
    // Human moves 5 … 23 without help (3 is the second try): 10 of them, plus none of the first attempt (it was in the opening).
    expect(report.games).toMatchObject([{ gameId, complete: true, takenBack: 1, assisted: 2, takenBackMistakes: 1, rated: true, estimate: { rating: 20, moves: 10 } }]);
    expect(report.message).toMatch(/re-estimated from your game: 12k \(was 18k\).*10 moves you played on your own.*1 hint, 1 take-back/);
    expect(report.summary).toMatch(/rating model 2/);
    const profile = store.loadProfile();
    expect(profile.ratingModel).toBe(2);
    // Replayed from 20k: 0.8 × 20 + 0.2 × (10 + Elo of a resignation at 20k, shrunk by the 2 of 12 moves with help).
    const w = 0.2 * (1 - 2 / 12);
    expect(profile.rating).toBeCloseTo((1 - w) * 20 + w * 8.5, 2);
    expect(profile.ratingHistory).toMatchObject([{ gameId, estimate: { rating: 20, moves: 10, hints: 1, takeBacks: 1, rethinks: 0 } }]);
    expect(profile.botRank).toBe("12k");
    // The first attempt's mistake now counts, and the game's stats include it.
    expect(profile.recentMistakes).toMatchObject([{ gameId, moveNumber: 3, takenBack: 0, pointLoss: 6 }]);
    expect(Object.values(profile.mistakeCounts).reduce((a, b) => a + b, 0)).toBe(1);
    expect(profile.recentGames[0]).toMatchObject({ humanMoves: 13, mistakes: 1 });
    // The game file has the first attempt, the help and the new rating.
    const saved = store.loadGame(gameId)!;
    expect(saved.takenBack).toHaveLength(1);
    expect(saved.assistance).toEqual({ hints: 1, takeBacks: 1, rethinks: 0 });
    expect(saved.summary!.mistakes).toMatchObject([{ moveNumber: 3, move: "C3", takenBack: 0 }]);
    expect(saved.summary!.rating).toMatchObject({ before: 10, after: profile.rating, estimate: { rating: 20 } });
    // It became a practice problem.
    expect(report.problemsAdded).toHaveLength(1);
    expect(store.loadProblems().find((p) => p.kind === "game")?.source).toEqual({ gameId, moveNumber: 3, played: "C3", takenBack: 0 });
    // The files it changed were backed up first.
    expect(report.backupDir).toBeTruthy();
    for (const f of ["profile.json", "problems.json", join("games", `${gameId}.json`)]) expect(existsSync(join(report.backupDir!, f))).toBe(true);

    // Run again (as if the flag were lost): the same result, nothing counted twice.
    store.saveProfile({ ...profile, ratingModel: undefined });
    const again = await migrateRatingModel({ store, engine, now: () => 1_800_000_100_000, log: () => {}, threshold: 4 });
    expect(again.problemsAdded).toEqual([]);
    const second = store.loadProfile();
    expect(second.rating).toBe(profile.rating);
    expect(second.recentMistakes).toEqual(profile.recentMistakes);
    expect(second.mistakeCounts).toEqual(profile.mistakeCounts);
    expect(store.loadGame(gameId)!.summary!.mistakes).toEqual(saved.summary!.mistakes);
  });

  it("starts over at 20k when the games have too few moves played without help", async () => {
    const { store, engine } = await oldGame();
    tenKyu(engine);
    // The same data, but the log has every human move played with a hint: nothing to estimate from.
    const fresh = tempStore();
    for (const e of store.readEvents()) {
      fresh.appendEvent(e.type === "move" && e.by === "human" ? { ...e, record: { ...e.record, assist: ["hint"] } } : e);
    }
    for (const id of store.gameIds()) fresh.saveGame(store.loadGame(id)!, store.loadSgf(id)!);
    fresh.saveProfile(store.loadProfile());
    const report = await migrateRatingModel({ store: fresh, engine, now: () => 0, log: () => {}, threshold: 4 });
    expect(report.games[0]!.estimate).toBeNull();
    const profile = fresh.loadProfile();
    expect(profile).toMatchObject({ rating: 10, botRank: "20k", handicap: 0, ratingModel: 2 });
    expect(report.message).toMatch(/starts at 20k again/);
  });

  it("only sets the flag when there are no finished games", async () => {
    const store = tempStore();
    const report = await migrateRatingModel({ store, engine: new FakeEngine(), now: () => 0, log: () => {}, threshold: 4 });
    expect(report.message).toBeNull();
    expect(store.loadProfile()).toEqual({ ...defaultProfile(), ratingModel: 2 });
    expect(readdirSync(store.dir).some((f) => f.startsWith("backup-"))).toBe(false);
  });

  it("runs once from the controller when KataGo is ready, and tells the learner", async () => {
    const { store, engine, clock } = await oldGame();
    tenKyu(engine);
    const ctl = new GameController({ engine, store, clock, botDelayMs: 0 });
    await ctl.migrateRatings(); // KataGo isn't ready yet: nothing happens
    expect(store.loadProfile().ratingModel).toBeUndefined();
    ctl.setEngineState("ready");
    const version = ctl.view().profileVersion;
    await ctl.migrateRatings();
    expect(ctl.currentProfile.ratingModel).toBe(2);
    expect(ctl.view().profileVersion).toBe(version + 1);
    expect(ctl.view().chat.at(-1)!.text).toMatch(/Your rank was re-estimated/);
    const chat = ctl.view().chat.length;
    await ctl.migrateRatings();
    expect(ctl.view().chat).toHaveLength(chat);
  });

  it("finishes a rank estimate a stopped server left running", async () => {
    const { store, engine, clock, gameId } = await oldGame();
    tenKyu(engine);
    store.saveProfile({ ...store.loadProfile(), ratingModel: 2, ratingHistory: [], estimating: [gameId] });
    const ctl = new GameController({ engine, store, clock, botDelayMs: 0 });
    ctl.setEngineState("ready");
    await ctl.migrateRatings();
    await ctl.ratingIdle(); // the estimate is queued behind the check
    const profile = store.loadProfile();
    expect(profile.estimating).toBeUndefined();
    expect(profile.ratingHistory).toMatchObject([{ gameId, estimate: { rating: 20 } }]);
    // A game that is gone just clears its mark; a profile from before the list (one id) still loads.
    writeFileSync(join(store.dir, "profile.json"), JSON.stringify({ ...profile, estimating: "missing" }));
    expect(store.loadProfile().estimating).toEqual(["missing"]);
    const again = new GameController({ engine, store, clock, botDelayMs: 0 });
    again.setEngineState("ready");
    await again.migrateRatings();
    await again.ratingIdle();
    expect(store.loadProfile().estimating).toBeUndefined();
    expect(store.loadProfile().ratingHistory).toHaveLength(1);
  });

  it("writes nothing when KataGo fails partway, and the controller tries again later", async () => {
    const { store, engine, clock, gameId } = await oldGame();
    tenKyu(engine);
    const before = snapshot(store.dir);
    // The first-attempt categorization works; the rank estimate's policy queries fail.
    const analyze = engine.analyze.bind(engine);
    let failing = true;
    engine.analyze = (pos, opts) => (failing && opts?.includePolicy ? Promise.reject(new Error("KataGo stopped")) : analyze(pos, opts));
    await expect(migrateRatingModel({ store, engine, now: () => 0, log: () => {}, threshold: 4 })).rejects.toThrow(MigrationAborted);
    await expect(migrateRatingModel({ store, engine, now: () => 0, log: () => {}, threshold: 4 })).rejects.toThrow(/estimating the rank of .*KataGo stopped/);
    // Not a single file changed: no backup, games, profile or problems, and the rating model is unchanged.
    expect(snapshot(store.dir)).toEqual(before);
    expect(store.loadProfile().ratingModel).toBeUndefined();
    expect(store.loadProfile().rating).toBe(11.5);

    // From the controller: logged, retried after a minute, then four times longer, up to the cap.
    const logs: string[] = [];
    const ctl = new GameController({ engine, store, clock, botDelayMs: 0, log: (m) => logs.push(m) });
    ctl.setEngineState("ready");
    await ctl.migrateRatings();
    expect(logs.at(-1)).toMatch(/rating migration attempt 1 of 4 failed, nothing was written: KataGo failed estimating the rank of .*; trying again in 60 s/);
    expect(ctl.currentProfile.ratingModel).toBeUndefined();
    expect(clock.pendingTimers).toBe(1);
    clock.advance(MIGRATION_RETRY_MS);
    await ctl.ratingIdle();
    expect(logs.at(-1)).toMatch(/attempt 2 of 4 failed.*trying again in 240 s/);
    expect(snapshot(store.dir)).toEqual(before);
    // KataGo answers again: the next try migrates.
    failing = false;
    clock.advance(4 * MIGRATION_RETRY_MS);
    await ctl.ratingIdle();
    await ctl.ratingIdle();
    expect(store.loadProfile().ratingModel).toBe(2);
    expect(store.loadProfile().ratingHistory).toMatchObject([{ gameId, estimate: { rating: 20 } }]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("gives up after MAX_MIGRATION_ATTEMPTS failures until a restart", async () => {
    const { store, engine, clock } = await oldGame();
    engine.failAnalyze = true;
    const logs: string[] = [];
    const ctl = new GameController({ engine, store, clock, botDelayMs: 0, log: (m) => logs.push(m) });
    ctl.setEngineState("ready");
    await ctl.migrateRatings();
    for (let i = 1; i < MAX_MIGRATION_ATTEMPTS; i++) {
      clock.advance(MIGRATION_RETRY_MS * 4 ** (i - 1));
      await ctl.ratingIdle();
    }
    expect(logs.filter((l) => /rating migration attempt/.test(l))).toHaveLength(MAX_MIGRATION_ATTEMPTS);
    expect(logs.at(-1)).toMatch(/attempt 4 of 4 failed.*KataGo failed categorizing move 3 .*runs again when the server restarts/);
    expect(clock.pendingTimers).toBe(0);
    await ctl.migrateRatings(); // another engine-ready: still capped
    expect(logs.filter((l) => /rating migration attempt/.test(l))).toHaveLength(MAX_MIGRATION_ATTEMPTS);
    expect(store.loadProfile().ratingModel).toBeUndefined();
  });

  it("includes a game finished before it ran, which neither marks the model nor gets an Elo-only rating", async () => {
    const { store, engine, clock, gameId: oldId } = await oldGame();
    tenKyu(engine);
    const ctl = new GameController({ engine, store, clock, botDelayMs: 0 });
    ctl.setEngineState("ready");
    // A game played and finished while the migration hasn't run yet (it is queued at engine-ready).
    clock.advance(3_600_000);
    ctl.newGame();
    await flush();
    for (let i = 0; i < 10; i++) {
      ctl.play({ x: i % 8, y: 8 - Math.floor(i / 8) });
      await flush();
    }
    await ctl.handleAction({ type: "resign" });
    await ctl.ratingIdle();
    const newId = ctl.view().gameId!;
    expect(store.loadProfile()).toMatchObject({ rating: 11.5, estimating: [newId] });
    expect(store.loadProfile().ratingModel).toBeUndefined();
    expect(store.loadProfile().ratingHistory.map((e) => e.gameId)).toEqual([oldId]);
    await ctl.migrateRatings();
    await ctl.ratingIdle();
    const profile = store.loadProfile();
    expect(profile.ratingModel).toBe(2);
    expect(profile.estimating).toBeUndefined();
    expect(profile.ratingHistory.map((e) => [e.gameId, e.estimate?.moves])).toEqual([
      [oldId, 10],
      [newId, 8],
    ]);
    expect(store.loadGame(newId)!.summary!.rating).toMatchObject({ rated: true, after: profile.rating });
  });

  it("keeps the mark and the tallies of a game that finished while it ran", async () => {
    const { store, engine } = await oldGame();
    tenKyu(engine);
    // The controller finishes a game while the migration waits on KataGo: it writes the profile.
    const analyze = engine.analyze.bind(engine);
    let finished = false;
    engine.analyze = (pos, opts) => {
      if (!finished) {
        finished = true;
        const p = store.loadProfile();
        store.saveProfile({ ...p, gamesPlayed: p.gamesPlayed + 1, estimating: ["late"], recentMistakes: [{ ts: 9, gameId: "late", moveNumber: 7, category: "tactics", pointLoss: 5 }] });
      }
      return analyze(pos, opts);
    };
    await migrateRatingModel({ store, engine, now: () => 0, log: () => {}, threshold: 4 });
    const profile = store.loadProfile();
    expect(profile.ratingModel).toBe(2);
    expect(profile.estimating).toEqual(["late"]);
    expect(profile.gamesPlayed).toBe(2);
    expect(profile.recentMistakes.map((m) => m.gameId)).toContain("late");
  });

  it("runs every KataGo query at background priority", async () => {
    const { store, engine } = await oldGame();
    tenKyu(engine);
    engine.analyzeCalls = [];
    // Thin candidates make the first attempt's problem take a deeper analysis too.
    const report = await migrateRatingModel({ store, engine, now: () => 0, log: () => {}, threshold: 4 });
    expect(report.problemsAdded).toHaveLength(1);
    const kinds = new Set(engine.analyzeCalls.map((c) => (c.opts?.includePolicy ? "policy" : c.opts?.includeOwnership ? "ownership" : `visits ${c.opts?.maxVisits}`)));
    expect(kinds).toEqual(new Set(["policy", "ownership", "visits 1000"]));
    expect(engine.analyzeCalls.every((c) => c.opts?.priority === BACKGROUND_PRIORITY)).toBe(true);
  });
});

/** Every file under `dir` (relative path → contents). */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(out, snapshot(dir, rel));
    else out[rel] = readFileSync(join(dir, rel), "utf8");
  }
  return out;
}
