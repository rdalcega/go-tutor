import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GameController, UserError, passIsFine, type TutorEventInput } from "../../src/server/game.ts";
import type { Store } from "../../src/server/store.ts";
import { FakeClock, FakeEngine, flush, tempStore } from "./fakes.ts";

// 9x9 points used below.
const C3 = { x: 2, y: 6 };
const E5 = { x: 4, y: 4 };
const D4 = { x: 3, y: 5 };

let engine: FakeEngine;
let clock: FakeClock;
let store: Store;
let events: TutorEventInput[];
let ctl: GameController;

function setup(opts: { tutor?: boolean } = {}): void {
  engine = new FakeEngine();
  clock = new FakeClock();
  store = tempStore();
  events = [];
  ctl = new GameController({ engine, store, clock, botDelayMs: 0, tutorTimeoutMs: 30_000 });
  ctl.onEvent((e) => events.push(e));
  ctl.setEngineState("ready");
  if (opts.tutor) ctl.setTutorAttached(true);
}

const types = () => events.map((e) => e.type);

async function startGame(): Promise<void> {
  ctl.newGame();
  await flush();
}

describe("GameController", () => {
  beforeEach(() => setup());

  it("plays a normal move, evaluates it and lets the bot reply", async () => {
    await startGame();
    engine.botMoves = ["G7"];
    ctl.play(E5);
    expect(ctl.view().engineBusy).toBe(true);
    await flush();
    const v = ctl.view();
    expect(v.moves).toHaveLength(2);
    expect(v.moves[0]!.eval?.pointLoss).toBe(0);
    expect(v.moves[1]!.move).toEqual({ color: "W", point: { x: 6, y: 2 } });
    expect(v.status).toBe("playing");
    expect(v.engineBusy).toBe(false);
    expect(types()).toEqual(["game_start", "move", "move"]);
  });

  it("rejects illegal and out-of-turn moves with plain messages", async () => {
    await startGame();
    engine.hold = true;
    ctl.play(E5);
    expect(() => ctl.play(D4)).toThrow(/Wait for the bot/);
    engine.releaseAll();
    await flush();
    engine.releaseAll();
    await flush();
    expect(() => ctl.play(E5)).toThrow(UserError);
    expect(() => ctl.play(E5)).toThrow(/already taken/);
  });

  it("without a tutor, a big mistake pauses and shows KataGo's fallback at once", async () => {
    await startGame();
    engine.lossAfter(["C3"], 6.24);
    ctl.play(C3);
    await flush();
    const v = ctl.view();
    expect(v.status).toBe("paused");
    expect(v.moment).toMatchObject({ moveNumber: 1, pointLoss: 6.2, state: "fallback" });
    expect(v.moment?.deadline).toBeUndefined();
    expect(v.moves).toHaveLength(1); // the bot waits
    expect(v.overlay?.variation?.moves.map((m) => m.point)).toEqual([E5, D4, { x: 3, y: 4 }]);
    expect(v.overlay?.variation?.moves[0]!.color).toBe("B");
    expect(v.overlay?.variation?.fromMove).toBe(1);
    expect(v.overlay?.marks).toEqual([{ point: C3, kind: "x" }]);
    expect(v.chat.at(-1)).toMatchObject({ from: "system", momentId: v.moment!.id });
    expect(v.chat.at(-1)!.text).toMatch(/C3 cost about 6\.2 points.*E5/);
    expect(types()).toEqual(["game_start", "move", "teaching_moment", "fallback"]);
    const tm = events[2]!;
    if (tm.type !== "teaching_moment") throw new Error("expected teaching_moment");
    expect(tm.boardAfter).toContain("(X)");
    expect(tm.boardBefore).not.toContain("X");

    expect(() => ctl.play(D4)).toThrow(/paused/);
    await ctl.handleAction({ type: "continue" });
    await flush();
    expect(ctl.view().status).toBe("playing");
    expect(ctl.view().moment?.state).toBe("resolved");
    expect(ctl.view().overlay).toBeNull();
    expect(ctl.view().moves).toHaveLength(2);
  });

  it("draws KataGo's line on the position before the mistake, through the point the human took", async () => {
    engine.pv = ["E5", "C3", "D4", "E5"]; // White's answer is the point Black just played; E5 is then taken
    await startGame();
    engine.lossAfter(["C3"], 6);
    ctl.play(C3);
    await flush();
    const variation = ctl.view().overlay?.variation;
    expect(variation?.fromMove).toBe(1);
    expect(variation?.label).toBe("KataGo's line instead of C3");
    expect(variation?.moves).toEqual([
      { color: "B", point: E5 },
      { color: "W", point: C3 },
      { color: "B", point: D4 },
    ]);
    expect(ctl.view().overlay?.marks).toBeUndefined(); // C3 is already numbered in the line
  });

  it("draws a tutor's show after a rethink on the current position", async () => {
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 8);
    ctl.play(C3);
    await flush();
    await ctl.handleTutor({ type: "rethink", text: "Which group is weak?" });
    await ctl.handleTutor({ type: "show", moves: ["E5"] });
    expect(ctl.view().overlay?.variation).toEqual({ moves: [{ color: "B", point: E5 }] });
  });

  it("with a tutor attached, waits; a claim cancels the fallback timer", async () => {
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 8);
    ctl.play(C3);
    await flush();
    const m = ctl.view().moment!;
    expect(m.state).toBe("waiting");
    expect(m.deadline).toBe(clock.now() + 30_000);
    expect(ctl.view().overlay).toBeNull();

    await expect(ctl.handleTutor({ type: "claim", momentId: "nope" })).rejects.toThrow(/not current/);
    await ctl.handleTutor({ type: "claim", momentId: m.id });
    expect(ctl.view().moment?.state).toBe("tutor");
    expect(ctl.view().moment?.deadline).toBeUndefined();
    clock.advance(60_000);
    expect(ctl.view().moment?.state).toBe("tutor");
    expect(types()).not.toContain("fallback");

    await ctl.handleTutor({ type: "say", text: "What does C3 do for your stones?" });
    await ctl.handleTutor({ type: "show", moves: ["E5", "D4"], label: "better" });
    // The better move replaces C3, so it is drawn on the board from before C3.
    expect(ctl.view().overlay?.variation).toEqual({ label: "better", moves: [{ color: "B", point: E5 }, { color: "W", point: D4 }], fromMove: 1 });
    // A line for the opponent continues from the position after C3.
    await ctl.handleTutor({ type: "show", moves: ["D4"], start: "W" });
    expect(ctl.view().overlay?.variation).toEqual({ moves: [{ color: "W", point: D4 }] });
    await ctl.handleTutor({ type: "resume" });
    await flush();
    expect(ctl.view().status).toBe("playing");
    expect(ctl.view().moves).toHaveLength(2);
  });

  it("falls back when the tutor doesn't answer in time", async () => {
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 5);
    ctl.play(C3);
    await flush();
    clock.advance(29_999);
    expect(ctl.view().moment?.state).toBe("waiting");
    clock.advance(1);
    expect(ctl.view().moment?.state).toBe("fallback");
    expect(ctl.view().overlay?.variation).toBeDefined();
    expect(types()).toEqual(["game_start", "move", "teaching_moment", "fallback"]);
    // The tutor can still take over late.
    await ctl.handleTutor({ type: "say", text: "Let's look at this together." });
    expect(ctl.view().moment?.state).toBe("tutor");
  });

  it("falls back at once when the tutor detaches during the wait", async () => {
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 5);
    ctl.play(C3);
    await flush();
    ctl.setTutorAttached(false);
    expect(ctl.view().moment?.state).toBe("fallback");
    expect(clock.pendingTimers).toBe(0);
  });

  it("rethink undoes the human move and keeps the moment with the tutor until they play", async () => {
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 7);
    ctl.play(C3);
    await flush();
    await ctl.handleTutor({ type: "rethink", text: "Is your corner stone safe? Try again." });
    let v = ctl.view();
    expect(v.moves).toHaveLength(0);
    expect(v.status).toBe("playing");
    expect(v.toPlay).toBe("B");
    expect(v.moment?.state).toBe("tutor");
    expect(v.chat.at(-1)).toMatchObject({ from: "tutor", momentId: v.moment!.id });
    await flush();
    expect(engine.botCalls).toHaveLength(0);

    ctl.play(E5);
    await flush();
    v = ctl.view();
    expect(v.moment?.state).toBe("resolved");
    expect(v.moves).toHaveLength(2);
  });

  it("Try again after the bot replied takes back both moves", async () => {
    await startGame();
    ctl.play(E5);
    await flush();
    expect(ctl.view().moves).toHaveLength(2);
    await ctl.handleAction({ type: "retry" });
    expect(ctl.view().moves).toHaveLength(0);
    await expect(ctl.handleAction({ type: "retry" })).rejects.toThrow(/no move of yours/);
  });

  it("rethink only takes back the open moment's move, once", async () => {
    setup({ tutor: true });
    await startGame();
    ctl.play(E5);
    await flush();
    // No moment: nothing to rethink, and nothing is undone.
    await expect(ctl.handleTutor({ type: "rethink", text: "hmm" })).rejects.toThrow(/no open teaching moment/);
    expect(ctl.view().moves).toHaveLength(2);

    engine.lossAfter(["E5", "A9", "C3"], 8);
    ctl.play(C3);
    await flush();
    const m = ctl.view().moment!;
    await expect(ctl.handleTutor({ type: "rethink", text: "x", momentId: "1-dead" })).rejects.toThrow(/not current/);
    expect(ctl.view().moment?.state).toBe("waiting"); // a stale id doesn't engage either
    await ctl.handleTutor({ type: "rethink", text: "Which stone is weakest?", momentId: m.id });
    expect(ctl.view().moves).toHaveLength(2);
    // A repeated rethink (a retry, or a slow tutor) must not undo earlier moves.
    await expect(ctl.handleTutor({ type: "rethink", text: "once more", momentId: m.id })).rejects.toThrow(/already taken back/);
    await expect(ctl.handleAction({ type: "retry" })).rejects.toThrow(/already taken back/);
    expect(ctl.view().moves).toHaveLength(2);
    expect(ctl.view().moment).toMatchObject({ id: m.id, state: "tutor" });
    expect(events.filter((e) => e.type === "undo")).toEqual([{ type: "undo", gameId: ctl.view().gameId, moves: 2, toPlay: "B", by: "tutor" }]);
  });

  it("refuses moves, hints and passes once the game has ended by resignation", async () => {
    await startGame();
    ctl.play(E5);
    await flush();
    await ctl.handleAction({ type: "resign" });
    expect(() => ctl.play({ x: 0, y: 0 })).toThrow(/game is over/);
    expect(() => ctl.play(null)).toThrow(/game is over/);
    await expect(ctl.handleAction({ type: "ask_tutor" })).rejects.toThrow(/game is over/);
    expect(store.loadGame(ctl.view().gameId!)!.moves).toHaveLength(2);
  });

  it("refuses a hint while the bot is to move (paused at a moment)", async () => {
    await startGame();
    engine.lossAfter(["C3"], 13);
    ctl.play(C3);
    await flush();
    expect(ctl.view().status).toBe("paused");
    await expect(ctl.handleAction({ type: "ask_tutor" })).rejects.toThrow(/Continue or Try again first/);
    expect(types()).not.toContain("hint_request");
  });

  it("Continue while the human move is still being evaluated doesn't start the bot or skip the moment", async () => {
    setup({ tutor: true });
    await startGame();
    engine.hold = true;
    engine.lossAfter(["C3"], 8);
    ctl.play(C3);
    await ctl.handleAction({ type: "continue" });
    await ctl.handleTutor({ type: "resume" });
    await flush();
    expect(engine.botCalls).toHaveLength(0);
    engine.releaseAll();
    await flush();
    expect(ctl.view().moves[0]!.eval?.pointLoss).toBe(8);
    expect(ctl.view().status).toBe("paused");
    expect(ctl.view().moment?.state).toBe("waiting");
  });

  it("an invalid drawing command leaves a waiting moment's fallback timer alone", async () => {
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 8);
    ctl.play(C3);
    await flush();
    await expect(ctl.handleTutor({ type: "mark", points: ["I5"] })).rejects.toThrow(/not a point/);
    await expect(ctl.handleTutor({ type: "show", moves: [] })).rejects.toThrow(/at least one move/);
    expect(ctl.view().moment?.state).toBe("waiting");
    clock.advance(30_000);
    expect(ctl.view().moment?.state).toBe("fallback");
  });

  it("Try again tells the tutor and drops tags on the moves taken back", async () => {
    await startGame();
    engine.lossAfter(["C3"], 9);
    ctl.play(C3);
    await flush();
    const gameId = ctl.view().gameId!;
    await ctl.handleTutor({ type: "tag", gameId, moveNumber: 1, category: "shape" });
    expect(store.loadProfile().mistakeCounts.shape).toBe(1);
    await ctl.handleAction({ type: "retry" });
    expect(events.at(-1)).toEqual({ type: "undo", gameId, moves: 0, toPlay: "B", by: "human" });
    expect(store.loadProfile().mistakeCounts.shape).toBe(0);
    expect(store.loadProfile().recentMistakes).toEqual([]);
    expect(store.loadGame(gameId)!.tags).toEqual({});
  });

  it("tag refuses the bot's moves", async () => {
    await startGame();
    ctl.play(E5);
    await flush();
    await expect(ctl.handleTutor({ type: "tag", gameId: ctl.view().gameId!, moveNumber: 2, category: "shape" })).rejects.toThrow(/bot's/);
    expect(store.loadProfile().mistakeCounts.shape).toBe(0);
  });

  it("saves chat as it happens, including after the game ends, and keeps ids unique after a restore", async () => {
    await startGame();
    const id = ctl.view().gameId!;
    await ctl.handleAction({ type: "chat", text: "before restart" });
    await ctl.handleTutor({ type: "say", text: "TUTOR-SAY" });
    await flush(); // saves land at the end of the tick
    const texts = () => store.loadGame(id)!.chat.map((m) => m.text);
    expect(texts()).toContain("before restart");
    expect(texts()).toContain("TUTOR-SAY");

    const again = new GameController({ engine, store, clock, botDelayMs: 0 });
    again.restoreLastGame();
    const ids = again.view().chat.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    await again.handleAction({ type: "resign" });
    await again.handleTutor({ type: "say", text: "Let's review move 1." });
    await flush();
    expect(store.loadGame(id)!.chat.at(-1)!.text).toBe("Let's review move 1.");
  });

  it("Try again from the browser resolves the moment", async () => {
    await startGame();
    engine.lossAfter(["C3"], 9);
    ctl.play(C3);
    await flush();
    await ctl.handleAction({ type: "retry" });
    expect(ctl.view().moves).toHaveLength(0);
    expect(ctl.view().moment?.state).toBe("resolved");
    expect(ctl.view().overlay).toBeNull();
  });

  it("ignores an engine reply that arrives after the position changed", async () => {
    await startGame();
    engine.hold = true;
    engine.lossAfter(["C3"], 9);
    ctl.play(C3);
    await flush();
    await ctl.handleAction({ type: "retry" }); // undo while the eval is in flight
    engine.releaseAll();
    await flush();
    const v = ctl.view();
    expect(v.moves).toHaveLength(0);
    expect(v.moment).toBeNull();
    expect(v.status).toBe("playing");
    expect(engine.botCalls).toHaveLength(0);
    expect(types()).not.toContain("teaching_moment");
  });

  it("ignores a bot move that arrives after a new game started", async () => {
    await startGame();
    ctl.play(E5);
    await flush();
    engine.hold = true;
    await ctl.handleAction({ type: "retry" });
    ctl.play(D4);
    engine.releaseAll(); // the eval
    await flush();
    expect(engine.botCalls).toHaveLength(2);
    ctl.newGame({ size: 13 });
    engine.releaseAll(); // the stale bot move and the new game's prefetch
    await flush();
    const v = ctl.view();
    expect(v.settings?.size).toBe(13);
    expect(v.moves).toHaveLength(0);
    expect(v.engineBusy).toBe(false);
  });

  it("the bot moves first when the human plays white", async () => {
    engine.botMoves = ["E5"];
    ctl.newGame({ humanColor: "W" });
    await flush();
    expect(ctl.view().moves.map((r) => r.move.color)).toEqual(["B"]);
    expect(ctl.view().toPlay).toBe("W");
  });

  it("ends on two passes, removes dead stones by ownership, saves and updates the profile", async () => {
    await startGame();
    const id = ctl.view().gameId!;
    engine.botMoves = ["A1", "pass"];
    engine.ownership = (size) => new Array(size * size).fill(1); // Black owns everything: A1 is dead
    engine.lossAfter(["C3"], 5);
    ctl.play(E5);
    await flush();
    ctl.play(null); // human pass, then the bot passes
    await flush();
    const v = ctl.view();
    expect(v.status).toBe("finished");
    expect(v.result).toEqual({ winner: "B", margin: 81 - 7, reason: "score" });
    expect(v.chat.at(-1)!.text).toMatch(/Black \(you\) wins by 74 points \(1 dead stone removed\)/);
    const end = events.at(-1)!;
    expect(end.type).toBe("game_end");
    if (end.type === "game_end") expect(end.summary).toEqual({ moves: 4, mistakes: [], totalPointLoss: 0 });

    const saved = store.loadGame(id)!;
    expect(saved.result?.winner).toBe("B");
    expect(saved.moves).toHaveLength(4);
    expect(saved.moves[0]!.eval).toBeDefined();
    const sgf = readFileSync(join(store.dir, "games", `${id}.sgf`), "utf8");
    expect(sgf).toContain("RE[B+74]");
    const profile = store.loadProfile();
    expect(profile.gamesPlayed).toBe(1);
    expect(profile.ratingHistory).toEqual([{ ts: clock.now(), gameId: id, rating: 10, botRank: "20k", won: true }]);
    expect(() => ctl.play(D4)).toThrow(UserError);
  });

  it("answers a pass with a pass when KataGo says the game is over, without asking the human-SL bot", async () => {
    await startGame();
    engine.botMoves = ["A1"];
    ctl.play(E5);
    await flush();
    engine.best = "pass";
    engine.pv = ["pass"];
    const botCalls = engine.botCalls.length;
    ctl.play(null);
    await flush();
    expect(engine.botCalls).toHaveLength(botCalls);
    expect(ctl.view().status).toBe("finished");
    expect(ctl.view().moves.slice(-2).map((r) => "pass" in r.move)).toEqual([true, true]);
  });

  it("passIsFine compares KataGo's lead for passing with its best move", () => {
    const info = (move: string, scoreLead: number) => ({ move, scoreLead, winrate: 0.5, visits: 10, order: 0, prior: 0, pv: [] });
    const analysis = (...moveInfos: ReturnType<typeof info>[]) => ({ id: "a", toPlay: "W" as const, rootInfo: { scoreLead: 0, winrate: 0.5, visits: 1 }, moveInfos });
    expect(passIsFine(analysis(info("pass", 3)))).toBe(true);
    expect(passIsFine(analysis(info("E8", 84.2), info("pass", 74.5)))).toBe(false);
    expect(passIsFine(analysis(info("J6", 10), info("pass", 9)))).toBe(true);
    expect(passIsFine(analysis(info("J6", 10)))).toBe(false);
  });

  it("scores without dead-stone removal when ownership says nothing", async () => {
    await startGame();
    engine.botMoves = ["A1", "pass"];
    ctl.play(E5);
    await flush();
    ctl.play(null);
    await flush();
    expect(ctl.view().result).toEqual({ winner: "W", margin: 1 - 1 - 7, reason: "score" });
  });

  it("summarizes mistakes worst first and records tags", async () => {
    await startGame();
    engine.botMoves = ["G7", "G3"];
    engine.lossAfter(["C3"], 4.5);
    engine.lossAfter(["C3", "G7", "D4"], 10);
    ctl.play(C3);
    await flush();
    await ctl.handleAction({ type: "continue" });
    await flush();
    ctl.play(D4);
    await flush();
    await ctl.handleTutor({ type: "tag", gameId: ctl.view().gameId!, moveNumber: 3, category: "shape", note: "empty triangle" });
    await ctl.handleAction({ type: "continue" });
    await flush();
    await ctl.handleAction({ type: "resign" });
    const end = events.at(-1)!;
    if (end.type !== "game_end") throw new Error("expected game_end");
    expect(end.result).toEqual({ winner: "W", margin: 0, reason: "resign" });
    expect(end.summary.mistakes).toEqual([
      { moveNumber: 3, move: "D4", pointLoss: 10, bestMove: "E5", category: "shape" },
      { moveNumber: 1, move: "C3", pointLoss: 4.5, bestMove: "E5" },
    ]);
    expect(end.summary.totalPointLoss).toBe(14.5);
    const profile = store.loadProfile();
    expect(profile.mistakeCounts.shape).toBe(1);
    expect(profile.recentMistakes[0]).toMatchObject({ moveNumber: 3, category: "shape", pointLoss: 10, note: "empty triangle" });

    // Re-tagging a saved game moves the tally to the new category.
    await ctl.handleTutor({ type: "tag", gameId: end.gameId, moveNumber: 3, category: "direction" });
    const after = store.loadProfile();
    expect(after.mistakeCounts.shape).toBe(0);
    expect(after.mistakeCounts.direction).toBe(1);
    await flush();
    expect(store.loadGame(end.gameId)!.summary!.mistakes[0]!.category).toBe("direction");
  });

  it("answers a hint with KataGo's move when no tutor is attached", async () => {
    await startGame();
    await ctl.handleAction({ type: "ask_tutor", text: "where now?" });
    const v = ctl.view();
    expect(v.overlay?.marks).toEqual([{ point: E5, kind: "circle" }]);
    expect(v.chat.at(-1)!.text).toMatch(/look at E5/);
    expect(types()).toContain("hint_request");
  });

  it("forwards hints and chat to an attached tutor", async () => {
    setup({ tutor: true });
    await startGame();
    await ctl.handleAction({ type: "ask_tutor" });
    expect(ctl.view().overlay).toBeNull();
    await ctl.handleAction({ type: "chat", text: "why did the bot play there?" });
    expect(events.at(-1)).toMatchObject({ type: "user_message", text: "why did the bot play there?" });
    expect(ctl.view().chat.at(-1)!.from).toBe("user");
  });

  it("tells the user when no tutor is connected for chat", async () => {
    await startGame();
    await ctl.handleAction({ type: "chat", text: "hello" });
    expect(ctl.view().chat.at(-1)).toMatchObject({ from: "system" });
    expect(ctl.view().chat.at(-1)!.text).toMatch(/tutor isn't connected/);
  });

  it("refuses moves until KataGo is ready, and reports engineBusy", async () => {
    ctl = new GameController({ engine, store, clock, botDelayMs: 0 });
    ctl.newGame();
    expect(ctl.view().engineBusy).toBe(true);
    expect(() => ctl.play(E5)).toThrow(/still starting/);
    ctl.setEngineState("failed", "KataGo couldn't start. Run `npm run setup:katago`.");
    expect(ctl.view().chat.at(-1)!.text).toMatch(/setup:katago/);
    expect(() => ctl.play(E5)).toThrow(/isn't running/);
  });

  it("validates settings and tutor drawing input", async () => {
    expect(() => ctl.newGame({ size: 7 as 9 })).toThrow(/9, 13 or 19/);
    expect(() => ctl.newGame({ botRank: "40k" })).toThrow(UserError);
    expect(() => ctl.newGame({ handicap: 1 })).toThrow(/Handicap/);
    expect(() => ctl.newGame({ komi: 7.2 })).toThrow(/Komi/);
    expect(() => ctl.newGame({ komi: 6.5 })).not.toThrow();
    await startGame();
    await expect(ctl.handleTutor({ type: "mark", points: ["Z9"] })).rejects.toThrow(/not a point/);
    await ctl.handleTutor({ type: "mark", points: ["C3", "D4"], kind: "triangle" });
    expect(ctl.view().overlay?.marks).toHaveLength(2);
    await ctl.handleTutor({ type: "clear" });
    expect(ctl.view().overlay).toBeNull();
  });

  it("restores an unfinished game after a restart", async () => {
    await startGame();
    ctl.play(E5);
    await flush();
    const id = ctl.view().gameId;
    const again = new GameController({ engine, store, clock, botDelayMs: 0 });
    expect(again.restoreLastGame()).toBe(true);
    expect(again.view().gameId).toBe(id);
    expect(again.view().moves).toHaveLength(2);
    expect(again.view().moves[0]!.eval).toBeDefined();
  });

  it("a restart during a teaching moment opens it again instead of letting the bot move", async () => {
    await startGame();
    engine.lossAfter(["C3"], 14.8);
    ctl.play(C3);
    await flush();
    expect(ctl.view().status).toBe("paused");
    const again = new GameController({ engine, store, clock, botDelayMs: 0 });
    again.restoreLastGame();
    again.setEngineState("ready");
    await flush();
    expect(again.view().status).toBe("paused");
    expect(again.view().moment).toMatchObject({ moveNumber: 1, pointLoss: 14.8, state: "fallback" });
    expect(again.view().moves).toHaveLength(1);
  });

  it("a restart after Continue doesn't reopen the dismissed moment", async () => {
    await startGame();
    engine.lossAfter(["C3"], 6);
    ctl.play(C3);
    await flush();
    engine.hold = true; // the bot's reply never arrives before the "crash"
    await ctl.handleAction({ type: "continue" });
    ctl.flush(); // as on shutdown
    const again = new GameController({ engine, store, clock, botDelayMs: 0 });
    again.restoreLastGame();
    expect(again.view().status).toBe("playing");
    expect(again.view().moment).toBeNull();
  });

  it("a restart before a human move was evaluated evaluates it once KataGo is ready", async () => {
    await startGame();
    engine.hold = true;
    engine.lossAfter(["C3"], 7);
    ctl.play(C3); // the eval never comes back before the "crash"
    engine.held.length = 0;
    engine.hold = false;
    ctl.flush();
    const again = new GameController({ engine, store, clock, botDelayMs: 0 });
    again.restoreLastGame();
    const botCalls = engine.botCalls.length;
    again.setEngineState("ready");
    await flush();
    expect(engine.botCalls).toHaveLength(botCalls);
    expect(again.view().moves[0]!.eval?.pointLoss).toBe(7);
    expect(again.view().moment).toMatchObject({ moveNumber: 1, state: "fallback" });
  });

  it("abandons the old game when a new one starts mid-game", async () => {
    await startGame();
    const id = ctl.view().gameId!;
    clock.advance(1000);
    ctl.newGame();
    expect(store.loadGame(id)!.result).toEqual({ winner: null, margin: 0, reason: "abandon" });
    expect(ctl.view().gameId).not.toBe(id);
    await flush();
    expect(existsSync(join(store.dir, "games", `${ctl.view().gameId}.json`))).toBe(true);
    expect(store.loadProfile().gamesPlayed).toBe(0);
  });

  it("writes a burst of changes once, and flushes at game end and on demand", async () => {
    await startGame();
    let saves = 0;
    const saveGame = store.saveGame.bind(store);
    store.saveGame = (...args) => {
      saves++;
      saveGame(...args);
    };
    engine.lossAfter(["C3"], 6);
    ctl.play(C3); // move, eval, moment and fallback chat: one write per tick, not one per change
    await flush();
    expect(saves).toBeLessThanOrEqual(2);
    expect(store.loadGame(ctl.view().gameId!)!.moment).toMatchObject({ moveNumber: 1, state: "fallback" });

    saves = 0;
    await ctl.handleAction({ type: "chat", text: "hm" });
    expect(saves).toBe(0);
    ctl.flush();
    expect(saves).toBe(1);
    ctl.flush();
    expect(saves).toBe(1);
    await flush();
    expect(saves).toBe(1);

    await ctl.handleAction({ type: "resign" });
    expect(store.loadGame(ctl.view().gameId!)!.result).toMatchObject({ reason: "resign" });
  });

  it("sends handicap stones and the first player to KataGo", async () => {
    ctl.newGame({ handicap: 2 });
    await flush();
    const pos = engine.analyzeCalls[0]!.pos;
    expect(pos.initialStones).toEqual([
      ["B", "C3"],
      ["B", "G7"],
    ]);
    expect(pos.initialPlayer).toBe("W");
  });
});
