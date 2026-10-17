import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store, readLinesBackward } from "../../src/server/store.ts";
import type { SavedGame, TutorEvent } from "../../src/shared/types.ts";
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

    // The index lives in memory: a game saved by another Store is picked up at the next start.
    new Store(store.dir).saveGame(game("d", 4000), "");
    expect(store.lastGame()!.id).toBe("a");
    expect(new Store(store.dir).lastGame()!.id).toBe("d");
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

  it("replays events since a seq from the end of a long log", () => {
    const store = tempStore();
    const big = (seq: number): TutorEvent => ({ seq, ts: 0, type: "user_message", text: "x".repeat(30_000), gameId: null });
    for (let seq = 1; seq <= 10; seq++) store.appendEvent(big(seq));
    const restarted = new Store(store.dir);
    expect(restarted.readEvents(7).map((e) => e.seq)).toEqual([8, 9, 10]);
    expect(restarted.readEvents(1).map((e) => e.seq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(restarted.readEvents(10)).toEqual([]);
    expect(restarted.readEvents().map((e) => e.seq)).toHaveLength(10);
  });

  it("reads lines backwards in fixed chunks, each byte once, across chunk boundaries", () => {
    const path = join(tempStore().dir, "lines.txt");
    const lines = ["first", "ünïcødé ✓ line", "", "x".repeat(37), "last"];
    writeFileSync(path, lines.join("\n") + "\n");
    const size = readFileSync(path).length;
    for (const chunk of [1, 2, 3, 5, 7, 64 * 1024]) {
      const seen: string[] = [];
      const read = readLinesBackward(path, (l) => (seen.push(l), false), chunk);
      expect(seen).toEqual(["", ...[...lines].reverse()]);
      expect(read).toBe(size);
    }
    // Stopping early reads only as far back as needed.
    const seen: string[] = [];
    const read = readLinesBackward(path, (l) => (seen.push(l), l === "last"), 4);
    expect(seen).toEqual(["", "last"]);
    expect(read).toBeLessThanOrEqual(8);
  });

  it("replays from the end of the log without re-reading it, and across the rotated file", () => {
    const dir = tempStore().dir;
    const store = new Store(dir, { maxEventLogBytes: 2_000 });
    const msg = (seq: number): TutorEvent => ({ seq, ts: 0, type: "user_message", text: `é${"x".repeat(seq * 13)}`, gameId: null });
    for (let seq = 1; seq <= 40; seq++) store.appendEvent(msg(seq));
    expect(existsSync(join(dir, "events.1.jsonl"))).toBe(true);
    const restarted = new Store(dir);
    const all = restarted.readEvents().map((e) => e.seq);
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => all[0]! + i));
    expect(all.at(-1)).toBe(40);
    for (const since of [all[0]!, all[0]! + 3, 30, 39, 40]) {
      expect(restarted.readEvents(since).map((e) => e.seq)).toEqual(all.filter((s) => s > since));
    }
    expect(restarted.readEvents(all[0]! - 1).map((e) => e.seq)).toEqual(all);
  });

  it("recreates the data directory when it is removed while running", () => {
    const store = tempStore();
    rmSync(store.dir, { recursive: true, force: true });
    store.saveProfile(store.loadProfile());
    store.saveGame(game("a", 1000), "");
    store.appendEvent(fallback(1));
    expect(existsSync(join(store.dir, "profile.json"))).toBe(true);
    expect(store.loadGame("a")?.id).toBe("a");
    expect(store.readEvents().map((e) => e.seq)).toEqual([1]);
  });

  it("logs the JSON it is given for an event", () => {
    const store = tempStore();
    store.appendEvent(fallback(1), JSON.stringify(fallback(1)));
    expect(store.readEvents()).toEqual([fallback(1)]);
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

describe("Store backups", () => {
  it("copies the named data files into a new backup folder, keeping their layout", () => {
    const store = tempStore();
    store.saveProfile({ ...store.loadProfile(), rating: 12 });
    store.saveGame(game("g1", 1), "(;SZ[9])");
    expect(store.loadSgf("g1")).toBe("(;SZ[9])");
    expect(store.loadSgf("nope")).toBeNull();
    const dir = store.backup(["profile.json", "problems.json", "games/g1.json", "../outside.json"], Date.UTC(2026, 9, 17, 8, 0, 0));
    expect(dir).toBe(join(store.dir, "backup-2026-10-17T08-00-00-000Z"));
    expect(JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")).rating).toBe(12);
    expect(existsSync(join(dir, "games", "g1.json"))).toBe(true);
    expect(existsSync(join(dir, "problems.json"))).toBe(false); // there was none
    // A second backup in the same millisecond gets its own folder.
    expect(store.backup(["profile.json"], Date.UTC(2026, 9, 17, 8, 0, 0))).toBe(`${dir}-2`);
  });
});
