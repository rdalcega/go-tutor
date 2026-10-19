import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lessonsLogLine, migrateLessons } from "../../src/server/migrate-lessons.ts";
import type { StoredProblem } from "../../src/server/problems.ts";
import { defaultProfile } from "../../src/server/store.ts";
import { fromGtp } from "../../src/shared/coords.ts";
import type { Gtp, MistakeCategory, MoveRecord, Profile, SavedGame } from "../../src/shared/types.ts";
import { liveProblem, tempStore } from "./fakes.ts";

const GAME = "20261018-125442";
const T0 = Date.UTC(2026, 9, 18);

/** A human move that lost `loss` points where KataGo wanted `best` (the only good answer). */
function human(number: number, gtp: Gtp, best: Gtp, loss: number): MoveRecord {
  return {
    number,
    move: { color: "B", point: fromGtp(gtp, 9)! },
    captures: [],
    eval: {
      leadBefore: 0,
      leadAfter: -loss,
      pointLoss: loss,
      winrateBefore: 0.5,
      winrateAfter: 0.3,
      bestMove: best,
      bestPv: [best],
      candidates: [
        { move: best, lead: 0, winrate: 0.5, visits: 500, pv: [best] },
        { move: gtp, lead: -loss, winrate: 0.3, visits: 500, pv: [gtp] },
      ],
    },
  };
}

function bot(number: number, gtp: Gtp): MoveRecord {
  return { number, move: { color: "W", point: fromGtp(gtp, 9)! }, captures: [] };
}

type Entry = NonNullable<SavedGame["summary"]>["mistakes"][number];
const entry = (moveNumber: number, move: Gtp, bestMove: Gtp, pointLoss: number, category: MistakeCategory, tutor = false): Entry => ({
  moveNumber,
  move,
  pointLoss,
  bestMove,
  category,
  categorySource: tutor ? "tutor" : "heuristic",
});

/**
 * Black plays elsewhere at moves 1, 3 and 5 while A1 stays the point (nothing played near it): one
 * run. Move 7 misses G7: a mistake of its own. The tutor tagged move 1 (later) and move 3 (earlier).
 */
function savedGame(): SavedGame {
  const moves = [human(1, "E5", "A1", 5), bot(2, "E7"), human(3, "G5", "A1", 6), bot(4, "C7"), human(5, "G3", "A1", 9), bot(6, "J9"), human(7, "C3", "G7", 4)];
  return {
    id: GAME,
    settings: { size: 9, komi: 7, humanColor: "B", botRank: "20k", handicap: 0 },
    createdAt: T0,
    updatedAt: T0,
    moves,
    result: { winner: "W", margin: 10, reason: "score" },
    summary: {
      moves: 7,
      threshold: 4,
      mistakes: [
        entry(5, "G3", "A1", 9, "capturing_race"),
        entry(3, "G5", "A1", 6, "life_and_death", true),
        entry(1, "E5", "A1", 5, "opening", true),
        entry(7, "C3", "G7", 4, "endgame"),
      ],
      totalPointLoss: 24,
    },
    chat: [],
    tags: { 1: { category: "opening", note: "Corner first" }, 3: { category: "life_and_death", note: "A1 makes the eye" } },
  };
}

/** The profile as the old server left it: every mistake counted once, move 5 already out of the recent window. */
function oldProfile(): Profile {
  const profile = defaultProfile();
  profile.ratingModel = 2;
  profile.mistakeCounts = { ...profile.mistakeCounts, opening: 1, life_and_death: 1, capturing_race: 1, endgame: 1, shape: 2 };
  profile.recentMistakes = [
    { ts: T0 + 300, gameId: GAME, moveNumber: 1, category: "opening", pointLoss: 5, note: "Corner first" },
    { ts: T0 + 200, gameId: GAME, moveNumber: 3, category: "life_and_death", pointLoss: 6, note: "A1 makes the eye" },
    { ts: T0 + 100, gameId: GAME, moveNumber: 7, category: "endgame", pointLoss: 4 },
    { ts: T0 - 1000, gameId: "older", moveNumber: 9, category: "shape", pointLoss: 5 },
  ];
  profile.recentGames = [{ ts: T0 + 100, gameId: GAME, size: 9, humanMoves: 4, avgPointLoss: 6, mistakes: 4, threshold: 4 }];
  return profile;
}

