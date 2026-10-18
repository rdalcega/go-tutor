import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { formatReview } from "../../src/cli/format.ts";
import { UserError, type TutorEventInput } from "../../src/server/common.ts";
import { GameController, passIsFine } from "../../src/server/game.ts";
import type { Store } from "../../src/server/store.ts";
import { fromGtp } from "../../src/shared/coords.ts";
import { judgedLoss } from "../../src/shared/judge.ts";
import { round2 } from "../../src/shared/text.ts";
import type { GameSummary } from "../../src/shared/types.ts";
import { FakeClock, FakeEngine, flush, seedProblems, tempStore } from "./fakes.ts";

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
  seedProblems(store); // a practice problem, for the tests that open Practice
  // A learner already on rating model 2 (the server migrates a new data dir at the first engine-ready).
  store.saveProfile({ ...store.loadProfile(), ratingModel: 2 });
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
    expect(v.overlay?.best).toEqual(E5); // KataGo's move is highlighted as part of the drawing
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

  it("KataGo's highlighted move lives in the fallback drawing: resume keeps it, Hide removes it, a new line replaces it", async () => {
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 8);
    ctl.play(C3);
    await flush();
    clock.advance(30_000); // the tutor is too slow
    expect(ctl.view().moment?.state).toBe("fallback");
    expect(ctl.view().overlay?.best).toEqual(E5);
    // The tutor comes in late and resumes: the drawing, highlight included, waits for Continue.
    await ctl.handleTutor({ type: "resume" });
    expect(ctl.view().moment).toMatchObject({ state: "tutor", awaitingLearner: true });
    expect(ctl.view().overlay?.best).toEqual(E5);
    // A new line replaces KataGo's, highlight and all.
    await ctl.handleTutor({ type: "show", moves: ["D4"], start: "W" });
    expect(ctl.view().overlay?.best).toBeUndefined();
    expect(ctl.view().overlay?.marks).toEqual([{ point: C3, kind: "x" }]);
    // Hiding the drawing removes everything on it.
    await ctl.handleAction({ type: "clear_overlay" });
    expect(ctl.view().overlay).toBeNull();
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
    // The tutor is done, but the drawing stays: the pause waits for the learner's Continue.
    await ctl.handleTutor({ type: "resume" });
    await flush();
    expect(ctl.view().status).toBe("paused");
    expect(ctl.view().moment).toMatchObject({ state: "tutor", awaitingLearner: true });
    expect(ctl.view().overlay?.variation).toEqual({ moves: [{ color: "W", point: D4 }] });
    expect(ctl.view().moves).toHaveLength(1);
    // More words are still welcome; the learner continues when ready.
    await ctl.handleTutor({ type: "say", text: "Take your time." });
    expect(ctl.view().moment?.awaitingLearner).toBe(true);
    await ctl.handleAction({ type: "continue" });
    await flush();
    expect(ctl.view().status).toBe("playing");
    expect(ctl.view().overlay).toBeNull();
    expect(ctl.view().moment).toMatchObject({ state: "resolved" });
    expect(ctl.view().moment?.awaitingLearner).toBeUndefined();
    expect(ctl.view().moves).toHaveLength(2);
  });

  it("resume without a drawing ends the pause at once", async () => {
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 8);
    ctl.play(C3);
    await flush();
    await ctl.handleTutor({ type: "claim", momentId: ctl.view().moment!.id });
    await ctl.handleTutor({ type: "say", text: "C3 is slow." });
    await ctl.handleTutor({ type: "resume" });
    await flush();
    expect(ctl.view().status).toBe("playing");
    expect(ctl.view().moves).toHaveLength(2);
  });

  it("resume after the learner hid the drawing ends the pause; Try again also ends a waiting pause", async () => {
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 8);
    ctl.play(C3);
    await flush();
    await ctl.handleTutor({ type: "mark", points: ["E5"] });
    await ctl.handleTutor({ type: "resume" });
    expect(ctl.view().moment?.awaitingLearner).toBe(true);
    expect(ctl.view().allowed).toContain("clear_overlay");
    // Hiding the drawing keeps the pause: the learner still decides when to go on.
    await ctl.handleAction({ type: "clear_overlay" });
    expect(ctl.view().overlay).toBeNull();
    expect(ctl.view().status).toBe("paused");
    expect(ctl.view().allowed).not.toContain("clear_overlay");
    await ctl.handleAction({ type: "retry" });
    expect(ctl.view().status).toBe("playing");
    expect(ctl.view().moves).toHaveLength(0);
    expect(ctl.view().moment?.state).toBe("resolved");
  });

  it("keeps a drawing outside a pause until the learner's next move or Hide", async () => {
    setup({ tutor: true });
    await startGame();
    ctl.play(E5);
    await flush();
    expect(ctl.view().moves).toHaveLength(2);
    await ctl.handleAction({ type: "ask_tutor" });
    await ctl.handleTutor({ type: "mark", points: ["C3"] });
    await flush();
    expect(ctl.view().overlay?.marks).toHaveLength(1);
    ctl.play(C3);
    expect(ctl.view().overlay).toBeNull();
    await flush();
    await ctl.handleTutor({ type: "show", moves: ["D4", "G7"] });
    await ctl.handleAction({ type: "clear_overlay" });
    expect(ctl.view().overlay).toBeNull();
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

  it("falls back when the wait's timer fires a moment before the deadline", async () => {
    setup({ tutor: true });
    clock.earlyMs = 1; // Node timers can fire about a millisecond early
    await startGame();
    engine.lossAfter(["C3"], 5);
    ctl.play(C3);
    await flush();
    clock.advance(30_000);
    expect(ctl.view().moment?.state).toBe("fallback");
    expect(clock.pendingTimers).toBe(0);
    expect(types()).toEqual(["game_start", "move", "teaching_moment", "fallback"]);
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

  it("Try again tells the tutor and keeps the move taken back, with its tag, as a first attempt", async () => {
    await startGame();
    engine.lossAfter(["C3"], 9);
    ctl.play(C3);
    await flush();
    const gameId = ctl.view().gameId!;
    await ctl.handleTutor({ type: "tag", gameId, moveNumber: 1, category: "shape" });
    expect(store.loadProfile().mistakeCounts.shape).toBe(1);
    await ctl.handleAction({ type: "retry" });
    expect(events.at(-1)).toEqual({ type: "undo", gameId, moves: 0, toPlay: "B", by: "human" });
    // The mistake still counts, now as the taken-back first attempt.
    expect(store.loadProfile().mistakeCounts.shape).toBe(1);
    expect(store.loadProfile().recentMistakes).toMatchObject([{ gameId, moveNumber: 1, category: "shape", takenBack: 0 }]);
    ctl.flush();
    const saved = store.loadGame(gameId)!;
    expect(saved.tags).toEqual({});
    expect(saved.takenBack).toMatchObject([{ moveNumber: 1, by: "human", before: [], tag: { category: "shape" }, record: { move: { color: "B", point: C3 } } }]);
    expect(saved.takenBack![0]!.record.eval?.pointLoss).toBe(9);
    expect(saved.assistance).toEqual({ hints: 0, takeBacks: 1, rethinks: 0 });
  });

  it("tags a taken-back first attempt apart from the move that replaced it", async () => {
    await startGame();
    engine.lossAfter(["C3"], 9);
    ctl.play(C3);
    await flush();
    const gameId = ctl.view().gameId!;
    await ctl.handleAction({ type: "retry" });
    engine.lossAfter(["D4"], 5);
    ctl.play(D4);
    await flush();
    await ctl.handleAction({ type: "continue" });
    await ctl.handleAction({ type: "resign" });
    const end = events.find((e) => e.type === "game_end");
    if (end?.type !== "game_end") throw new Error("expected game_end");
    expect(end.summary.mistakes.map((m) => [m.moveNumber, m.move, m.takenBack])).toEqual([
      [1, "C3", 0],
      [1, "D4", undefined],
    ]);
    await ctl.handleTutor({ type: "tag", gameId, moveNumber: 1, category: "opening", takenBack: true });
    await ctl.handleTutor({ type: "tag", gameId, moveNumber: 1, category: "shape" });
    ctl.flush();
    const saved = store.loadGame(gameId)!;
    expect(saved.takenBack![0]!.tag).toEqual({ category: "opening" });
    expect(saved.tags[1]).toEqual({ category: "shape" });
    expect(saved.summary!.mistakes.map((m) => [m.category, m.categorySource, m.takenBack])).toEqual([
      ["opening", "tutor", 0],
      ["shape", "tutor", undefined],
    ]);
    const tallies = store.loadProfile().recentMistakes.map((m) => [m.moveNumber, m.category, m.takenBack]);
    expect(tallies).toEqual([
      [1, "shape", undefined],
      [1, "opening", 0],
    ]);
    await expect(ctl.handleTutor({ type: "tag", gameId, moveNumber: 3, category: "shape", takenBack: true })).rejects.toThrow(/no taken-back move 3/);
  });

  it("tags the taken-back try the tutor names when there are several at one move, as review numbers them", async () => {
    await startGame();
    const gameId = ctl.view().gameId!;
    engine.lossAfter(["C3"], 9);
    ctl.play(C3);
    await flush();
    await ctl.handleAction({ type: "retry" });
    engine.lossAfter(["D4"], 5);
    ctl.play(D4);
    await flush();
    await ctl.handleAction({ type: "retry" });
    ctl.play(E5);
    await flush();
    await ctl.handleAction({ type: "resign" });
    ctl.flush();
    const review = formatReview(store.loadGame(gameId)!);
    expect(review).toContain("move 1 (first try #1, taken back by the learner) B C3 -9");
    expect(review).toContain("move 1 (first try #2, taken back by the learner) B D4 -5");
    // Ambiguous without a number: the error lists the tries.
    await expect(ctl.handleTutor({ type: "tag", gameId, moveNumber: 1, category: "shape", takenBack: true })).rejects.toThrow(
      /2 taken-back tries at move 1 \(#1 C3 -9, #2 D4 -5\)\. Name one: --taken-back <n>/,
    );
    await expect(ctl.handleTutor({ type: "tag", gameId, moveNumber: 1, category: "shape", takenBack: 3 })).rejects.toThrow(/no taken-back first try #3 at move 1; it has #1 C3 -9, #2 D4 -5/);
    // #2 is the second try, D4, even though C3 cost more.
    await ctl.handleTutor({ type: "tag", gameId, moveNumber: 1, category: "shape", takenBack: 2 });
    ctl.flush();
    const saved = store.loadGame(gameId)!;
    expect(saved.takenBack!.map((t) => t.tag?.category)).toEqual([undefined, "shape"]);
    expect(saved.summary!.mistakes.map((m) => [m.move, m.category, m.categorySource, m.takenBack])).toEqual([
      ["C3", "opening", "heuristic", 0],
      ["D4", "shape", "tutor", 1],
    ]);
    expect(store.loadProfile().recentMistakes.find((m) => m.takenBack === 1)).toMatchObject({ category: "shape", pointLoss: 5 });
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
    await flush(); // saves land at the end of the tick, without a flush
    const texts = () => store.loadGame(id)!.chat.map((m) => m.text);
    expect(texts()).toContain("before restart");
    expect(texts()).toContain("TUTOR-SAY");

    const again = new GameController({ engine, store, clock, botDelayMs: 0 });
    again.restoreLastGame();
    const ids = again.view().chat.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    await again.handleAction({ type: "resign" });
    await again.handleTutor({ type: "say", text: "Let's review move 1." });
    again.flush();
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
    if (end.type === "game_end") {
      // Two human moves: too short to change the rating.
      expect(end.summary).toEqual({
        moves: 4,
        threshold: 4,
        mistakes: [],
        totalPointLoss: 0,
        assistance: { hints: 0, takeBacks: 0, rethinks: 0 },
        rating: { before: 10, after: 10, rated: false, nextBotRank: "20k", nextHandicap: 0 },
      });
    }

    const saved = store.loadGame(id)!;
    expect(saved.result?.winner).toBe("B");
    expect(saved.moves).toHaveLength(4);
    expect(saved.moves[0]!.eval).toBeDefined();
    const sgf = readFileSync(join(store.dir, "games", `${id}.sgf`), "utf8");
    expect(sgf).toContain("RE[B+74]");
    const profile = store.loadProfile();
    expect(profile.gamesPlayed).toBe(1);
    expect(profile.ratingHistory).toEqual([]);
    expect(profile.recentGames).toEqual([{ ts: clock.now(), gameId: id, size: 9, humanMoves: 2, avgPointLoss: 0, mistakes: 0, threshold: 4 }]);
    expect(store.loadGame(id)!.summary?.rating?.rated).toBe(false);
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
      { moveNumber: 3, move: "D4", pointLoss: 10, bestMove: "E5", category: "shape", categorySource: "tutor" },
      { moveNumber: 1, move: "C3", pointLoss: 4.5, bestMove: "E5", category: "opening", categorySource: "heuristic" },
    ]);
    expect(end.summary.totalPointLoss).toBe(14.5);
    const profile = store.loadProfile();
    expect(profile.mistakeCounts.shape).toBe(1);
    expect(profile.mistakeCounts.opening).toBe(1); // the untagged mistake counts under its heuristic category
    expect(profile.recentMistakes.map((m) => [m.moveNumber, m.category])).toEqual([
      [1, "opening"],
      [3, "shape"],
    ]);
    expect(profile.recentMistakes[1]).toMatchObject({ moveNumber: 3, category: "shape", pointLoss: 10, note: "empty triangle" });

    // The tutor's tag replaces a heuristic category in the summary and the tallies.
    await ctl.handleTutor({ type: "tag", gameId: end.gameId, moveNumber: 1, category: "tactics" });
    expect(store.loadProfile().mistakeCounts).toMatchObject({ opening: 0, tactics: 1 });
    expect(ctl.view().status).toBe("finished");

    // Re-tagging a saved game moves the tally to the new category.
    await ctl.handleTutor({ type: "tag", gameId: end.gameId, moveNumber: 3, category: "direction" });
    const after = store.loadProfile();
    expect(after.mistakeCounts.shape).toBe(0);
    expect(after.mistakeCounts.direction).toBe(1);
    ctl.flush();
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
    ctl.flush(); // as on shutdown
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
    ctl.flush(); // as on shutdown
    const again = new GameController({ engine, store, clock, botDelayMs: 0 });
    again.restoreLastGame();
    again.setEngineState("ready");
    await flush();
    expect(again.view().status).toBe("paused");
    expect(again.view().moment).toMatchObject({ moveNumber: 1, pointLoss: 14.8, state: "fallback" });
    expect(again.view().moves).toHaveLength(1);
    // KataGo's line is drawn again; its message, already in the chat, isn't repeated.
    expect(again.view().overlay?.variation).toMatchObject({ fromMove: 1 });
    expect(again.view().chat.filter((m) => /cost about 14\.8/.test(m.text))).toHaveLength(1);
  });

  it("a restart during a moment the tutor had waits for the tutor to come back before falling back", async () => {
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 6);
    ctl.play(C3);
    await flush();
    const id = ctl.view().moment!.id;
    await ctl.handleTutor({ type: "claim", momentId: id });
    await ctl.handleTutor({ type: "say", text: "Which of your groups is weakest?" });
    ctl.flush(); // as on shutdown
    // The server comes back up before `tutor watch` reconnects.
    const again = new GameController({ engine, store, clock, botDelayMs: 0, tutorTimeoutMs: 30_000 });
    const replayed: TutorEventInput[] = [];
    again.onEvent((e) => replayed.push(e));
    expect(again.restoreLastGame()).toBe(true);
    again.setEngineState("ready");
    await flush();
    expect(again.view().status).toBe("paused");
    expect(again.view().moment).toMatchObject({ id, state: "waiting", deadline: clock.now() + 30_000 });
    expect(replayed).toEqual([]); // nothing is logged again: a fresh watch finds the moment's event in the log
    expect(again.view().chat.some((m) => /cost about/.test(m.text))).toBe(false);
    // The tutor is back in time and picks it up again.
    again.setTutorAttached(true);
    await again.handleTutor({ type: "claim", momentId: id });
    clock.advance(60_000);
    expect(again.view().moment?.state).toBe("tutor");
    expect(again.view().chat.some((m) => /cost about/.test(m.text))).toBe(false);
  });

  it("a restart after the tutor resumed with a drawing up keeps the pause for the learner's Continue, without a fallback", async () => {
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 6);
    ctl.play(C3);
    await flush();
    const id = ctl.view().moment!.id;
    await ctl.handleTutor({ type: "show", moves: ["E5", "D4"] });
    await ctl.handleTutor({ type: "say", text: "E5 is bigger." });
    await ctl.handleTutor({ type: "resume" });
    expect(ctl.view().moment).toMatchObject({ state: "tutor", awaitingLearner: true });
    ctl.flush();
    const again = new GameController({ engine, store, clock, botDelayMs: 0, tutorTimeoutMs: 30_000 });
    again.restoreLastGame();
    again.setEngineState("ready");
    await flush();
    expect(again.view().status).toBe("paused");
    expect(again.view().moment).toMatchObject({ id, state: "tutor", awaitingLearner: true });
    expect(again.view().moment?.deadline).toBeUndefined();
    clock.advance(60_000);
    expect(again.view().moment?.state).toBe("tutor"); // the tutor already answered: KataGo doesn't
    expect(again.view().chat.some((m) => /cost about/.test(m.text))).toBe(false);
    await again.handleAction({ type: "continue" });
    expect(again.view().status).toBe("playing");
  });

  it("a restart after a rethink keeps the moment open for the learner's new move", async () => {
    setup({ tutor: true });
    await startGame();
    engine.botMoves = ["G7"];
    ctl.play(E5);
    await flush();
    engine.lossAfter(["E5", "G7", "C3"], 6);
    ctl.play(C3);
    await flush();
    const id = ctl.view().moment!.id;
    await ctl.handleTutor({ type: "rethink", text: "Look again: which group is weakest?" });
    expect(ctl.view().moves).toHaveLength(2);
    ctl.flush(); // as on shutdown
    const again = new GameController({ engine, store, clock, botDelayMs: 0 });
    const replayed: TutorEventInput[] = [];
    again.onEvent((e) => replayed.push(e));
    expect(again.restoreLastGame()).toBe(true);
    again.setEngineState("ready");
    await flush();
    // The moment is still the tutor's, the learner is to play, and Try again stays off (the move is already taken back).
    expect(again.view()).toMatchObject({ status: "playing", toPlay: "B", moment: { id, moveNumber: 3, state: "tutor" } });
    expect(again.view().allowed).toContain("play");
    expect(again.view().allowed).not.toContain("retry");
    expect(replayed).toEqual([]);
    again.play(D4);
    await flush();
    expect(again.view().moment?.state).toBe("resolved");
    expect(again.view().moves[2]!.assist).toEqual(["rethink"]);
  });

  it("a restart during a moment the tutor had falls back once nobody comes back for it", async () => {
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 6);
    ctl.play(C3);
    await flush();
    await ctl.handleTutor({ type: "claim", momentId: ctl.view().moment!.id });
    ctl.flush();
    const again = new GameController({ engine, store, clock, botDelayMs: 0, tutorTimeoutMs: 30_000 });
    again.restoreLastGame();
    again.setEngineState("ready");
    await flush();
    expect(again.view().moment?.state).toBe("waiting");
    clock.advance(30_000);
    expect(again.view().moment?.state).toBe("fallback");
    expect(again.view().chat.filter((m) => /cost about 6/.test(m.text))).toHaveLength(1);
    expect(again.view().overlay?.variation).toMatchObject({ fromMove: 1 });
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

describe("GameController and the learner profile", () => {
  beforeEach(() => setup());

  it("evaluates moves with ownership and categorizes a mistake that kills a group as life and death", async () => {
    await startGame();
    const id = ctl.view().gameId!;
    engine.botMoves = ["A9", "A8"];
    // E5-F5 (row 5 from the top is y 4) is alive until J1, after which KataGo sees it dead.
    const group = new Set([4 * 9 + 4, 4 * 9 + 5]);
    engine.ownership = (size, moves) => Array.from({ length: size * size }, (_, i) => (group.has(i) ? (moves.endsWith("J1") ? -0.9 : 0.9) : 0));
    engine.lossAfter(["E5", "A9", "F5", "A8", "J1"], 12);
    ctl.play(E5);
    await flush();
    ctl.play({ x: 5, y: 4 });
    await flush();
    ctl.play({ x: 8, y: 8 }); // J1
    await flush();
    expect(ctl.view().status).toBe("paused");
    ctl.flush();
    expect(store.loadGame(id)!.heuristics).toEqual({ 5: "life_and_death" });
    // One query per position, each with ownership: the move evals serve the category too.
    const keyOf = (c: (typeof engine.analyzeCalls)[number]) => c.pos.moves.map((m) => m[1]).join(" ");
    expect(engine.analyzeCalls.every((c) => c.opts?.includeOwnership)).toBe(true);
    expect(engine.analyzeCalls.filter((c) => keyOf(c) === "E5 A9 F5 A8")).toHaveLength(1);
    await ctl.handleAction({ type: "continue" });
    await flush();

    await ctl.handleAction({ type: "resign" });
    const end = events.at(-1)!;
    if (end.type !== "game_end") throw new Error("expected game_end");
    expect(end.summary.mistakes).toEqual([{ moveNumber: 5, move: "J1", pointLoss: 12, bestMove: "E5", category: "life_and_death", categorySource: "heuristic" }]);
    expect(store.loadProfile().mistakeCounts.life_and_death).toBe(1);
  });

  it("still saves and announces a finished game when the profile can't be updated", async () => {
    const logs: string[] = [];
    ctl = new GameController({ engine, store, clock, botDelayMs: 0, log: (m) => logs.push(m) });
    ctl.onEvent((e) => events.push(e));
    ctl.setEngineState("ready");
    await startGame();
    const id = ctl.view().gameId!;
    store.saveProfile = () => {
      throw new Error("disk full");
    };
    engine.botMoves = ["pass"];
    ctl.play(E5);
    await flush();
    ctl.play(null); // two passes: the game is scored
    await flush();
    expect(types().at(-1)).toBe("game_end");
    expect(ctl.view().status).toBe("finished");
    expect(store.loadGame(id)!.result).toMatchObject({ reason: "score" });
    expect(logs).toContainEqual(expect.stringMatching(/updating the profile after game .* failed: disk full/));
  });

  it("keeps the move Try again took back as a first attempt: its category, a mistake in the summary, a problem", async () => {
    await startGame();
    engine.lossAfter(["C3"], 6);
    ctl.play(C3);
    await flush();
    await ctl.handleAction({ type: "retry" });
    ctl.play(E5);
    await flush();
    await ctl.handleAction({ type: "resign" });
    const end = events.find((e) => e.type === "game_end");
    if (end?.type !== "game_end") throw new Error("expected game_end");
    expect(end.summary.mistakes).toEqual([{ moveNumber: 1, move: "C3", pointLoss: 6, bestMove: "E5", category: "opening", categorySource: "heuristic", takenBack: 0 }]);
    expect(end.summary.totalPointLoss).toBe(6);
    expect(end.summary.assistance).toEqual({ hints: 0, takeBacks: 1, rethinks: 0 });
    const saved = store.loadGame(end.gameId)!;
    expect(saved.heuristics).toEqual({});
    expect(saved.takenBack![0]!.heuristic).toBe("opening");
    // The move that replaced it is the learner's second try.
    expect(saved.moves[0]!.assist).toEqual(["retry"]);
    expect(store.loadProfile().recentMistakes).toMatchObject([{ moveNumber: 1, category: "opening", takenBack: 0 }]);
    await flush(10);
    const problem = store.loadProblems().find((p) => p.kind === "game");
    expect(problem?.source).toEqual({ gameId: end.gameId, moveNumber: 1, played: "C3", takenBack: 0 });
  });

  it("estimates the rank from the unassisted moves after a game of 10+ moves, then updates the rating and the next bot", async () => {
    await startGame();
    // The human-SL policy finds every move likeliest at 10k (and a little less likely each rank away).
    engine.humanPolicy = (pos, profile) => {
      const n = pos.size * pos.size + 1;
      const rank = Number(/rank_(\d+)k/.exec(profile)?.[1] ?? 0);
      return new Array(n).fill(1 / n).map((p) => p * Math.exp(-Math.abs(rank - 10) / 10));
    };
    for (let i = 0; i < 10; i++) {
      ctl.play({ x: i % 9, y: 8 - Math.floor(i / 9) });
      await flush();
    }
    await ctl.handleAction({ type: "resign" });
    const end = events.find((e) => e.type === "game_end");
    if (end?.type !== "game_end") throw new Error("expected game_end");
    // game_end doesn't wait for the estimate.
    expect(end.summary.rating).toEqual({ before: 10, after: 10, rated: true, pending: true, nextBotRank: "20k", nextHandicap: 0 });
    expect(store.loadProfile().estimating).toEqual([end.gameId]);
    const version = ctl.view().profileVersion;
    await ctl.ratingIdle();
    // Human moves 5, 7, …, 19 count (the first two are the opening): 8 moves, fit at 10k (20).
    const estimate = { rating: 20, floor: false, moves: 8, hints: 0, takeBacks: 0, rethinks: 0 };
    const after = Math.round((0.8 * 20 + 0.2 * 8.5) * 100) / 100;
    const change = { before: 10, after, rated: true, nextBotRank: "12k", nextHandicap: 0, estimate };
    expect(events.at(-1)).toEqual({ type: "rating", gameId: end.gameId, rating: change });
    const profile = store.loadProfile();
    expect(profile.rating).toBe(after);
    expect(profile.estimating).toBeUndefined();
    expect(profile.ratingHistory).toEqual([{ ts: clock.now(), gameId: end.gameId, rating: after, botRank: "20k", won: false, handicap: 0, delta: round2(after - 10), estimate }]);
    expect(ctl.view().profileVersion).toBeGreaterThan(version);
    ctl.flush();
    expect(store.loadGame(end.gameId)!.summary!.rating).toEqual(change);
    // One one-visit policy query per counted move and profile, below the game's queries in priority.
    const policyCalls = engine.analyzeCalls.filter((c) => c.opts?.overrideSettings?.humanSLProfile);
    expect(policyCalls).toHaveLength(8 * 13);
    expect(policyCalls.every((c) => c.opts?.maxVisits === 1 && c.opts.includePolicy && (c.opts.priority ?? 0) < 0)).toBe(true);
  });

  /** Ten human moves, then resign: a rated game with 8 unassisted moves past the opening. */
  async function ratedGame(): Promise<string> {
    await startGame();
    for (let i = 0; i < 10; i++) {
      ctl.play({ x: i % 9, y: 8 - Math.floor(i / 9) });
      await flush();
    }
    return ctl.view().gameId!;
  }

  it("without KataGo the game waits for its estimate, on disk, and gets it when KataGo is ready", async () => {
    const gameId = await ratedGame();
    ctl.setEngineState("failed");
    await ctl.handleAction({ type: "resign" });
    await ctl.ratingIdle();
    // Not rated from the result alone: it waits.
    let profile = store.loadProfile();
    expect(profile).toMatchObject({ rating: 10, ratingHistory: [], estimating: [gameId] });
    expect(store.loadGame(gameId)!.summary!.rating).toMatchObject({ pending: true });
    expect(events.some((e) => e.type === "rating")).toBe(false);
    // A restart: the next controller runs it once KataGo is ready.
    const again = new GameController({ engine, store, clock, botDelayMs: 0 });
    again.onEvent((e) => events.push(e));
    again.setEngineState("ready");
    await again.migrateRatings();
    await again.ratingIdle();
    profile = store.loadProfile();
    expect(profile.estimating).toBeUndefined();
    expect(profile.ratingHistory).toMatchObject([{ gameId, estimate: { moves: 8 } }]);
    expect(store.loadGame(gameId)!.summary!.rating).toMatchObject({ rated: true, estimate: { moves: 8 } });
    expect(events.at(-1)).toMatchObject({ type: "rating", gameId });
  });

  it("keeps a game waiting when KataGo fails its estimate, and later games wait behind it in order", async () => {
    const logs: string[] = [];
    ctl = new GameController({ engine, store, clock, botDelayMs: 0, log: (m) => logs.push(m) });
    ctl.onEvent((e) => events.push(e));
    ctl.setEngineState("ready");
    const first = await ratedGame();
    engine.failAnalyze = true;
    await ctl.handleAction({ type: "resign" });
    await ctl.ratingIdle();
    expect(store.loadProfile()).toMatchObject({ rating: 10, ratingHistory: [], estimating: [first] });
    expect(logs).toContainEqual(expect.stringMatching(/rank estimate for .* failed: fake analysis failure; it runs again/));
    // KataGo answers again: the next game's end runs both, the older one first.
    engine.failAnalyze = false;
    clock.advance(60_000);
    const second = await ratedGame();
    expect(store.loadProfile().estimating).toEqual([first]);
    await ctl.handleAction({ type: "resign" });
    await ctl.ratingIdle();
    const profile = store.loadProfile();
    expect(profile.estimating).toBeUndefined();
    expect(profile.ratingHistory.map((e) => [e.gameId, e.estimate?.moves])).toEqual([
      [first, 8],
      [second, 8],
    ]);
  });

  it("gives the learner the profile's handicap stones on 9x9 unless the game picks its own bot", async () => {
    store.saveProfile({ ...store.loadProfile(), rating: 7, botRank: "20k", handicap: 2 });
    ctl = new GameController({ engine, store, clock, botDelayMs: 0 });
    ctl.setEngineState("ready");
    ctl.newGame();
    expect(ctl.view().settings).toEqual({ size: 9, komi: 0.5, humanColor: "B", botRank: "20k", handicap: 2 });
    expect(ctl.view().chat.at(-1)!.text).toMatch(/2 handicap stones.*weakest one KataGo has/);
    ctl.newGame({ botRank: "18k" });
    expect(ctl.view().settings).toMatchObject({ komi: 7, botRank: "18k", handicap: 0 });
    ctl.newGame({ size: 13 });
    expect(ctl.view().settings).toMatchObject({ size: 13, komi: 7, handicap: 0 });
    ctl.newGame({ humanColor: "W" });
    expect(ctl.view().settings).toMatchObject({ humanColor: "W", handicap: 0 });
    await flush();
  });
});

describe("GameController view contract", () => {
  beforeEach(() => setup());
  const ALWAYS = ["new_game", "chat", "next_problem", "set_tutor_level", "set_judge_mode"];

  it("lists the actions it accepts, with the same checks the actions make", async () => {
    expect(ctl.view().allowed).toEqual([...ALWAYS]);
    await startGame();
    expect(ctl.view().allowed).toEqual([...ALWAYS, "resign", "play", "pass", "ask_tutor"]);
    engine.lossAfter(["C3"], 6);
    ctl.play(C3);
    expect(ctl.view().allowed).not.toContain("play"); // the bot is to move while the eval runs
    await flush();
    expect(ctl.view().status).toBe("paused");
    expect(ctl.view().allowed).toEqual([...ALWAYS, "clear_overlay", "resign", "continue", "retry", "take_back"]); // KataGo's line is drawn
    await ctl.handleAction({ type: "next_problem" });
    expect(ctl.view().allowed).toEqual([...ALWAYS, "leave_problem", "play"]);
    await ctl.handleAction({ type: "leave_problem" });
    await ctl.handleAction({ type: "resign" });
    expect(ctl.view().allowed).toEqual([...ALWAYS]);
  });

  it("hands out a fresh allowed list each time, so changing one can't change the next view", async () => {
    const first = ctl.view().allowed;
    first.push("resign");
    expect(ctl.view().allowed).toEqual([...ALWAYS]);
    await startGame();
    await ctl.handleAction({ type: "resign" });
    ctl.view().allowed.length = 0;
    expect(ctl.view().allowed).toEqual([...ALWAYS]);
  });

  it("stops offering Try again once a rethink took the moment's move back", async () => {
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 6);
    ctl.play(C3);
    await flush();
    expect(ctl.view().allowed).toContain("retry");
    await ctl.handleTutor({ type: "rethink", text: "Look again." });
    expect(ctl.view().allowed).not.toContain("retry");
    expect(ctl.view().allowed).toContain("play");
  });

  it("bumps profileVersion whenever the profile changes", async () => {
    await startGame();
    const v0 = ctl.view().profileVersion;
    engine.lossAfter(["C3"], 6);
    ctl.play(C3);
    await flush();
    await ctl.handleTutor({ type: "tag", gameId: ctl.view().gameId!, moveNumber: 1, category: "shape" });
    expect(ctl.view().profileVersion).toBe(v0 + 1);
    await ctl.handleAction({ type: "resign" });
    expect(ctl.view().profileVersion).toBe(v0 + 2);
    expect(ctl.currentProfile).toEqual(store.loadProfile());
  });

  it("puts the board size on events with coordinates", async () => {
    setup({ tutor: true });
    ctl.newGame({ size: 13 });
    await flush();
    engine.lossAfter(["C3"], 6);
    ctl.play({ x: 2, y: 10 });
    await flush();
    await ctl.handleAction({ type: "continue" });
    await flush();
    await ctl.handleAction({ type: "ask_tutor" });
    const sized = events.filter((e) => e.type === "move" || e.type === "teaching_moment" || e.type === "hint_request");
    expect(sized.map((e) => e.type)).toEqual(["move", "teaching_moment", "move", "hint_request"]);
    expect(sized.every((e) => "size" in e && e.size === 13)).toBe(true);
  });

  it("keeps the analysis cache bounded and serves the current position from it", async () => {
    await startGame();
    for (let i = 0; i < 12; i++) {
      ctl.play({ x: i % 9, y: 8 - Math.floor(i / 9) });
      await flush();
    }
    const calls = engine.analyzeCalls.length;
    await ctl.handleAction({ type: "ask_tutor" });
    expect(engine.analyzeCalls).toHaveLength(calls);
    expect((ctl as unknown as { analyses: Map<string, unknown> }).analyses.size).toBeLessThanOrEqual(16);
  });
});

describe("GameController tutor levels", () => {
  beforeEach(() => setup({ tutor: true }));

  it("defaults to coach, persists a change in the profile and tells the tutor and the learner", async () => {
    await startGame();
    expect(ctl.view().tutorLevel).toBe("coach");
    expect(events[0]).toMatchObject({ type: "game_start", tutorLevel: "coach" });
    const version = ctl.view().profileVersion;
    await ctl.handleAction({ type: "set_tutor_level", level: "point_out" });
    expect(ctl.view().tutorLevel).toBe("point_out");
    expect(ctl.view().profileVersion).toBe(version + 1);
    expect(store.loadProfile().tutorLevel).toBe("point_out");
    expect(events.at(-1)).toEqual({ type: "tutor_level", level: "point_out", gameId: ctl.view().gameId });
    expect(ctl.view().chat.at(-1)?.text).toMatch(/^Tutor help: Point out\./);
    // The same level again changes nothing.
    const count = events.length;
    await ctl.handleAction({ type: "set_tutor_level", level: "point_out" });
    expect(events).toHaveLength(count);
    // A new controller (a restart) reads it back.
    expect(new GameController({ engine, store, clock }).view().tutorLevel).toBe("point_out");
  });

  it("silent: no pause, moment or KataGo message, but the mistake is still recorded", async () => {
    await ctl.handleAction({ type: "set_tutor_level", level: "silent" });
    await startGame();
    engine.lossAfter(["C3"], 8);
    const chatBefore = ctl.view().chat.length;
    ctl.play(C3);
    await flush();
    const v = ctl.view();
    expect(v.status).toBe("playing");
    expect(v.moment).toBeNull();
    expect(v.overlay).toBeNull();
    expect(v.moves).toHaveLength(2); // the bot replied
    expect(v.moves[0]!.eval?.pointLoss).toBe(8);
    expect(types()).not.toContain("teaching_moment");
    expect(types()).not.toContain("fallback");
    expect(v.chat.slice(chatBefore)).toEqual([]);
    clock.advance(60_000);
    expect(ctl.view().chat.slice(chatBefore)).toEqual([]);
    await ctl.handleAction({ type: "resign" });
    const end = events.find((e) => e.type === "game_end");
    expect(end?.type === "game_end" && end.summary.mistakes).toEqual([expect.objectContaining({ moveNumber: 1, pointLoss: 8, move: "C3" })]);
    expect(store.loadProfile().recentMistakes).toEqual([expect.objectContaining({ moveNumber: 1, pointLoss: 8 })]);
  });

  it("silent without a tutor: no fallback either", async () => {
    setup();
    await ctl.handleAction({ type: "set_tutor_level", level: "silent" });
    await startGame();
    engine.lossAfter(["C3"], 8);
    ctl.play(C3);
    await flush();
    expect(ctl.view().status).toBe("playing");
    expect(ctl.view().overlay).toBeNull();
    expect(types()).not.toContain("fallback");
  });

  it("silent: the tutor only answers the learner's question or hint during the game, and everything works after it", async () => {
    await ctl.handleAction({ type: "set_tutor_level", level: "silent" });
    await startGame();
    await expect(ctl.handleTutor({ type: "say", text: "Nice move!" })).rejects.toThrow(/chose Silent.*USER or HINT/);
    await expect(ctl.handleTutor({ type: "show", moves: ["E5"] })).rejects.toThrow(/chose Silent: no show/);
    await expect(ctl.handleTutor({ type: "mark", points: ["E5"] })).rejects.toThrow(/chose Silent: no mark/);
    await ctl.handleAction({ type: "chat", text: "Where should I play?" });
    await ctl.handleTutor({ type: "say", text: "Look at the biggest open area." });
    expect(ctl.view().chat.at(-1)).toMatchObject({ from: "tutor", text: "Look at the biggest open area." });
    await expect(ctl.handleTutor({ type: "say", text: "And another thing" })).rejects.toThrow(/Silent/);
    // A hint is an explicit question too, and hints still work.
    await ctl.handleAction({ type: "ask_tutor" });
    expect(types()).toContain("hint_request");
    await ctl.handleTutor({ type: "say", text: "Think about the corners." });
    // After the game the review is open.
    await ctl.handleAction({ type: "resign" });
    await ctl.handleTutor({ type: "say", text: "Let's review." });
    await ctl.handleTutor({ type: "show", moves: ["E5"] });
    expect(ctl.view().overlay?.variation).toBeDefined();
  });

  it("silent applies from the next move: a mistake played before the switch still opens its moment", async () => {
    await startGame();
    engine.lossAfter(["C3"], 8);
    engine.hold = true;
    ctl.play(C3);
    await ctl.handleAction({ type: "set_tutor_level", level: "silent" });
    engine.releaseAll();
    await flush();
    expect(ctl.view().status).toBe("paused");
    // The moment carries the level its move was played at, not the one picked since.
    expect(events.find((e) => e.type === "teaching_moment")).toMatchObject({ tutorLevel: "coach", moment: { level: "coach" } });
    expect(ctl.view().moves[0]!.tutorLevel).toBe("coach");
    // That moment can still be finished by the tutor.
    await ctl.handleTutor({ type: "say", text: "Look at C3 again." });
    expect(ctl.view().moment?.state).toBe("tutor");
  });

  it("point_out: the moment opens as usual, but rethink is refused; the learner's Try again still works", async () => {
    await ctl.handleAction({ type: "set_tutor_level", level: "point_out" });
    await startGame();
    engine.lossAfter(["C3"], 8);
    ctl.play(C3);
    await flush();
    expect(ctl.view().status).toBe("paused");
    expect(events.find((e) => e.type === "teaching_moment")).toMatchObject({ tutorLevel: "point_out" });
    await expect(ctl.handleTutor({ type: "rethink", text: "Try again." })).rejects.toThrow(
      "The learner chose Point out: explain, don't take moves back.",
    );
    expect(ctl.view().moves).toHaveLength(1);
    await ctl.handleTutor({ type: "show", moves: ["E5"], label: "better" });
    await ctl.handleAction({ type: "retry" });
    expect(ctl.view().moves).toHaveLength(0);
    expect(ctl.view().status).toBe("playing");
  });

  it("rethink follows the level of the moment's move, not a later switch", async () => {
    // A Point out moment stays Point out after a switch to Coach...
    await ctl.handleAction({ type: "set_tutor_level", level: "point_out" });
    await startGame();
    engine.lossAfter(["C3"], 8);
    ctl.play(C3);
    await flush();
    await ctl.handleAction({ type: "set_tutor_level", level: "coach" });
    await expect(ctl.handleTutor({ type: "rethink", text: "Try again." })).rejects.toThrow(/chose Point out/);
    // ...and a Coach moment can still be taken back after a switch to Point out.
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 8);
    ctl.play(C3);
    await flush();
    await ctl.handleAction({ type: "set_tutor_level", level: "point_out" });
    await ctl.handleTutor({ type: "rethink", text: "Which group is weak?" });
    expect(ctl.view().moves).toHaveLength(0);
  });

  it("after a restart, a due moment follows the level its move was played at, not the current one", async () => {
    // Played on Coach, the level is Silent by the restart: the moment still opens.
    await startGame();
    engine.lossAfter(["C3"], 8);
    ctl.play(C3);
    await flush();
    expect(ctl.view().status).toBe("paused");
    await ctl.handleAction({ type: "set_tutor_level", level: "silent" });
    ctl.flush();
    let again = new GameController({ engine, store, clock, botDelayMs: 0 });
    again.restoreLastGame();
    again.setEngineState("ready");
    await flush();
    expect(again.view().status).toBe("paused");
    expect(again.view().moment).toMatchObject({ moveNumber: 1, level: "coach" });

    // Played on Silent (the eval lands after the restart), the level is Coach by then: no moment.
    setup({ tutor: true });
    await ctl.handleAction({ type: "set_tutor_level", level: "silent" });
    await startGame();
    engine.hold = true;
    engine.lossAfter(["C3"], 8);
    ctl.play(C3);
    engine.held.length = 0;
    engine.hold = false;
    await ctl.handleAction({ type: "set_tutor_level", level: "coach" });
    ctl.flush();
    again = new GameController({ engine, store, clock, botDelayMs: 0 });
    again.restoreLastGame();
    again.setEngineState("ready");
    await flush();
    expect(again.view().moves[0]).toMatchObject({ tutorLevel: "silent", eval: { pointLoss: 8 } });
    expect(again.view().moment).toBeNull();
    expect(again.view().status).toBe("playing");
    expect(again.view().moves).toHaveLength(2); // the bot replied
  });

  it("silent: a question opens one say only once it reached the tutor, and only in this game", async () => {
    // A hint KataGo answered (no tutor attached) leaves nothing for a tutor who attaches later.
    setup();
    await ctl.handleAction({ type: "set_tutor_level", level: "silent" });
    await startGame();
    await ctl.handleAction({ type: "ask_tutor" });
    await flush();
    ctl.setTutorAttached(true);
    await expect(ctl.handleTutor({ type: "say", text: "Look at the corner." })).rejects.toThrow(/chose Silent/);
    // Nor does a chat message nobody received.
    ctl.setTutorAttached(false);
    await ctl.handleAction({ type: "chat", text: "Anyone there?" });
    ctl.setTutorAttached(true);
    await expect(ctl.handleTutor({ type: "say", text: "Yes!" })).rejects.toThrow(/chose Silent/);
    // An unanswered question doesn't carry over to a new game...
    await ctl.handleAction({ type: "chat", text: "Where now?" });
    await startGame();
    await expect(ctl.handleTutor({ type: "say", text: "Here." })).rejects.toThrow(/chose Silent/);
    // ...nor from a problem back to the game.
    await ctl.handleAction({ type: "next_problem" });
    await ctl.handleAction({ type: "chat", text: "Is it the eye?" });
    await ctl.handleAction({ type: "leave_problem" });
    await expect(ctl.handleTutor({ type: "say", text: "Yes, the eye." })).rejects.toThrow(/chose Silent/);
  });

  it("silent: a question asked before a restart still gets its one answer after it", async () => {
    setup({ tutor: true });
    await ctl.handleAction({ type: "set_tutor_level", level: "silent" });
    await startGame();
    await ctl.handleAction({ type: "ask_tutor", text: "Where now?" });
    ctl.flush();
    const again = new GameController({ engine: new FakeEngine(), store, clock, botDelayMs: 0 });
    expect(again.restoreLastGame()).toBe(true);
    again.setEngineState("ready");
    again.setTutorAttached(true);
    await again.handleTutor({ type: "say", text: "Look at the corner." });
    await expect(again.handleTutor({ type: "say", text: "And the side." })).rejects.toThrow(/chose Silent/);
    again.play(D4);
    await flush();
    expect(again.view().moves[0]!.assist).toEqual(["hint"]);
    again.flush();
    expect(store.loadGame(again.view().gameId!)!.questionOpen).toBeUndefined();
  });
});

describe("GameController take-backs and help", () => {
  beforeEach(() => setup());

  it("Take back removes the learner's last move and the bot's reply on their turn, at every tutor level", async () => {
    await startGame();
    engine.botMoves = ["G7"];
    ctl.play(E5);
    await flush();
    expect(ctl.view().moves).toHaveLength(2);
    expect(ctl.view().allowed).toContain("take_back");
    await ctl.handleAction({ type: "set_tutor_level", level: "silent" });
    await ctl.handleAction({ type: "take_back" });
    const v = ctl.view();
    expect(v.moves).toHaveLength(0);
    expect(v.toPlay).toBe("B");
    expect(events.at(-1)).toEqual({ type: "undo", gameId: v.gameId, moves: 0, toPlay: "B", by: "human" });
    // Nothing left to take back.
    expect(v.allowed).not.toContain("take_back");
    await expect(ctl.handleAction({ type: "take_back" })).rejects.toThrow(/no move of yours/);
    // The replacement is the learner's second try; the first attempt is kept.
    engine.hold = true;
    ctl.play(D4);
    expect(ctl.view().moves[0]!.assist).toEqual(["retry"]);
    ctl.flush();
    expect(store.loadGame(v.gameId!)!.takenBack).toMatchObject([{ moveNumber: 1, by: "human", record: { move: { color: "B", point: E5 } } }]);
  });

  it("Take back waits while the move is evaluated or the bot is thinking", async () => {
    await startGame();
    engine.hold = true;
    ctl.play(E5);
    expect(ctl.view().allowed).not.toContain("take_back");
    await expect(ctl.handleAction({ type: "take_back" })).rejects.toThrow(/Wait for the bot/);
    expect(ctl.view().allowed).toContain("retry"); // Try again's rule is unchanged
  });

  it("Take back goes further back than a move the tutor already took back", async () => {
    setup({ tutor: true });
    await startGame();
    engine.botMoves = ["G7"];
    ctl.play(D4);
    await flush();
    engine.lossAfter(["D4", "G7", "C3"], 6);
    ctl.play(C3);
    await flush();
    await ctl.handleTutor({ type: "rethink", text: "Look again." });
    expect(ctl.view().moves).toHaveLength(2);
    expect(ctl.view().allowed).not.toContain("retry");
    expect(ctl.view().allowed).toContain("take_back");
    await ctl.handleAction({ type: "take_back" });
    expect(ctl.view().moves).toHaveLength(0);
    expect(ctl.view().moment?.state).toBe("resolved");
    ctl.flush();
    const saved = store.loadGame(ctl.view().gameId!)!;
    expect(saved.takenBack!.map((t) => [t.moveNumber, t.by, t.before])).toEqual([
      [3, "tutor", ["D4", "G7"]],
      [1, "human", []],
    ]);
    expect(saved.assistance).toEqual({ hints: 0, takeBacks: 1, rethinks: 1 });
  });

  it("doesn't count a hint KataGo can't give yet", async () => {
    ctl.setEngineState("starting");
    await startGame();
    await expect(ctl.handleAction({ type: "ask_tutor", text: "help" })).rejects.toThrow(/still starting/);
    expect(types()).not.toContain("hint_request");
    expect(ctl.view().chat.some((m) => m.from === "user")).toBe(false);
    ctl.flush();
    expect(store.loadGame(ctl.view().gameId!)!.assistance).toEqual({ hints: 0, takeBacks: 0, rethinks: 0 });
  });

  it("marks a move played after KataGo's hint as hinted and shown, only in that position", async () => {
    await startGame();
    engine.botMoves = ["G7"];
    await ctl.handleAction({ type: "ask_tutor", text: "where?" });
    expect(ctl.view().chat.map((m) => m.from)).toContain("user");
    expect(ctl.view().overlay?.marks).toHaveLength(1);
    ctl.play(D4);
    await flush();
    expect(ctl.view().moves[0]!.assist).toEqual(["hint", "shown"]);
    ctl.play(C3);
    await flush();
    expect(ctl.view().moves[2]!.assist).toBeUndefined();
    ctl.flush();
    expect(store.loadGame(ctl.view().gameId!)!.assistance).toEqual({ hints: 1, takeBacks: 0, rethinks: 0 });
  });

  it("marks a move hinted once the tutor answers the hint, and shown after a drawing", async () => {
    setup({ tutor: true });
    await startGame();
    engine.botMoves = ["G7", "G3", "C7"];
    await ctl.handleAction({ type: "ask_tutor" });
    ctl.play(E5); // asked, but the tutor never answered: no help
    await flush();
    expect(ctl.view().moves[0]!.assist).toBeUndefined();
    await ctl.handleAction({ type: "ask_tutor" });
    await ctl.handleTutor({ type: "say", text: "Which corner is open?" });
    ctl.play(D4);
    await flush();
    expect(ctl.view().moves[2]!.assist).toEqual(["hint"]);
    // A drawing on the learner's turn, hidden before they play, still helped.
    await ctl.handleTutor({ type: "mark", points: ["C3"] });
    await ctl.handleAction({ type: "clear_overlay" });
    ctl.play(C3);
    await flush();
    expect(ctl.view().moves[4]!.assist).toEqual(["shown"]);
  });

  it("marks the move after a rethink, and the help survives a restart", async () => {
    setup({ tutor: true });
    await startGame();
    engine.lossAfter(["C3"], 6);
    ctl.play(C3);
    await flush();
    await ctl.handleTutor({ type: "rethink", text: "Look again." });
    await ctl.handleTutor({ type: "show", moves: ["E5"] });
    engine.hold = true;
    ctl.play(D4);
    expect(ctl.view().moves[0]!.assist).toEqual(["rethink", "shown"]);
    ctl.flush();
    const restored = new GameController({ engine: new FakeEngine(), store, clock, botDelayMs: 0 });
    expect(restored.restoreLastGame()).toBe(true);
    expect(restored.view().moves[0]!.assist).toEqual(["rethink", "shown"]);
    // Ending the restored game keeps the first attempt and the help.
    await restored.handleAction({ type: "resign" });
    const saved = store.lastGame({ finished: true })!;
    expect(saved.takenBack).toHaveLength(1);
    expect(saved.summary!.assistance).toEqual({ hints: 0, takeBacks: 0, rethinks: 1 });
    expect(saved.summary!.mistakes).toMatchObject([{ moveNumber: 1, move: "C3", takenBack: 0 }]);
  });

  it("keeps the help for a move not yet played across a restart, an unanswered hint included", async () => {
    setup({ tutor: true });
    await startGame();
    // A drawing on the learner's turn, then a restart before they play: the move is still "shown".
    await ctl.handleTutor({ type: "mark", points: ["C3"] });
    ctl.flush();
    const restored = new GameController({ engine: new FakeEngine(), store, clock, botDelayMs: 0 });
    expect(restored.restoreLastGame()).toBe(true);
    restored.setEngineState("ready");
    restored.setTutorAttached(true);
    restored.play(D4);
    await flush();
    expect(restored.view().moves[0]!.assist).toEqual(["shown"]);
    // A hint asked before a restart and answered after it still makes the next move hinted.
    await restored.handleAction({ type: "ask_tutor" });
    restored.flush();
    const again = new GameController({ engine: new FakeEngine(), store, clock, botDelayMs: 0 });
    expect(again.restoreLastGame()).toBe(true);
    again.setEngineState("ready");
    again.setTutorAttached(true);
    await again.handleTutor({ type: "say", text: "Look at the corner." });
    again.play(C3);
    await flush();
    expect(again.view().moves[2]!.assist).toEqual(["hint"]);
    again.flush();
    expect(store.loadGame(again.view().gameId!)!.help).toBeUndefined();
  });
});

describe("GameController mistake threshold by board size", () => {
  beforeEach(() => setup());

  // The profile's 4 points is the 9×9 threshold: 6 on 13×13, 8 on 19×19.
  it.each([
    [9, 4],
    [13, 6],
    [19, 8],
  ] as const)("on %i×%i pauses at %i points, and the summary and its problems use that threshold", async (size, threshold) => {
    ctl.newGame({ size });
    await flush();
    expect(ctl.view().mistakeThreshold).toBe(threshold);
    // Exactly the threshold is a teaching moment.
    engine.lossAfter(["C3"], threshold);
    ctl.play({ x: 2, y: size - 3 });
    await flush();
    expect(ctl.view().status).toBe("paused");
    expect(ctl.view().moment).toMatchObject({ moveNumber: 1, pointLoss: threshold });
    // Just under it is not, though on 13×13 and 19×19 that is more than the 9×9 threshold.
    await ctl.handleAction({ type: "retry" });
    engine.lossAfter(["D4"], threshold - 0.5);
    ctl.play({ x: 3, y: size - 4 });
    await flush();
    expect(ctl.view().moves[0]!.eval?.pointLoss).toBe(threshold - 0.5);
    expect(ctl.view().status).toBe("playing");
    expect(types().filter((t) => t === "teaching_moment")).toHaveLength(1);

    await ctl.handleAction({ type: "resign" });
    const end = events.find((e) => e.type === "game_end");
    if (end?.type !== "game_end") throw new Error("expected game_end");
    // The taken-back C3 is a mistake at this board's threshold; D4 isn't.
    expect(end.summary.threshold).toBe(threshold);
    expect(end.summary.mistakes.map((m) => [m.move, m.takenBack])).toEqual([["C3", 0]]);
    expect(store.loadGame(end.gameId)!.summary?.threshold).toBe(threshold);
    // The profile keeps the 9×9 value.
    expect(store.loadProfile().recentGames.at(-1)).toMatchObject({ size, mistakes: 1, threshold: 4 });
    await flush(10);
    const problems = store.loadProblems().filter((p) => p.kind === "game");
    expect(problems.map((p) => p.source)).toEqual([{ gameId: end.gameId, moveNumber: 1, played: "C3", takenBack: 0 }]);
  });

  it("raises the threshold after too many moments on 13×13, and the finished game keeps the one it was played with", async () => {
    ctl.newGame({ size: 13 });
    await flush();
    engine.lossAfter(["C3"], 6);
    // Ten first attempts at C3, each a teaching moment and taken back: more than 9 on 13×13.
    for (let i = 0; i < 10; i++) {
      ctl.play({ x: 2, y: 10 });
      await flush();
      expect(ctl.view().status).toBe("paused");
      await ctl.handleAction({ type: "retry" });
    }
    ctl.play({ x: 3, y: 9 });
    await flush();
    await ctl.handleAction({ type: "resign" });
    const profile = store.loadProfile();
    expect(profile.mistakeThreshold).toBe(4.5);
    expect(profile.thresholdHistory.at(-1)).toMatchObject({ from: 4, to: 4.5, reason: "10 teaching moments in one 13×13 game" });
    expect(ctl.view().mistakeThreshold).toBe(6);
    expect(ctl.view().summary?.mistakes).toHaveLength(10);
    // A problem after the game shows the next game's threshold on the last game's board.
    await ctl.handleAction({ type: "next_problem" });
    expect(ctl.view()).toMatchObject({ mode: "problem", mistakeThreshold: 6.75 });
    expect(ctl.view().summary).toBeUndefined();
    await ctl.handleAction({ type: "leave_problem" });
    // A finished game saved before thresholds scaled by size reports the unscaled one it was played with.
    delete (ctl as unknown as { summary: GameSummary }).summary.threshold;
    expect(ctl.view().mistakeThreshold).toBe(4);
    // The next 13×13 game uses the new 9×9 value, scaled.
    ctl.newGame({ size: 13 });
    await flush();
    expect(ctl.view().mistakeThreshold).toBe(6.75);
    expect(ctl.view().summary).toBeUndefined();
  });

  it("sends the next 9×9 game's threshold before any game", () => {
    expect(ctl.view()).toMatchObject({ mode: "idle", mistakeThreshold: 4 });
  });
});

describe("GameController judging at level", () => {
  beforeEach(() => setup());

  /** A human-SL policy that puts nearly everything on `gtp` (9×9). */
  const policyOn = (gtp: string) => () => {
    const policy = new Array(82).fill(0.001);
    const p = fromGtp(gtp, 9)!;
    policy[p.y * 9 + p.x] = 0.9;
    return policy;
  };

  async function atLevelGame(): Promise<void> {
    await ctl.handleAction({ type: "set_judge_mode", mode: "at_level" });
    await startGame();
  }

  it("defaults to optimal, persists a change and fixes the game's reference rank one above the learner", async () => {
    await startGame();
    expect(ctl.view()).toMatchObject({ judgeMode: "optimal", atLevelRank: "19k" }); // rating 10 = 20k
    expect(events[0]).toMatchObject({ type: "game_start", judgeMode: "optimal", atLevelRank: "19k" });
    await ctl.handleAction({ type: "set_judge_mode", mode: "at_level" });
    expect(store.loadProfile().judgeMode).toBe("at_level");
    expect(events.at(-1)).toEqual({ type: "judge_mode", mode: "at_level", gameId: ctl.view().gameId, atLevelRank: "19k" });
    expect(ctl.view().chat.at(-1)?.text).toMatch(/^Judging moves: At level \(19k\)\./);
    // The rating moving mid-game doesn't move the game's reference rank.
    store.saveProfile({ ...store.loadProfile(), rating: 15 });
    expect(new GameController({ engine, store, clock }).currentProfile.judgeMode).toBe("at_level");
    expect(ctl.view().atLevelRank).toBe("19k");
  });

  it("doesn't pause for a mistake a player one rank up would make too, but still records it against KataGo's best", async () => {
    await atLevelGame();
    engine.humanPolicy = policyOn("D4");
    engine.lossAfter(["C3"], 6); // 6 below KataGo's best
    engine.lossAfter(["D4"], 4.5); // the 19k move is only 1.5 better
    ctl.play(C3);
    await flush();
    const v = ctl.view();
    expect(v.status).toBe("playing");
    expect(v.moment).toBeNull();
    expect(v.moves).toHaveLength(2); // the bot replied
    expect(v.moves[0]).toMatchObject({ judge: "at_level", eval: { pointLoss: 6, atLevel: { rank: "19k", move: "D4", loss: 1.5 } } });
    // The reference comes from one human-SL evaluation at the game's rank, without a search.
    const query = engine.analyzeCalls.find((c) => c.opts?.overrideSettings?.humanSLProfile);
    expect(query?.opts).toMatchObject({ maxVisits: 1, includePolicy: true, overrideSettings: { humanSLProfile: "rank_19k" } });
    // The review, the mistakes and practice problems use KataGo's best.
    await ctl.handleAction({ type: "resign" });
    const end = events.find((e) => e.type === "game_end");
    if (end?.type !== "game_end") throw new Error("expected game_end");
    expect(end.summary.mistakes.map((m) => [m.moveNumber, m.pointLoss, m.bestMove])).toEqual([[1, 6, "E5"]]);
  });

  it("pauses for a move that loses the threshold against the reference move, and the fallback shows that move's line", async () => {
    await atLevelGame();
    engine.humanPolicy = policyOn("D4");
    engine.lossAfter(["C3"], 8);
    engine.lossAfter(["D4"], 3);
    engine.lines.set("D4", { best: "E5", pv: ["E5", "D5"] });
    ctl.play(C3);
    await flush();
    const v = ctl.view();
    expect(v.status).toBe("paused");
    expect(v.moment).toMatchObject({ moveNumber: 1, pointLoss: 5, state: "fallback" });
    expect(v.overlay?.variation).toMatchObject({ label: "A 19k's line instead of C3", fromMove: 1 });
    expect(v.overlay?.variation?.moves.map((m) => m.point)).toEqual([D4, E5, { x: 3, y: 4 }]);
    expect(v.overlay?.best).toEqual(D4);
    expect(v.chat.at(-1)!.text).toMatch(/C3 cost about 5 points compared with D4, the move a 19k player would most likely play\./);
  });

  it("records a move better than the reference move as a gain, with nothing judged lost", async () => {
    await atLevelGame();
    engine.humanPolicy = policyOn("D4");
    engine.lossAfter(["C3"], 1);
    engine.lossAfter(["D4"], 3.5);
    ctl.play(C3);
    await flush();
    const [first] = ctl.view().moves;
    expect(first!.eval!.atLevel!.loss).toBe(-2.5);
    expect(judgedLoss(first!)).toBe(0);
  });

  it("applies from the next move: a move keeps the mode it was played in", async () => {
    await startGame();
    engine.humanPolicy = policyOn("D4");
    engine.lossAfter(["C3"], 6);
    engine.lossAfter(["C3", "A9", "D4"], 4.5);
    ctl.play(C3); // optimal: pauses
    await flush();
    expect(ctl.view().moment?.pointLoss).toBe(6);
    await ctl.handleAction({ type: "set_judge_mode", mode: "at_level" });
    expect(ctl.view().moves[0]!.judge).toBe("optimal");
    await ctl.handleAction({ type: "continue" });
    await flush();
    ctl.play(D4);
    await flush();
    expect(ctl.view().moves[2]).toMatchObject({ judge: "at_level", eval: { atLevel: { move: "D4", loss: 0 } } });
  });

  it("falls back to judging against KataGo's best when the reference move can't be had", async () => {
    await atLevelGame();
    engine.humanPolicy = () => {
      throw new Error("no human net");
    };
    engine.lossAfter(["C3"], 6);
    ctl.play(C3);
    await flush();
    const v = ctl.view();
    expect(v.moves[0]!.eval).toMatchObject({ pointLoss: 6 });
    expect(v.moves[0]!.eval!.atLevel).toBeUndefined();
    expect(v.moment).toMatchObject({ pointLoss: 6 });
    expect(v.chat.some((m) => /couldn't compare move 1 with a 19k's move/.test(m.text))).toBe(true);
  });

  it("restores the game's reference rank and each move's mode after a restart", async () => {
    await atLevelGame();
    engine.humanPolicy = policyOn("D4");
    ctl.play(C3);
    await flush();
    ctl.flush();
    store.saveProfile({ ...store.loadProfile(), rating: 15 });
    const again = new GameController({ engine, store, clock, botDelayMs: 0 });
    expect(again.restoreLastGame()).toBe(true);
    expect(again.view().atLevelRank).toBe("19k");
    expect(again.view().moves[0]!.judge).toBe("at_level");
  });
});
