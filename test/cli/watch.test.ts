import { describe, expect, it } from "vitest";
import { Client } from "../../src/cli/client.ts";
import { toAscii } from "../../src/engine/ascii.ts";
import type { Board } from "../../src/shared/types.ts";
import { watch } from "../../src/cli/watch.ts";

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
  it("with all, prints one line per event, reconnects with since and drops replayed events", async () => {
    const urls: string[] = [];
    const controller = new AbortController();
    const start = { seq: 1, ts: 0, type: "game_start", gameId: "g1", settings: { size: 9, komi: 7, humanColor: "B", botRank: "20k", handicap: 0 } };
    const move = { seq: 2, ts: 0, type: "move", gameId: "g1", size: 9, by: "bot", record: { number: 1, move: { color: "W", point: { x: 3, y: 3 } }, captures: [] } };
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
      all: true,
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

  it("names old events' points with the size from the game's game_start, and never throws", async () => {
    const controller = new AbortController();
    const start = { seq: 1, ts: 0, type: "game_start", gameId: "g1", settings: { size: 9, komi: 7, humanColor: "B", botRank: "20k", handicap: 0 } };
    // Logged before events carried `size`.
    const move = { seq: 2, ts: 0, type: "move", gameId: "g1", by: "bot", record: { number: 1, move: { color: "W", point: { x: 3, y: 3 } }, captures: [] } };
    const other = { seq: 3, ts: 0, type: "move", gameId: "g0", by: "bot", record: { number: 12, move: { color: "W", point: { x: 3, y: 3 } }, captures: [] } };
    const responses = [() => sseResponse([ev(start), ev(move), ev(other)])];
    const fakeFetch = (async () => {
      const next = responses.shift();
      if (!next) {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }
      return next();
    }) as unknown as typeof fetch;
    const out: string[] = [];
    await watch({ client: new Client("http://x", fakeFetch), all: true, json: false, out: (l) => out.push(l), err: () => {}, signal: controller.signal, sleep: async () => {} });
    expect(out).toEqual(["GAME_START g1 9x9 komi 7 human=B bot=20k", "MOVE 1 W D6 (bot)", "MOVE 12 W (coords unavailable) (bot)"]);
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
    expect(urls).toEqual(["http://x/api/tutor/events?rejoin=1", "http://x/api/tutor/events?since=6&epoch=boot1&rejoin=1", "http://x/api/tutor/events?since=5&epoch=boot2&rejoin=1"]);
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
    expect(urls).toEqual(["http://x/api/tutor/events?rejoin=1", "http://x/api/tutor/events?since=41&rejoin=1"]);
  });

  describe("what the tutor acts on", () => {
    const settings = { size: 9, komi: 7, humanColor: "B", botRank: "20k", handicap: 0 };
    const start = { seq: 1, ts: 0, type: "game_start", gameId: "g1", settings, tutorLevel: "coach" };
    const move = (seq: number, by: "human" | "bot") => ({ seq, ts: 0, type: "move", gameId: "g1", size: 9, by, record: { number: seq, move: { color: by === "human" ? "B" : "W", point: { x: 3, y: 3 } }, captures: [] } });
    const user = (seq: number) => ({ seq, ts: 0, type: "user_message", text: "why?", gameId: "g1", tutorLevel: "silent" });
    const moment = { seq: 4, ts: 0, type: "teaching_moment", gameId: "g1", size: 9, tutorLevel: "coach", moment: { id: "m1", moveNumber: 3, pointLoss: 6, state: "waiting" }, record: { number: 3, move: { color: "B", point: { x: 2, y: 2 } }, captures: [] } };
    const undo = (seq: number, during?: string, by = "human") => ({ seq, ts: 0, type: "undo", gameId: "g1", moves: 2, toPlay: "B", by, ...(during && { during }) });
    const summary = (pending: boolean) => ({ moves: 40, mistakes: [], totalPointLoss: 3, rating: { before: 10, after: 10, rated: true, pending, nextBotRank: "20k", nextHandicap: 0 } });
    const gameEnd = (seq: number, pending = true) => ({ seq, ts: 0, type: "game_end", gameId: "g1", result: { winner: "B", margin: 5, reason: "score" }, summary: summary(pending) });
    const rating = (seq: number) => ({ seq, ts: 0, type: "rating", gameId: "g1", rating: { before: 10, after: 12, rated: true, nextBotRank: "18k", nextHandicap: 0 } });
    const emptyBoard = () => Array.from({ length: 9 }, () => Array(9).fill(null));
    const view = {
      gameId: "g1", mode: "game", settings, status: "paused", board: emptyBoard(), toPlay: "B", moves: [],
      captures: { B: 0, W: 0 }, result: null, moment: { id: "m1", moveNumber: 3, pointLoss: 6, state: "waiting" }, overlay: null, chat: [], tutorAttached: true, tutorLevel: "coach", judgeMode: "optimal",
      engineBusy: false, profileVersion: 0, allowed: [], mistakeThreshold: 4,
    };
    const game = { id: "g1", settings, createdAt: 0, updatedAt: 0, moves: [], result: { winner: "B", margin: 5, reason: "score" }, summary: summary(false) };

    /** Streams `events` once, each in its own chunk (an array is one chunk), answers the state and review queries, then stops. */
    async function run(events: (object | object[])[], opts: { all?: boolean; json?: boolean; failState?: boolean; view?: object; now?: number } = {}) {
      const controller = new AbortController();
      const paths: string[] = [];
      let streamed = false;
      const fakeFetch = (async (url: string) => {
        const path = url.slice("http://x".length);
        paths.push(path);
        if (path.startsWith("/api/tutor/events")) {
          if (streamed) {
            controller.abort();
            throw new DOMException("aborted", "AbortError");
          }
          streamed = true;
          return sseResponse(events.map((e) => (Array.isArray(e) ? e.map(ev).join("") : ev(e))));
        }
        if (path === "/api/state") return opts.failState ? new Response("boom", { status: 500 }) : Response.json(opts.view ?? view);
        if (path === "/api/game/g1") return Response.json(game);
        return new Response("", { status: 404 });
      }) as unknown as typeof fetch;
      const out: string[] = [];
      const err: string[] = [];
      await watch({ client: new Client("http://x", fakeFetch), all: opts.all, json: opts.json ?? false, out: (l) => out.push(l), err: (l) => err.push(l), signal: controller.signal, sleep: async () => {}, now: () => opts.now ?? 0 });
      return { out, err, paths };
    }

    it("leaves out moves, level and judge changes, batch starts and take-backs nobody is answering about", async () => {
      const level = { seq: 2, ts: 0, type: "tutor_level", level: "silent", gameId: "g1" };
      const judge = { seq: 3, ts: 0, type: "judge_mode", mode: "at_level", gameId: "g1", atLevelRank: "19k" };
      const batch = (seq: number, status: string) => ({ seq, ts: 0, type: "generation", status, batch: { id: "batch2", trigger: "mastery", target: 20, weakerRank: "17k", strongerRank: "12k", band: "17k–13k", found: 20, sizes: [] } });
      const early = { ...move(12, "human"), hintPending: true };
      const { out } = await run([start, level, judge, move(4, "human"), move(5, "bot"), undo(6), batch(7, "started"), batch(8, "finished"), user(9), undo(10, "moment"), undo(11, "moment", "tutor"), early]);
      expect(out.map((l) => l.split(" ")[0])).toEqual(["GAME_START", "BATCH", "USER", "UNDO", "MOVE"]);
      expect(out[4]).toMatch(/^MOVE 12 B D6 \(human\) — played before your hint answer/);
      expect(out[1]).toContain("finished");
      // The USER line carries the learner's level.
      expect(out[2]).toBe('USER "why?" game=g1 level=silent');
    });

    it("prints the state under a waiting moment in the same write", async () => {
      const { out, paths } = await run([start, moment]);
      expect(out).toHaveLength(2);
      const [head, ...rest] = out[1]!.split("\n");
      expect(head).toMatch(/^MOMENT m1 game=g1 move 3 B C7 lost 6 pts.* — state below$/);
      expect(rest[0]).toMatch(/^game g1 mode=game status=paused/);
      expect(paths).toContain("/api/state");
    });

    it("attaches nothing to a moment that is no longer waiting", async () => {
      const replayed = { ...moment, moment: { ...moment.moment, state: "fallback" } };
      const { out, paths } = await run([start, replayed]);
      expect(out[1]).toMatch(/\(replayed; now fallback\)$/);
      expect(paths).not.toContain("/api/state");
    });

    it("says to run state when the state can't be fetched", async () => {
      const hint = { seq: 2, ts: 0, type: "hint_request", gameId: "g1", size: 9, board: "", toPlay: "B" };
      const { out, err } = await run([start, hint], { failState: true });
      expect(out[1]).toBe('HINT game=g1 B to play — user asks: "hint please" — run: state, then say/show/mark');
      expect(err.some((l) => l.includes("couldn't fetch the state"))).toBe(true);
    });

    it("doesn't attach a board the event isn't about, and says to run state", async () => {
      // A replayed moment that is no longer the game's.
      const moved = await run([start, moment], { view: { ...view, moment: { ...view.moment, id: "m2" } } });
      expect(moved.out[1]).toMatch(/^MOMENT m1 .* — run state for the board$/);
      expect(moved.err.some((l) => l.includes("moved on"))).toBe(true);
      // A hint asked on another position than the one on the board now.
      const board = toAscii(emptyBoard() as Board);
      const hint = (b: string) => ({ seq: 2, ts: 0, type: "hint_request", gameId: "g1", size: 9, board: b, toPlay: "B" });
      expect((await run([start, hint(board)])).out[1]).toMatch(/state below; answer with say\/show\/mark\ngame g1 /);
      expect((await run([start, hint(board.replace("+", "X"))])).out[1]).toMatch(/run: state, then say\/show\/mark$/);
    });

    it("prints what arrives together in one write: a GAME_END, its RATING, then the review", async () => {
      const { out } = await run([start, move(2, "human"), [gameEnd(3), rating(4)]]);
      expect(out).toHaveLength(2);
      const lines = out[1]!.split("\n");
      expect(lines[0]).toMatch(/^GAME_END g1 B\+5 .* — review below$/);
      expect(lines[1]).toMatch(/^RATING g1 /);
      expect(lines[2]).toMatch(/^game g1 9x9 /);
    });

    it("attaches nothing to events from a replay older than 10 minutes", async () => {
      const { out, paths } = await run([start, moment, gameEnd(5)], { now: 11 * 60_000 });
      expect(out[1]).toMatch(/fallback in \d+s$|claim m1, then say\/show\/rethink\/resume$/);
      expect(out[2]).toMatch(/run: review g1$/);
      expect(paths.filter((p) => !p.startsWith("/api/tutor/events"))).toEqual([]);
    });

    it("gives a moment waiting under a practice problem the game's board from the event", async () => {
      const under = { ...moment, boardAfter: "ASCII-AFTER" };
      const { out } = await run([start, under], { view: { ...view, mode: "problem", moment: null, problem: { id: "p4" } } });
      expect(out[1]).toMatch(/ — state below\npractice problem p4 on the board; the moment waits under it\. Board after move 3:\nASCII-AFTER$/);
    });

    it("with all or json, prints every event bare", async () => {
      const all = await run([start, move(2, "human"), moment, undo(5), gameEnd(6), rating(7)], { all: true });
      expect(all.out.map((l) => l.split(" ")[0])).toEqual(["GAME_START", "MOVE", "MOMENT", "UNDO", "GAME_END", "RATING"]);
      expect(all.out.every((l) => !l.includes("\n"))).toBe(true);
      expect(all.paths.filter((p) => !p.startsWith("/api/tutor/events"))).toEqual([]);

      const json = await run([start, move(2, "human"), moment], { json: true });
      expect(json.out.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(["game_start", "move", "teaching_moment"]);
    });
  });
});
