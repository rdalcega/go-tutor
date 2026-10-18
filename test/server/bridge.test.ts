import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SseParser } from "../../src/cli/sse.ts";
import { TutorBridge } from "../../src/server/bridge.ts";
import type { TutorEventInput } from "../../src/server/common.ts";
import type { GameController } from "../../src/server/game.ts";
import type { Store } from "../../src/server/store.ts";
import type { TutorEvent } from "../../src/shared/types.ts";

/** A bridge behind an HTTP server, with an in-memory log, a manual clock and manual timers. */
async function setup() {
  const log: TutorEvent[] = [];
  let emit: (e: TutorEventInput) => void = () => {};
  let t = 1_000_000;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let ids = 0;
  const extended: string[] = [];
  const watching: boolean[] = [];
  let moment: object | null = null;
  const controller = {
    onEvent: (fn: (e: TutorEventInput) => void) => (emit = fn),
    onChange: () => {},
    view: () => ({ mode: "game" }),
    gameMoment: () => moment,
    setTutorAttached: () => {},
    setTutorWatching: (on: boolean) => watching.push(on),
    extendMoment: (id: string) => extended.push(id),
  } as unknown as GameController;
  const store = {
    lastEventSeq: () => 0,
    appendEvent: (e: TutorEvent) => log.push(e),
    readEvents: (since = -Infinity) => log.filter((e) => e.seq > since),
    findEvent: () => null,
  } as unknown as Store;
  const bridge = new TutorBridge(controller, store, {
    now: () => t,
    detachGraceMs: 200,
    setTimer: (fn, ms) => {
      timers.push({ at: t + ms, fn, id: ++ids });
      return ids;
    },
    clearTimer: (id) => {
      timers = timers.filter((x) => x.id !== id);
    },
    log: () => {},
  });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const since = url.searchParams.get("since");
    bridge.openTutorStream(req, res, since === null ? undefined : Number(since), url.searchParams.get("epoch") ?? undefined, url.searchParams.get("rejoin") === "1");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** A tutor stream: the events it got, and the chunks they came in (as seq lists). */
  const open = async (query = "") => {
    const abort = new AbortController();
    const res = await fetch(`${base}/events${query}`, { signal: abort.signal });
    const chunks: number[][] = [];
    const parser = new SseParser();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          const seqs = parser
            .push(decoder.decode(value, { stream: true }))
            .filter((m) => m.event !== "hello" && m.data)
            .map((m) => (JSON.parse(m.data) as TutorEvent).seq);
          if (seqs.length) chunks.push(seqs);
        }
      } catch {
        // aborted
      }
    })();
    await settle();
    return { chunks, seqs: () => chunks.flat(), cursor: () => parser.lastEventId, close: async () => (abort.abort(), await settle()) };
  };
  const advance = (ms: number) => {
    t += ms;
    for (const due of timers.filter((x) => x.at <= t)) {
      timers = timers.filter((x) => x !== due);
      due.fn();
    }
  };
  const close = async () => {
    bridge.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  return { emit: (e: object) => emit(e as TutorEventInput), open, advance, close, now: () => t, extended, watching, log, setMoment: (m: object | null) => (moment = m) };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const user = { type: "user_message", text: "hi", gameId: "g1" };
const summary = { moves: 40, mistakes: [], totalPointLoss: 0, rating: { before: 10, after: 10, rated: true, pending: true, nextBotRank: "20k", nextHandicap: 0 } };
const gameEnd = { type: "game_end", gameId: "g1", result: { winner: "B", margin: 5, reason: "score" }, summary };
const rating = { type: "rating", gameId: "g1", rating: { before: 10, after: 12, rated: true, nextBotRank: "18k", nextHandicap: 0 } };

describe("TutorBridge", () => {
  let env: Awaited<ReturnType<typeof setup>> | null = null;
  afterEach(async () => {
    await env?.close();
    env = null;
  });

  it("sends a GAME_END waiting for its rank estimate together with its RATING", async () => {
    env = await setup();
    const tutor = await env.open();
    env.emit(user);
    env.emit(gameEnd);
    await settle();
    expect(tutor.chunks).toEqual([[1]]);
    env.emit(rating);
    await settle();
    expect(tutor.chunks).toEqual([[1], [2, 3]]);
  });

  it("lets a held GAME_END go alone when the rating is late, or first when something else comes", async () => {
    env = await setup();
    const tutor = await env.open();
    env.emit(gameEnd);
    env.advance(15_000);
    await settle();
    env.emit(rating);
    await settle();
    expect(tutor.chunks).toEqual([[1], [2]]);

    env.emit(gameEnd);
    env.emit(user);
    await settle();
    expect(tutor.seqs()).toEqual([1, 2, 3, 4]);
  });

  it("gives a stream opened during the hold a cursor before the GAME_END, which it then gets", async () => {
    env = await setup();
    env.emit(user);
    env.emit(gameEnd);
    const late = await env.open();
    expect(late.cursor()).toBe("1");
    env.emit(rating);
    await settle();
    expect(late.seqs()).toEqual([2, 3]);
  });

  it("replays to a fresh stream soon after the last one closed what that one missed, a held GAME_END included", async () => {
    env = await setup();
    const first = await env.open("?rejoin=1");
    env.emit(user);
    env.emit(gameEnd);
    await settle();
    await first.close();
    env.emit(user);
    env.advance(5_000);
    // Another reader of the stream (watch --json) neither gets nor takes the tutor's backlog.
    const reader = await env.open();
    expect(reader.seqs()).toEqual([]);
    await reader.close();
    const second = await env.open("?rejoin=1");
    expect(second.seqs()).toEqual([2, 3]);
    env.emit(rating);
    await settle();
    expect(second.seqs()).toEqual([2, 3, 4]);

    // Long after the last stream closed, a fresh one starts afresh.
    await second.close();
    env.emit(user);
    env.advance(11 * 60_000);
    const third = await env.open("?rejoin=1");
    expect(third.seqs()).toEqual([]);
  });

  it("tells the controller when the tutor's watch is attached, and gives a moment waiting at attach the longer wait", async () => {
    env = await setup();
    const reader = await env.open();
    expect(env.watching).toEqual([]);
    await reader.close();
    env.setMoment({ id: "m1", state: "waiting" });
    const tutor = await env.open("?rejoin=1");
    expect(env.watching).toEqual([true]);
    expect(env.extended).toEqual(["m1"]);
    await tutor.close();
    expect(env.watching).toEqual([true, false]);
  });

  it("holds events that need no answer from the tutor's watch until the next one that does, in one write", async () => {
    env = await setup();
    const tutor = await env.open("?rejoin=1");
    const reader = await env.open();
    env.emit({ type: "game_start", gameId: "g1", settings: {} });
    env.emit({ type: "fallback", momentId: "m1" });
    await settle();
    expect(tutor.chunks).toEqual([]);
    expect(reader.seqs()).toEqual([1, 2]);
    env.emit(user);
    await settle();
    expect(tutor.chunks).toEqual([[1, 2, 3]]);
    // Held events don't count as sent: a fresh watch after this one gets them.
    env.emit({ type: "problem_start", problemId: "p1" });
    await settle();
    await tutor.close();
    await reader.close();
    const next = await env.open("?rejoin=1");
    // A replay is written as it is, in one write.
    expect(next.chunks).toEqual([[4]]);
    env.emit({ type: "game_start", gameId: "g2", settings: {} });
    env.emit(user);
    await settle();
    expect(next.chunks).toEqual([[4], [5, 6]]);

    // A problem opening over a moment the tutor may be answering goes out at once.
    env.setMoment({ id: "m1", state: "tutor" });
    env.emit({ type: "problem_start", problemId: "p2" });
    await settle();
    expect(next.chunks).toEqual([[4], [5, 6], [7]]);
  });

  it("keeps events that need no answer with a held GAME_END instead of releasing it", async () => {
    env = await setup();
    const tutor = await env.open("?rejoin=1");
    env.emit(gameEnd);
    env.emit({ type: "game_start", gameId: "g2", settings: {} });
    await settle();
    expect(tutor.chunks).toEqual([]);
    env.emit(rating);
    await settle();
    expect(tutor.chunks).toEqual([[1, 2, 3]]);
  });

  it("doesn't replay what came after the tutor counted as gone (the server's fallbacks answered it)", async () => {
    env = await setup();
    const first = await env.open("?rejoin=1");
    await first.close();
    env.emit(user); // within the detach grace: the tutor still counts as attached
    await new Promise((r) => setTimeout(r, 300)); // the grace runs out
    env.emit(user);
    const second = await env.open("?rejoin=1");
    expect(second.seqs()).toEqual([1]);
  });
});