function gameProblem(id: string, moveNumber: number, played: Gtp, overrides: Partial<StoredProblem> = {}): StoredProblem {
  return liveProblem({
    id,
    kind: "game",
    hash: `h-${id}`,
    source: { gameId: GAME, moveNumber, played, swapped: false },
    answers: ["A1"],
    category: "opening",
    ...overrides,
  });
}

function seed() {
  const store = tempStore();
  store.saveProfile(oldProfile());
  store.saveGame(savedGame(), "(;GM[1])");
  store.saveProblems([
    gameProblem("p1", 1, "E5", { box: 3, due: T0 + 5000, lastSeen: T0 + 10, lastResult: "first_try" }),
    gameProblem("p2", 3, "G5", { category: "life_and_death", box: 2, due: T0 + 9000, lastSeen: T0 + 20, lastResult: "failed", missedAt: [T0 + 20] }),
    gameProblem("p3", 5, "G3", { category: "capturing_race", box: 4, due: T0 + 1000 }),
    gameProblem("p4", 7, "C3", { category: "endgame", answers: ["G7"] }),
    // A game that is gone: its two problems missed the same point on the same board.
    liveProblem({ id: "p5", kind: "game", hash: "h-p5", category: "shape", difficulty: 5, source: { gameId: "gone", moveNumber: 11, played: "D1", swapped: false } }),
    liveProblem({ id: "p6", kind: "game", hash: "h-p6", category: "tactics", difficulty: 8, source: { gameId: "gone", moveNumber: 13, played: "F1", swapped: false } }),
  ]);
  return store;
}

