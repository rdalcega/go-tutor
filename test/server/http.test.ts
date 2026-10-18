import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TutorBridge, parseClientAction, parseTutorCommand, type StreamHello } from "../../src/server/bridge.ts";
import { GameController } from "../../src/server/game.ts";
import { crashLimiter, createApp, isAllowedOrigin } from "../../src/server/index.ts";
import { Store, defaultProfile } from "../../src/server/store.ts";
import type { GameView, ProblemsResponse, ProfileResponse, TutorEvent } from "../../src/shared/types.ts";
import { SseParser } from "../../src/cli/sse.ts";
import { FakeEngine, flush, liveProblem, seedProblems, tempDir, tempStore } from "./fakes.ts";

describe("request validation", () => {
  it("accepts well-formed actions and commands", () => {
    expect(parseClientAction({ type: "play", point: { x: 1, y: 2 } })).toEqual({ type: "play", point: { x: 1, y: 2 } });
    expect(parseClientAction({ type: "new_game", settings: { size: 13, humanColor: "W" } })).toEqual({
      type: "new_game",
      settings: { size: 13, humanColor: "W" },
    });
    expect(parseTutorCommand({ type: "show", moves: ["C3", "pass"], start: "W" })).toEqual({ type: "show", moves: ["C3", "pass"], start: "W" });
    expect(parseClientAction({ type: "leave_problem", extra: 1 })).toEqual({ type: "leave_problem" });
    expect(parseClientAction({ type: "clear_overlay" })).toEqual({ type: "clear_overlay" });
    expect(parseClientAction({ type: "take_back" })).toEqual({ type: "take_back" });
    expect(parseClientAction({ type: "ask_tutor", text: "where?" })).toEqual({ type: "ask_tutor", text: "where?" });
    expect(parseTutorCommand({ type: "tag", gameId: "g", moveNumber: 3, category: "shape", takenBack: true })).toEqual({
      type: "tag",
      gameId: "g",
      moveNumber: 3,
      category: "shape",
      takenBack: true,
    });
    expect(() => parseTutorCommand({ type: "tag", gameId: "g", moveNumber: 3, category: "shape", takenBack: "yes" })).toThrow(/takenBack/);
    expect(parseTutorCommand({ type: "tag", gameId: "g", moveNumber: 3, category: "shape", takenBack: 2 })).toMatchObject({ takenBack: 2 });
    expect(() => parseTutorCommand({ type: "tag", gameId: "g", moveNumber: 3, category: "shape", takenBack: 0 })).toThrow(/takenBack/);
    expect(parseClientAction({ type: "set_tutor_level", level: "point_out" })).toEqual({ type: "set_tutor_level", level: "point_out" });
    expect(parseClientAction({ type: "set_judge_mode", mode: "at_level" })).toEqual({ type: "set_judge_mode", mode: "at_level" });
    expect(parseTutorCommand({ type: "start_problem", problemId: "p3" })).toEqual({ type: "start_problem", problemId: "p3" });
    expect(parseTutorCommand({ type: "generate", extra: 1 })).toEqual({ type: "generate" });
    expect(parseTutorCommand({ type: "tag", gameId: "g", moveNumber: 3, category: "shape" })).toEqual({
      type: "tag",
      gameId: "g",
      moveNumber: 3,
      category: "shape",
    });
  });

  it("rejects malformed bodies with readable errors", () => {
    expect(() => parseClientAction(null)).toThrow(/JSON object/);
    expect(() => parseClientAction({ type: "fly" })).toThrow(/Unknown action/);
    expect(() => parseClientAction({ type: "play", point: { x: "1", y: 2 } })).toThrow(/integers/);
    expect(() => parseClientAction({ type: "set_tutor_level", level: "loud" })).toThrow("Tutor level must be one of silent, point_out, coach.");
    expect(() => parseClientAction({ type: "set_tutor_level" })).toThrow(/"level" is required/);
    expect(() => parseClientAction({ type: "set_judge_mode", mode: "strict" })).toThrow("Judge mode must be one of optimal, at_level.");
    expect(() => parseTutorCommand({ type: "say" })).toThrow(/"text" is required/);
    expect(() => parseTutorCommand({ type: "mark", points: ["C3"], kind: "star" })).toThrow(/Mark kind/);
    expect(() => parseTutorCommand({ type: "tag", gameId: "g", moveNumber: 0, category: "shape" })).toThrow(/moveNumber/);
    expect(() => parseTutorCommand({ type: "tag", gameId: "g", moveNumber: 2, category: "luck" })).toThrow(/Category/);
  });
});

