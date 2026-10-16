import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store, type SavedGame } from "../../src/server/store.ts";
import type { TutorEvent } from "../../src/shared/types.ts";
import { tempStore } from "./fakes.ts";

const fallback = (seq: number): TutorEvent => ({ seq, ts: 0, type: "fallback", momentId: `m${seq}` });

function game(id: string, createdAt: number): SavedGame {
  return {
    id,
    settings: { size: 9, komi: 7, humanColor: "B", botRank: "20k", handicap: 0 },
    createdAt,
    updatedAt: createdAt,
    moves: [],
    result: null,
    summary: null,
    chat: [],
    tags: {},
  };
}

describe("Store", () => {
  it("ends a torn last line of the event log before appending", () => {
    const store = tempStore();
    store.appendEvent(fallback(1));
    appendFileSync(join(store.dir, "events.jsonl"), '{"seq":2,"ts":0,"ty'); // a crash mid-write
    const restarted = new Store(store.dir);
    expect(restarted.lastEventSeq()).toBe(1);
    restarted.appendEvent(fallback(2));
    restarted.appendEvent(fallback(3));
    expect(restarted.readEvents().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(readFileSync(join(store.dir, "events.jsonl"), "utf8").endsWith("\n")).toBe(true);
  });

  it("orders games by creation time, with numeric id suffixes as a tie-breaker", () => {
    const store = tempStore();
    const base = "20261015-120000";
    for (const id of [base, ...Array.from({ length: 9 }, (_, i) => `${base}-${i + 2}`)]) store.saveGame(game(id, 1000), "");
    expect(store.gameIds().slice(-2)).toEqual([`${base}-9`, `${base}-10`]);
    expect(store.lastGame()!.id).toBe(`${base}-10`);
    // An id that sorts last but was created earlier (a clock set back) isn't the newest.
    store.saveGame(game("20261015-130000", 500), "");
    expect(store.lastGame()!.id).toBe(`${base}-10`);
  });

  it("finds the newest game from the index, and rebuilds the index when it is missing", () => {
    const store = tempStore();
    store.saveGame(game("a", 3000), "");
    store.saveGame({ ...game("b", 2000), result: { winner: "B", margin: 3, reason: "score" } }, "");
    store.saveGame({ ...game("c", 1000), result: { winner: null, margin: 0, reason: "abandon" } }, "");
    expect(store.lastGame()!.id).toBe("a");
    expect(store.lastGame({ finished: true })!.id).toBe("b");
    // Only the chosen game is parsed: a corrupt older game doesn't get in the way.
    writeFileSync(join(store.dir, "games", "c.json"), "{torn");
    expect(new Store(store.dir).lastGame()!.id).toBe("a");

    // A game saved by another Store (or before the index existed) is picked up.
    new Store(store.dir).saveGame(game("d", 4000), "");
    expect(store.lastGame()!.id).toBe("d");
    rmSync(join(store.dir, "games", "index.json"));
    const fresh = new Store(store.dir);
    expect(fresh.lastGame()!.id).toBe("d");
    expect(fresh.lastGame({ finished: true })!.id).toBe("b");
    expect(existsSync(join(store.dir, "games", "index.json"))).toBe(true);
    expect(fresh.gameIds()).toEqual(["a", "b", "c", "d"]);
  });

  it("finds the last seq from the end of a long log", () => {
    const store = tempStore();
    const big = (seq: number, text = "x".repeat(50_000)): TutorEvent => ({ seq, ts: 0, type: "user_message", text, gameId: null });
    for (let seq = 1; seq <= 5; seq++) store.appendEvent(big(seq));
    expect(new Store(store.dir).lastEventSeq()).toBe(5);
    // A last line longer than the tail window still counts.
    store.appendEvent(big(6, "y".repeat(200_000)));
    expect(new Store(store.dir).lastEventSeq()).toBe(6);
  });

  it("rotates the event log and still replays across the rotation", () => {
    const dir = tempStore().dir;
    const store = new Store(dir, { maxEventLogBytes: 200 });
    for (let seq = 1; seq <= 10; seq++) store.appendEvent(fallback(seq));
    expect(existsSync(join(dir, "events.1.jsonl"))).toBe(true);
    expect(readFileSync(join(dir, "events.jsonl"), "utf8").length).toBeLessThan(400);
    const restarted = new Store(dir, { maxEventLogBytes: 200 });
    expect(restarted.lastEventSeq()).toBe(10);
    const kept = restarted.readEvents().map((e) => e.seq);
    expect(kept.at(-1)).toBe(10);
    expect(restarted.readEvents(8).map((e) => e.seq)).toEqual([9, 10]);
    // Asking for more than the current file holds reaches into the rotated one.
    const first = kept[0]!;
    expect(restarted.readEvents(first).map((e) => e.seq)).toEqual(kept.slice(1));
  });
});
