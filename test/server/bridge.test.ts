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
  const controller = {
    onEvent: (fn: (e: TutorEventInput) => void) => (emit = fn),
    onChange: () => {},
    view: () => ({ mode: "game" }),
    gameMoment: () => null,
    setTutorAttached: () => {},
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
  return { emit: (e: object) => emit(e as TutorEventInput), open, advance, close, now: () => t, setNow: (v: number) => (t = v) };
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