describe("Store", () => {
  it("fills in profile defaults and survives a corrupt file", () => {
    const store = tempStore();
    expect(store.loadProfile()).toEqual(defaultProfile());
    writeFileSync(join(store.dir, "profile.json"), JSON.stringify({ botRank: "15k", mistakeCounts: { shape: 2 } }));
    const p = store.loadProfile();
    expect(p.botRank).toBe("15k");
    expect(p.mistakeThreshold).toBe(4);
    expect(p.mistakeCounts.shape).toBe(2);
    expect(p.mistakeCounts.opening).toBe(0);
    // A profile from before tutor levels coaches, as the app did then; a level it doesn't know too.
    expect(p.tutorLevel).toBe("coach");
    writeFileSync(join(store.dir, "profile.json"), JSON.stringify({ tutorLevel: "silent" }));
    expect(store.loadProfile().tutorLevel).toBe("silent");
    writeFileSync(join(store.dir, "profile.json"), JSON.stringify({ tutorLevel: "shout" }));
    expect(store.loadProfile().tutorLevel).toBe("coach");
    writeFileSync(join(store.dir, "profile.json"), "{not json");
    expect(store.loadProfile()).toEqual(defaultProfile());
  });

  it("keeps practice problems with their progress, and sets a corrupt problems file aside", () => {
    const store = tempStore();
    expect(store.loadProblems()).toEqual([]);
    store.saveProblems([liveProblem({ box: 3 })]);
    expect(store.loadProblems()[0]!.box).toBe(3);
    writeFileSync(join(store.dir, "problems.json"), "{not json");
    expect(store.loadProblems()).toEqual([]);
  });

  it("keeps generation.json, and sets a corrupt one aside", () => {
    const store = tempStore();
    expect(store.loadGeneration()).toEqual({ version: 1, batches: [], progress: null });
    store.saveGeneration({ version: 1, batches: [], progress: { batchId: "batch1", game: { size: 9, weaker: "B", moves: ["E5"] }, reserve: [] } });
    expect(store.loadGeneration().progress?.game?.moves).toEqual(["E5"]);
    writeFileSync(join(store.dir, "generation.json"), "{not json");
    expect(store.loadGeneration()).toEqual({ version: 1, batches: [], progress: null });
  });

  it("creates the data dir on demand and reads events since a seq", () => {
    const store = new Store(join(tempDir(), "nested", "data"));
    expect(store.lastEventSeq()).toBe(0);
    for (let seq = 1; seq <= 3; seq++) store.appendEvent({ seq, ts: seq, type: "fallback", momentId: `m${seq}` });
    expect(store.readEvents(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(store.lastEventSeq()).toBe(3);
    expect(store.lastGame()).toBeNull();
  });
});

describe("KataGo crash limiter", () => {
  it("allows three crashes within ten minutes, and forgets old ones", () => {
    let t = 0;
    const mayRestart = crashLimiter(3, 600_000, () => t);
    expect([mayRestart(), mayRestart(), mayRestart()]).toEqual([true, true, true]);
    expect(mayRestart()).toBe(false);

    const spaced = crashLimiter(3, 600_000, () => t);
    for (let i = 0; i < 10; i++) {
      t += 4 * 60_000; // one crash every four minutes never exceeds three in ten minutes
      expect(spaced()).toBe(true);
    }
  });
});

describe("HTTP server", () => {
  let server: Server | null = null;
  let bridge: TutorBridge | null = null;
  const aborts: AbortController[] = [];

  afterEach(async () => {
    for (const a of aborts.splice(0)) a.abort();
    bridge?.close();
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  /** A data dir with one practice problem, a generated one. */
  function seededStore(): Store {
    const store = tempStore();
    seedProblems(store);
    return store;
  }

  async function start(distDir?: string, store = seededStore(), log?: (msg: string) => void) {
    server?.closeAllConnections();
    server?.close();
    bridge?.close();
    const engine = new FakeEngine();
    const controller = new GameController({ engine, store, botDelayMs: 0 });
    controller.setEngineState("ready");
    bridge = new TutorBridge(controller, store, { detachGraceMs: 20, ringSize: 2, ...(log && { log }) });
    server = createApp({ controller, bridge, store, distDir: distDir ?? join(store.dir, "no-dist") });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as { ok: boolean; view?: GameView; error?: string } };
    };
    return { base, post, controller, store, bridge };
  }

  /** Opens an SSE stream and collects its data frames. */
  async function stream(url: string) {
    const abort = new AbortController();
    aborts.push(abort);
    const res = await fetch(url, { signal: abort.signal });
    const frames: string[] = [];
    const hellos: StreamHello[] = [];
    const parser = new SseParser();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          for (const m of parser.push(decoder.decode(value, { stream: true }))) {
            if (m.event === "hello") hellos.push(JSON.parse(m.data) as StreamHello);
            else frames.push(m.data);
          }
        }
      } catch {
        // aborted
      }
    })();
    return { res, frames, hellos, abort, parser };
  }

  it("serves state, actions and errors as JSON", async () => {
    const { base, post } = await start();
    const state = (await (await fetch(`${base}/api/state`)).json()) as GameView;
    expect(state.mode).toBe("idle");

    const created = await post("/api/action", { type: "new_game" });
    expect(created.status).toBe(200);
    expect(created.body.view?.settings?.size).toBe(9);

    const bad = await post("/api/action", { type: "play", point: { x: 99, y: 0 } });
    expect(bad).toEqual({ status: 400, body: { ok: false, error: "That point is off the board." } });

    const badTutor = await post("/api/tutor", { type: "claim", momentId: "x" });
    expect(badTutor.status).toBe(400);
    expect(badTutor.body.error).toMatch(/no open teaching moment/);

    const notJson = await fetch(`${base}/api/action`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(notJson.status).toBe(400);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    // The game in progress is saved after every change, so "last" finds it until one finishes.
    expect(((await (await fetch(`${base}/api/game/last`)).json()) as { id: string }).id).toBe(created.body.view?.gameId);
    expect((await fetch(`${base}/api/game/nope`)).status).toBe(404);
    const profileRes = await fetch(`${base}/api/profile`);
    expect(profileRes.status).toBe(200);
    const body = (await profileRes.json()) as ProfileResponse;
    expect(body.profile.rating).toBe(10);
    expect(body.focus).toMatchObject({ category: "life_and_death", suggestion: "game" });
    expect((await fetch(`${base}/`)).status).toBe(503); // no dist/
  });

  it("tracks tutorAttached by open tutor streams and replays events since a seq", async () => {
    const { base, post, controller } = await start();
    await post("/api/action", { type: "new_game" });
    await post("/api/action", { type: "play", point: { x: 4, y: 4 } });
    await flush();
    expect(controller.view().tutorAttached).toBe(false);

    const tutor = await stream(`${base}/api/tutor/events?since=0`);
    expect(tutor.res.headers.get("content-type")).toMatch(/text\/event-stream/);
    await flush();
    expect(tutor.hellos).toEqual([{ epoch: bridge!.epoch, since: 0 }]);
    expect(controller.view().tutorAttached).toBe(true);
    // Three events so far (game_start, two moves); the ring holds 2, so this replay comes from the log.
    expect(tutor.frames.map((f) => (JSON.parse(f) as TutorEvent).seq)).toEqual([1, 2, 3]);
    // A fresh stream with nothing to replay still learns the cursor, for its reconnect.
    const fresh = await stream(`${base}/api/tutor/events`);
    await flush();
    expect(fresh.frames).toEqual([]);
    expect(fresh.parser.lastEventId).toBe("3");
    fresh.abort.abort();

    await post("/api/action", { type: "chat", text: "hi tutor" });
    await flush();
    expect(JSON.parse(tutor.frames.at(-1)!)).toMatchObject({ seq: 4, type: "user_message", text: "hi tutor" });

    tutor.abort.abort();
    await new Promise((r) => setTimeout(r, 60));
    expect(controller.view().tutorAttached).toBe(false);
  });

  it("pushes GameViews to browsers", async () => {
    const { base, post } = await start();
    const views = await stream(`${base}/api/events`);
    await flush();
    expect((JSON.parse(views.frames[0]!) as GameView).mode).toBe("idle");
    await post("/api/action", { type: "new_game" });
    await flush();
    expect((JSON.parse(views.frames.at(-1)!) as GameView).mode).toBe("game");
  });

  it("serves the built UI with an SPA fallback and no path traversal", async () => {
    const dist = tempDir();
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Go Tutor</title>");
    writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
    const { base } = await start(dist);
    const page = await fetch(`${base}/some/route`);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toContain("Go Tutor");
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect(await (await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).text()).toContain("Go Tutor");
    expect((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status).toBe(403);
  });

  it("replays from this boot's start for a cursor from another epoch, and reports log failures once", async () => {
    const store = tempStore();
    const logs: string[] = [];
    const first = await start(undefined, store, (m) => logs.push(m));
    await first.post("/api/action", { type: "new_game" }); // seq 1, logged
    const append = store.appendEvent.bind(store);
    store.appendEvent = () => {
      throw new Error("ENOSPC");
    };
    await first.post("/api/action", { type: "chat", text: "lost 1" }); // seq 2, not logged
    await first.post("/api/action", { type: "chat", text: "lost 2" }); // seq 3, not logged
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/Couldn't append event 2 .*ENOSPC/);
    const oldEpoch = first.bridge.epoch;

    // Restart: the new boot starts from the logged seq 1 and hands out 2 and 3 again.
    store.appendEvent = append;
    const second = await start(undefined, store);
    expect(second.bridge.epoch).not.toBe(oldEpoch);
    await second.post("/api/action", { type: "chat", text: "new 1" });
    await second.post("/api/action", { type: "chat", text: "new 2" });
    const tutor = await stream(`${second.base}/api/tutor/events?since=3&epoch=${oldEpoch}`);
    await flush();
    expect(tutor.hellos).toEqual([{ epoch: second.bridge.epoch, since: 1 }]);
    const replay = tutor.frames.map((f) => JSON.parse(f) as TutorEvent);
    expect(replay.map((e) => [e.seq, e.type === "user_message" && e.text])).toEqual([
      [2, "new 1"],
      [3, "new 2"],
    ]);
    // The same cursor from the current epoch is taken as is.
    const same = await stream(`${second.base}/api/tutor/events?since=2&epoch=${second.bridge.epoch}`);
    await flush();
    expect(same.hellos[0]!.since).toBe(2);
    expect(same.frames.map((f) => (JSON.parse(f) as TutorEvent).seq)).toEqual([3]);
  });

  it("replays a teaching moment with its current state", async () => {
    const { base, post, controller } = await start();
    await post("/api/action", { type: "new_game" });
    const engine = (controller as unknown as { engine: FakeEngine }).engine;
    engine.lossAfter(["C7"], 8);
    await post("/api/action", { type: "play", point: { x: 2, y: 2 } });
    await flush();
    expect(controller.view().moment?.state).toBe("fallback"); // no tutor was attached
    const tutor = await stream(`${base}/api/tutor/events?since=0`);
    await flush();
    const moment = tutor.frames.map((f) => JSON.parse(f) as TutorEvent).find((e) => e.type === "teaching_moment");
    expect(moment).toMatchObject({ moment: { state: "fallback" } });
    expect(moment?.type === "teaching_moment" && moment.moment.deadline).toBeUndefined();
  });

  it("gives a fresh stream after a restart the restored moment, from the log", async () => {
    const first = await start();
    await first.post("/api/action", { type: "new_game" });
    (first.controller as unknown as { engine: FakeEngine }).engine.lossAfter(["C7"], 8);
    await first.post("/api/action", { type: "play", point: { x: 2, y: 2 } });
    await flush();
    const id = first.controller.view().moment!.id;
    first.controller.flush();
    // The server restarts on the same data: the moment comes back as it was, and isn't published again.
    const second = await start(undefined, first.store);
    expect(second.controller.restoreLastGame()).toBe(true);
    expect(second.controller.view().moment).toMatchObject({ id, state: "fallback" });
    const fresh = await stream(`${second.base}/api/tutor/events`);
    await flush();
    const events = fresh.frames.map((f) => JSON.parse(f) as TutorEvent);
    expect(events.map((e) => e.type)).toEqual(["teaching_moment"]);
    expect(events[0]).toMatchObject({ moment: { id, state: "fallback" } });
    expect(first.store.readEvents().filter((e) => e.type === "teaching_moment")).toHaveLength(1);
  });

  it("replays a teaching moment waiting under a practice problem as still open", async () => {
    const { base, post, controller } = await start();
    const first = await stream(`${base}/api/tutor/events`);
    await flush();
    await post("/api/action", { type: "new_game" });
    const engine = (controller as unknown as { engine: FakeEngine }).engine;
    engine.lossAfter(["C7"], 8);
    await post("/api/action", { type: "play", point: { x: 2, y: 2 } });
    await flush();
    expect(controller.view().moment?.state).toBe("waiting"); // the tutor is attached
    await post("/api/action", { type: "next_problem" });
    expect(controller.view().moment).toBeNull(); // the problem's view shows no moment

    const late = await stream(`${base}/api/tutor/events`);
    await flush();
    const events = late.frames.map((f) => JSON.parse(f) as TutorEvent);
    expect(events.map((e) => e.type)).toEqual(["teaching_moment", "problem_start"]);
    expect(events[0]).toMatchObject({ moment: { state: "waiting" } });
    const replay = (await stream(`${base}/api/tutor/events?since=0`)).frames;
    await flush();
    const moment = replay.map((f) => JSON.parse(f) as TutorEvent).find((e) => e.type === "teaching_moment");
    expect(moment).toMatchObject({ moment: { state: "waiting" } });
    first.abort.abort();
  });

  it("lists practice problems and plays one through the API", async () => {
    const { base, post, controller } = await start();
    const res = await fetch(`${base}/api/problems`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProblemsResponse;
    expect(body.counts).toMatchObject({ total: 1, due: 1, fromGames: 0, generated: 1 });
    expect(body.counts.byBox[0]).toBe(1);
    expect(body.focus.category).toBe("life_and_death");
    // Due first, the focus category first among them.
    expect(body.problems[0]).toMatchObject({ kind: "generated", size: 9, category: "life_and_death", box: 1, isDue: true, generated: { batchId: "batch1", difficultyRank: "17k" } });
    // No batch has started (the server starts generation, this test doesn't).
    expect(body.generation).toMatchObject({ state: "idle", current: null, last: null, batches: 0 });
    expect(await (await fetch(`${base}/api/generation`)).json()).toEqual(body.generation);
    // A cross-site page can't read it.
    expect((await fetch(`${base}/api/problems`, { headers: { origin: "https://evil.example" } })).status).toBe(403);

    const started = await post("/api/action", { type: "next_problem" });
    expect(started.status).toBe(200);
    expect(started.body.view).toMatchObject({ mode: "problem", problem: { id: body.problems[0]!.id } });
    // A tutor that attaches now still hears which problem is on the board.
    const tutor = await stream(`${base}/api/tutor/events`);
    await flush();
    expect(tutor.frames.map((f) => JSON.parse(f) as TutorEvent)).toEqual([expect.objectContaining({ type: "problem_start", problemId: body.problems[0]!.id })]);
    const left = await post("/api/action", { type: "leave_problem" });
    expect(left.body.view?.mode).toBe("idle");
    expect(controller.view().problem).toBeNull();
  });

  it("rejects cross-site requests and POSTs that aren't JSON", async () => {
    const { base, controller } = await start();
    const port = new URL(base).port;
    const postFrom = (origin: string | null, contentType = "application/json") =>
      fetch(`${base}/api/action`, {
        method: "POST",
        headers: { "content-type": contentType, ...(origin && { origin }) },
        body: JSON.stringify({ type: "new_game" }),
      });

    const evil = await postFrom("https://evil.example");
    expect(evil.status).toBe(403);
    expect(((await evil.json()) as { error: string }).error).toMatch(/not allowed/);
    expect((await postFrom("http://localhost:4747.evil.example")).status).toBe(403);
    expect((await postFrom("null")).status).toBe(403);
    // A form post or a no-cors fetch can only send "simple" content types.
    const form = await postFrom(null, "text/plain");
    expect(form.status).toBe(415);
    expect((await postFrom(null, "application/x-www-form-urlencoded")).status).toBe(415);
    expect(controller.view().mode).toBe("idle");

    // An EventSource from another site can't attach as the tutor either.
    expect((await fetch(`${base}/api/tutor/events`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect(controller.view().tutorAttached).toBe(false);

    expect((await postFrom(`http://127.0.0.1:${port}`)).status).toBe(200);
    expect((await postFrom(`http://localhost:${port}`, "application/json; charset=utf-8")).status).toBe(200);
    expect((await postFrom("http://localhost:5173")).status).toBe(200); // Vite dev server
    expect((await postFrom(null)).status).toBe(200); // the tutor CLI sends no Origin
  });

  it("allows only its own origin and the Vite dev server", () => {
    expect(isAllowedOrigin(undefined, 4747)).toBe(true);
    expect(isAllowedOrigin("http://localhost:4747", 4747)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5173", 4747)).toBe(true);
    expect(isAllowedOrigin("http://localhost:4748", 4747)).toBe(false);
    expect(isAllowedOrigin("https://localhost:4747", 4747)).toBe(false);
    expect(isAllowedOrigin("http://evil.example:4747", 4747)).toBe(false);
  });
});
