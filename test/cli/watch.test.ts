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
    const fb = (seq: number, id: string) => ({ seq, ts: 0, type: "user_message", text: id, gameId: null });
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
    expect(out.map((l) => l.split(" ")[1])).toEqual(['"a"', '"b"', '"c"']);
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
      expect(out[1]).toContain("finished");
      expect(out[4]).toMatch(/^MOVE 12 B D6 \(human\) — played before your hint answer/);
      // The USER line carries the learner's level, and the board of the game in play.
      expect(out[2]).toMatch(/^USER "why\?" game=g1 level=silent — state below\ngame g1 mode=game /);
    });

    it("attaches the board to a question only while its game is in play", async () => {
      const ended = await run([user(2)], { view: { ...view, status: "over", moment: null, result: { winner: "B", margin: 5, reason: "score" } } });
      expect(ended.out).toEqual(['USER "why?" game=g1 level=silent']);
      const problemView = { ...view, mode: "problem", moment: null, problem: { id: "p4" } };
      const underProblem = await run([user(2)], { view: problemView });
      expect(underProblem.out).toEqual(['USER "why?" game=g1 level=silent']);
      // A question about the problem doesn't fetch the state at all.
      const aboutProblem = await run([{ ...user(2), problemId: "p4" }], { view: problemView });
      expect(aboutProblem.out).toEqual(['USER "why?" (problem p4)']);
      expect(aboutProblem.paths).not.toContain("/api/state");
      expect([...ended.err, ...underProblem.err].filter((l) => /moved on|couldn.t fetch/.test(l))).toEqual([]);
      // A state that can't be fetched: the tutor is told to run it.
      expect((await run([user(2)], { failState: true })).out).toEqual(['USER "why?" game=g1 level=silent — run state for the board']);
      // A moment and a question that arrive together share one state.
      const together = (await run([[moment, user(5)]])).out[0]!;
      expect(together.split("\n").slice(0, 2).map((l) => l.split(" ")[0])).toEqual(["MOMENT", "USER"]);
      expect(together.match(/^game g1 mode=game /gm)).toHaveLength(1);
      // After the stream saw the game end, a question is about the review: no fetch, no "run state".
      const gameEnd2 = { seq: 2, ts: 0, type: "game_end", gameId: "g1", result: { winner: "B", margin: 5, reason: "score" }, summary: { moves: 40, mistakes: [], totalPointLoss: 3 } };
      const review = await run([gameEnd2, user(3)], { failState: true });
      expect(review.out[1]).toBe('USER "why?" game=g1 level=silent');
      // A chat line with no game fetches nothing.
      const noGame = await run([{ ...user(2), gameId: null }]);
      expect(noGame.paths).not.toContain("/api/state");
    });

    it("says the board hasn't changed instead of reprinting it for a follow-up question", async () => {
      const { out } = await run([user(2), user(3)]);
      expect(out[0]).toMatch(/— state below\ngame g1 mode=game /);
      expect(out[1]).toBe('USER "why?" game=g1 level=silent — state below\n(the board hasn\'t changed since the last state above)');
    });

    it("prints what the server sent together in one write, dropping a problem start whose problem has gone", async () => {
      const problemStart = (seq: number, id: string) => ({ seq, ts: 0, type: "problem_start", problemId: id, kind: "game", category: "shape", toPlay: "B", prompt: "Black to play.", answers: ["D5"], box: 1, size: 9, board: "" });
      const attempt = (seq: number, id: string) => ({ seq, ts: 0, type: "problem_attempt", problemId: id, move: "C3", correct: false, category: "shape", attempt: 1, firstTry: false, pointLoss: 5, revealed: false, bestMove: "D5", bestPv: ["D5"] });
      const fallback = { seq: 9, ts: 0, type: "fallback", momentId: "m1" };
      const problemView = { ...view, mode: "problem", moment: null, problem: { id: "p4", prompt: "Black to play.", attempts: 1, solved: false, kind: "game", category: "shape", toPlay: "B", maxAttempts: 2, revealed: false, box: 1 } };
      // The server holds lines that need no answer and sends them with the next event that does.
      const { out } = await run([[start, problemStart(2, "p3"), problemStart(3, "p4"), attempt(4, "p4")], [fallback, user(10)]], { view: problemView });
      expect(out).toHaveLength(2);
      const lines = out[0]!.split("\n");
      // p3 left the board before anything needed an answer; p4's start comes with its attempt and the problem's state.
      expect(lines.slice(0, 3).map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual(["GAME_START g1", "PROBLEM_START p4", "PROBLEM p4"]);
      expect(lines[1]).toMatch(/ — state below; /);
      expect(lines[3]).toMatch(/^game g1 mode=problem /);
      expect(out[1]!.split("\n").map((l) => l.split(" ")[0])).toEqual(["FALLBACK", "USER"]);

      // A state that can't be fetched doesn't drop the problem start: the tutor is told to run state.
      const failed = await run([[problemStart(3, "p4"), attempt(4, "p4")]], { failState: true });
      expect(failed.out[0]!.split("\n").map((l) => l.split(" ")[0])).toEqual(["PROBLEM_START", "PROBLEM"]);
      expect(failed.out[0]).toMatch(/run: state; let them try/);
    });

    it("prints the brief state under a waiting moment in the same write", async () => {
      const moves = Array.from({ length: 20 }, (_, i) => ({ number: i + 1, move: { color: i % 2 ? "W" : "B", point: { x: i % 9, y: Math.floor(i / 9) } }, captures: [], ...(i === 2 && { eval: { pointLoss: 7, leadBefore: 0, leadAfter: -7, winrateBefore: 0.5, winrateAfter: 0.3, bestMove: "E5", bestPv: [], candidates: [] } }) }));
      const { out, paths } = await run([moment], { view: { ...view, moves, chat: [{ id: "c1", ts: 0, from: "user", text: "hello" }] } });
      expect(out).toHaveLength(1);
      const [head, ...rest] = out[0]!.split("\n");
      expect(head).toMatch(/^MOMENT m1 game=g1 move 3 B C7 lost 6 pts .*answer in one call: claim m1 && show\/say\/rethink \(&& resume\) — state below$/);
      expect(rest[0]).toMatch(/^game g1 mode=game status=paused/);
      const state = rest.join("\n");
      expect(state).toContain("moves (last 12;");
      expect(state).toContain("earlier mistakes: 3 C9 -7");
      expect(state).not.toMatch(/chat|overlay: none|tutor=attached|mistake threshold/);
      expect(paths).toContain("/api/state");
    });

    it("attaches nothing to a moment that is no longer waiting", async () => {
      const replayed = { ...moment, moment: { ...moment.moment, state: "tutor" } };
      const { out, paths } = await run([replayed]);
      expect(out[0]).toMatch(/\(replayed; now tutor\)$/);
      expect(paths).not.toContain("/api/state");
    });

    it("says to run state when the state can't be fetched", async () => {
      const hint = { seq: 2, ts: 0, type: "hint_request", gameId: "g1", size: 9, board: "", toPlay: "B", tutorLevel: "coach" };
      const { out, err } = await run([hint], { failState: true });
      expect(out[0]).toBe('HINT game=g1 B to play level=coach — user asks: "hint please" — run: state, then say/show/mark');
      expect(err.some((l) => l.includes("couldn't fetch the state"))).toBe(true);
    });

    it("doesn't attach a board the event isn't about, and says to run state", async () => {
      // A replayed moment that is no longer the game's.
      const moved = await run([moment], { view: { ...view, moment: { ...view.moment, id: "m2" } } });
      expect(moved.out[0]).toMatch(/^MOMENT m1 .* — run state for the board$/);
      expect(moved.err.some((l) => l.includes("moved on"))).toBe(true);
      // A hint asked on another position than the one on the board now.
      const board = toAscii(emptyBoard() as Board);
      const hint = (b: string) => ({ seq: 2, ts: 0, type: "hint_request", gameId: "g1", size: 9, board: b, toPlay: "B" });
      expect((await run([hint(board)])).out[0]).toMatch(/state below; answer with say\/show\/mark\ngame g1 /);
      expect((await run([hint(board.replace("+", "X"))])).out[0]).toMatch(/run: state, then say\/show\/mark$/);
    });

    it("prints what arrives together in one write: a GAME_END, its RATING, then the brief review", async () => {
      const { out } = await run([move(2, "human"), [gameEnd(3), rating(4)]]);
      expect(out).toHaveLength(1);
      const lines = out[0]!.split("\n");
      expect(lines[0]).toMatch(/^GAME_END g1 B\+5 .* — review below$/);
      expect(lines[1]).toMatch(/^RATING g1 /);
      expect(lines[2]).toMatch(/^game g1 9x9 /);
      expect(lines.at(-1)).toBe("(the full move list: review g1)");
    });

    it("attaches nothing to events from a replay older than 10 minutes", async () => {
      const { out, paths } = await run([moment, gameEnd(5)], { now: 11 * 60_000 });
      expect(out[0]).toMatch(/claim m1 && show\/say\/rethink \(&& resume\)$/);
      expect(out[1]).toMatch(/run: review g1$/);
      expect(paths.filter((p) => !p.startsWith("/api/tutor/events"))).toEqual([]);
    });

    it("gives a moment waiting under a practice problem the game's board from the event", async () => {
      const under = { ...moment, boardAfter: "ASCII-AFTER" };
      const { out } = await run([under], { view: { ...view, mode: "problem", moment: null, problem: { id: "p4" } } });
      expect(out[0]).toMatch(/ — state below\npractice problem p4 on the board; the moment waits under it \(.*claim m1 keeps the moment for after it\)\. Board after move 3:\nASCII-AFTER$/);
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
