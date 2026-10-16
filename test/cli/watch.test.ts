import { describe, expect, it } from "vitest";
import { Client } from "../../src/cli/client.ts";
import { boardSizeFromAscii, watch } from "../../src/cli/watch.ts";

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const ev = (obj: object) => `id: ${(obj as { seq: number }).seq}\ndata: ${JSON.stringify(obj)}\n\n`;

describe("watch", () => {
  it("prints one line per event, reconnects with since and drops replayed events", async () => {
    const urls: string[] = [];
    const controller = new AbortController();
    const start = { seq: 1, ts: 0, type: "game_start", gameId: "g1", settings: { size: 9, komi: 7, humanColor: "B", botRank: "20k", handicap: 0 } };
    const move = { seq: 2, ts: 0, type: "move", gameId: "g1", by: "bot", record: { number: 1, move: { color: "W", point: { x: 3, y: 3 } }, captures: [] } };
    const fb = { seq: 3, ts: 0, type: "fallback", momentId: "m1" };
    const responses = [
      () => sseResponse([ev(start).slice(0, 10), ev(start).slice(10) + ev(move).slice(0, 5), ev(move).slice(5)]),
      () => {
        throw new TypeError("fetch failed");
      },
      () => sseResponse([ev(move), ev(fb)]), // server replays seq 2
    ];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      const next = responses.shift();
      if (!next) {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }
      return next();
    }) as unknown as typeof fetch;

    const out: string[] = [];
    const err: string[] = [];
    const sleeps: number[] = [];
    await watch({
      client: new Client("http://x", fakeFetch),
      json: false,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      signal: controller.signal,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(out).toEqual(["GAME_START g1 9x9 komi 7 human=B bot=20k", "MOVE 1 W D6 (bot)", "FALLBACK m1 (tutor too slow; KataGo answer shown)"]);
    expect(urls).toEqual([
      "http://x/api/tutor/events",
      "http://x/api/tutor/events?since=2",
      "http://x/api/tutor/events?since=2",
      "http://x/api/tutor/events?since=3",
    ]);
    expect(sleeps).toEqual([500, 1000, 500]);
    expect(err.some((l) => l.includes("cannot reach"))).toBe(true);
  });

  it("follows a restarted server's replay even when it reuses seqs", async () => {
    const urls: string[] = [];
    const controller = new AbortController();
    const hello = (epoch: string, since: number | null) => `event: hello\ndata: ${JSON.stringify({ epoch, since })}\n\n`;
    const fb = (seq: number, id: string) => ({ seq, ts: 0, type: "fallback", momentId: id });
    const responses = [
      () => sseResponse([hello("boot1", null), ev(fb(5, "a")), ev(fb(6, "b")), "id: 6\n\n"]),
      // The server restarted with seq 4 as its last logged event: it replays from 4, and 5 is new.
      () => sseResponse([hello("boot2", 4), ev(fb(5, "c")), "id: 5\n\n"]),
    ];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      const next = responses.shift();
      if (!next) {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }
      return next();
    }) as unknown as typeof fetch;
    const out: string[] = [];
    const err: string[] = [];
    await watch({ client: new Client("http://x", fakeFetch), json: false, out: (l) => out.push(l), err: (l) => err.push(l), signal: controller.signal, sleep: async () => {} });
    expect(out.map((l) => l.split(" ")[1])).toEqual(["a", "b", "c"]);
    expect(urls).toEqual(["http://x/api/tutor/events", "http://x/api/tutor/events?since=6&epoch=boot1", "http://x/api/tutor/events?since=5&epoch=boot2"]);
    expect(err.some((l) => l.includes("server restarted"))).toBe(true);
  });

  it("reconnects from the server's cursor frame even when no event arrived", async () => {
    const urls: string[] = [];
    const controller = new AbortController();
    const responses = [() => sseResponse([": connected\n\n", "id: 41\n\n"])];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      const next = responses.shift();
      if (!next) {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }
      return next();
    }) as unknown as typeof fetch;
    await watch({ client: new Client("http://x", fakeFetch), json: false, out: () => {}, err: () => {}, signal: controller.signal, sleep: async () => {} });
    expect(urls).toEqual(["http://x/api/tutor/events", "http://x/api/tutor/events?since=41"]);
  });

  it("doesn't cache a failed board-size lookup, and doesn't guess 19x19", async () => {
    const controller = new AbortController();
    const move = (seq: number, n: number) => ({ seq, ts: 0, type: "move", gameId: "g9", by: "bot", record: { number: n, move: { color: "W", point: { x: 2, y: 6 } }, captures: [] } });
    let stateCalls = 0;
    const fakeFetch = (async (url: string) => {
      if (url.endsWith("/api/state")) {
        if (++stateCalls === 1) throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ gameId: "g9", settings: { size: 9 } }), { status: 200 });
      }
      if (url.includes("/api/tutor/events") && stateCalls === 0) return sseResponse([ev(move(1, 1)), ev(move(2, 2))]);
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const out: string[] = [];
    await watch({ client: new Client("http://x", fakeFetch), json: false, out: (l) => out.push(l), err: () => {}, signal: controller.signal, sleep: async () => {} });
    expect(out[0]).toMatch(/^MOVE 1 W x2,y6 \(board size unknown/);
    expect(out[1]).toBe("MOVE 2 W C3 (bot)");
  });

  it("reads board size from ASCII", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ` ${9 - i}  . . . . . . . . . ${9 - i}`);
    expect(boardSizeFromAscii(["    A B C D E F G H J", ...rows, "    A B C D E F G H J"].join("\n"))).toBe(9);
    expect(boardSizeFromAscii("")).toBeUndefined();
  });
});