describe("migrateLessons", () => {
  it("adds the runs, gives each one category, counts it once and links its problems into one lesson", () => {
    const store = seed();
    const original = readFileSync(join(store.dir, "profile.json"), "utf8");
    const result = migrateLessons(store, T0 + 10_000)!;
    expect(result.report).toMatchObject({ games: 1, runs: 1, runMistakes: 3, uncounted: 2, lessons: 2, linked: 5, fallback: 1 });
    expect(lessonsLogLine(result)).toContain("5 practice problems linked into 2 lessons");

    // The game: its run, one category (the most recent tag: move 1's, though move 3 comes later), tags kept with their notes.
    const game = store.loadGame(GAME)!;
    expect(game.summary!.runs).toEqual([{ answer: "A1", mistakes: [{ moveNumber: 1 }, { moveNumber: 3 }, { moveNumber: 5 }], lead: { moveNumber: 3 } }]);
    const byMove = Object.fromEntries(game.summary!.mistakes.map((m) => [m.moveNumber, m]));
    expect([1, 3, 5].map((n) => byMove[n]!.category)).toEqual(["opening", "opening", "opening"]);
    expect(byMove[5]!.categorySource).toBe("heuristic"); // the tutor didn't discuss it
    expect(byMove[7]!.category).toBe("endgame");
    expect(game.tags).toEqual({ 1: { category: "opening", note: "Corner first" }, 3: { category: "opening", note: "A1 makes the eye" } });

    // The profile: the run counts once (move 5, out of the recent window, comes off the tallies too).
    const profile = store.loadProfile();
    expect(profile.lessons).toBe(1);
    expect(profile.mistakeCounts).toMatchObject({ opening: 1, life_and_death: 0, capturing_race: 0, endgame: 1, shape: 2 });
    expect(profile.recentMistakes).toEqual([
      { ts: T0 + 300, gameId: GAME, moveNumber: 3, category: "opening", pointLoss: 6, note: "A1 makes the eye" },
      { ts: T0 + 100, gameId: GAME, moveNumber: 7, category: "endgame", pointLoss: 4 },
      { ts: T0 - 1000, gameId: "older", moveNumber: 9, category: "shape", pointLoss: 5 },
    ]);
    expect(profile.recentGames[0]!.mistakes).toBe(2);

    // The problems: one lesson named by its first variant, with the most urgent schedule and the run's category.
    const problems = Object.fromEntries(store.loadProblems().map((p) => [p.id, p]));
    for (const id of ["p1", "p2", "p3"]) {
      expect(problems[id]).toMatchObject({ lesson: { id: "p1", answer: "A1" }, box: 2, due: T0 + 1000, lastResult: "failed", missedAt: [T0 + 20], category: "opening" });
    }
    expect(problems.p4!.lesson).toBeUndefined();
    // The gone game's problems, grouped from the problems alone: the worst mistake's category.
    expect(problems.p5).toMatchObject({ lesson: { id: "p5", answer: "E1" }, category: "tactics" });
    expect(problems.p6).toMatchObject({ lesson: { id: "p5", answer: "E1" }, category: "tactics" });

    // Backed up first.
    expect(result.backupDir).toMatch(/backup-2026-10-18T00-00-10-000Z$/);
    expect(readFileSync(join(result.backupDir!, "profile.json"), "utf8")).toBe(original);
    expect(existsSync(join(result.backupDir!, "problems.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(result.backupDir!, "games", `${GAME}.json`), "utf8")).summary.runs).toBeUndefined();
  });

  it("runs once", () => {
    const store = seed();
    migrateLessons(store, T0 + 10_000);
    const files = ["profile.json", "problems.json", `games/${GAME}.json`].map((f) => readFileSync(join(store.dir, f), "utf8"));
    expect(migrateLessons(store, T0 + 20_000)).toBeNull();
    expect(["profile.json", "problems.json", `games/${GAME}.json`].map((f) => readFileSync(join(store.dir, f), "utf8"))).toEqual(files);
    expect(existsSync(join(store.dir, "backup-2026-10-18T00-00-20-000Z"))).toBe(false);
  });

  it("waits for the rating migration: nothing changes while the profile isn't on rating model 2", () => {
    const store = seed();
    const profile = store.loadProfile();
    delete profile.ratingModel;
    store.saveProfile(profile);
    const before = readFileSync(join(store.dir, "problems.json"), "utf8");
    expect(migrateLessons(store, T0 + 10_000)).toBeNull();
    expect(store.loadProfile().lessons).toBeUndefined();
    expect(readFileSync(join(store.dir, "problems.json"), "utf8")).toBe(before);
  });

  it("puts back what it wrote when a write fails partway, so the next start runs it again", () => {
    const store = seed();
    const paths = ["profile.json", "problems.json", `games/${GAME}.json`];
    const files = paths.map((f) => readFileSync(join(store.dir, f), "utf8"));
    let fail = true;
    const flaky = Object.assign(Object.create(store) as typeof store, {
      saveProblems(problems: StoredProblem[]) {
        if (fail) {
          fail = false;
          throw new Error("disk full");
        }
        store.saveProblems(problems);
      },
    });
    expect(() => migrateLessons(flaky, T0 + 10_000)).toThrow("disk full");
    expect(paths.map((f) => readFileSync(join(store.dir, f), "utf8"))).toEqual(files);
    expect(migrateLessons(store, T0 + 20_000)!.report).toMatchObject({ runs: 1, uncounted: 2, lessons: 2 });
  });

  it("only sets the flag on a fresh data folder, without a backup", () => {
    const store = tempStore();
    store.saveProfile({ ...defaultProfile(), ratingModel: 2 });
    const result = migrateLessons(store, T0)!;
    expect(result.backupDir).toBeNull();
    expect(lessonsLogLine(result)).toBeNull();
    expect(store.loadProfile().lessons).toBe(1);
  });
});
