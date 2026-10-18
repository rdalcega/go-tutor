// Problem mode in the GameController: starting problems, judging attempts, spaced repetition,
// the profile, problem generation at game end, and returning to the game.
import { beforeEach, describe, expect, it } from "vitest";
import type { TutorEventInput } from "../../src/server/common.ts";
import { GameController } from "../../src/server/game.ts";
import { BOX_INTERVALS, DEEP_VISITS, gameSource } from "../../src/server/problems.ts";
import type { Store } from "../../src/server/store.ts";
import { fromGtp } from "../../src/shared/coords.ts";
import { FakeClock, FakeEngine, flush, liveProblem, seedProblems, tempStore } from "./fakes.ts";

// A generated problem: Black lives with E1 (D1, F1 are the wrong eye points).
const LIVE = "gen1";
const at = (gtp: string) => fromGtp(gtp, 9)!;

let engine: FakeEngine;
let clock: FakeClock;
let store: Store;
let events: TutorEventInput[];
let ctl: GameController;

function setup(): void {
  engine = new FakeEngine();
  clock = new FakeClock();
  store = tempStore();
  // Two generated problems (the same position under another hash stands in for a second one).
  seedProblems(store, [liveProblem(), liveProblem({ id: "gen2", category: "tactics", hash: "second" })]);
  events = [];
  ctl = new GameController({ engine, store, clock, botDelayMs: 0, tutorTimeoutMs: 30_000 });
  ctl.onEvent((e) => events.push(e));
  ctl.setEngineState("ready");
  // KataGo's best in the problem position is E1; after the learner's E1, White's best reply is D8.
  engine.lines.set("", { best: "E1", pv: ["E1", "D8", "E8"] });
  engine.lines.set("E1", { best: "D8", pv: ["D8", "E8", "F8"] });
}

const ofType = <T extends TutorEventInput["type"]>(type: T) => events.filter((e): e is Extract<TutorEventInput, { type: T }> => e.type === type);
const stored = (id: string) => store.loadProblems().find((p) => p.id === id)!;

async function startLive(): Promise<void> {
  await ctl.handleTutor({ type: "start_problem", problemId: LIVE });
  await flush();
}

describe("problem mode", () => {
  beforeEach(() => setup());

  it("starts the next due problem in the focus category and shows it as a problem view", async () => {
    await ctl.handleAction({ type: "next_problem" });
    const v = ctl.view();
    // No mistakes yet: the focus is life and death, and generated problems are all that exists.
    expect(v.mode).toBe("problem");
    expect(v.gameId).toBeNull();
    expect(v.status).toBe("playing");
    expect(v.problem).toMatchObject({ kind: "generated", category: "life_and_death", attempts: 0, maxAttempts: 2, revealed: false, solved: false, box: 1 });
    expect(v.problem?.generated).toEqual({ batchId: "batch1", difficultyRank: "17k", weakerRank: "20k", strongerRank: "15k" });
    expect(v.settings?.humanColor).toBe(v.problem!.toPlay);
    expect(v.board.flat().filter(Boolean).length).toBeGreaterThan(10);
    const start = ofType("problem_start")[0]!;
    expect(start).toMatchObject({ problemId: v.problem!.id, category: "life_and_death", toPlay: "B", kind: "generated", size: 9, generated: { difficultyRank: "17k" } });
    expect(v.chat.at(-1)?.text).toContain("Practice problem on 9×9 (about 17k level)");
    expect(start.answers.length).toBeGreaterThan(0);
    expect(start.board).toContain("X");
    expect(v.chat.at(-1)?.text).toContain(v.problem!.prompt);
    // Next problem moves on to a different one.
    await ctl.handleAction({ type: "next_problem" });
    expect(ctl.view().problem!.id).not.toBe(v.problem!.id);
  });

  it("accepts a known answer on the first try: solved, box up, the follow-up drawn, profile updated", async () => {
    await startLive();
    await ctl.handleAction({ type: "play", point: at("E1") });
    expect(ctl.view().engineBusy).toBe(true);
    await flush();
    const v = ctl.view();
    expect(v.status).toBe("finished");
    expect(v.problem).toMatchObject({ attempts: 1, solved: true, revealed: true, lastAttempt: { move: "E1", correct: true, pointLoss: 0 }, answer: { move: "E1" } });
    // The answer, the opponent's best reply and the next move.
    expect(v.overlay?.variation?.moves).toEqual([
      { color: "B", point: at("E1") },
      { color: "W", point: at("D8") },
      { color: "B", point: at("E8") },
    ]);
    expect(ofType("problem_attempt")).toEqual([
      expect.objectContaining({ problemId: LIVE, move: "E1", correct: true, firstTry: true, attempt: 1, revealed: true, category: "life_and_death", bestMove: "E1" }),
    ]);
    expect(stored(LIVE)).toMatchObject({ box: 2, seen: 1, solves: 1, lastResult: "first_try", due: clock.now() + BOX_INTERVALS[2]! });
    const profile = store.loadProfile();
    expect(profile.problemsSolved).toBe(1);
    expect(profile.practiced.life_and_death).toBe(0);
    await expect(ctl.handleAction({ type: "play", point: at("F1") })).rejects.toThrow(/problem is over/);
  });

  it("gives a second attempt after a wrong move, then shows KataGo's answer and sends the problem to box 1", async () => {
    engine.lossAfter(["D1"], 19.3);
    engine.lossAfter(["F1"], 18.7);
    await startLive();
    await ctl.handleAction({ type: "play", point: at("D1") });
    await flush();
    let v = ctl.view();
    expect(v.status).toBe("playing");
    expect(v.problem).toMatchObject({ attempts: 1, revealed: false, lastAttempt: { move: "D1", correct: false, pointLoss: 19.3 } });
    expect(v.problem!.answer).toBeUndefined();
    expect(v.overlay).toEqual({ marks: [{ point: at("D1"), kind: "x" }] });
    expect(v.chat.at(-1)?.text).toBe("D1 isn't it: it loses about 19.3 points. Try again (1 attempt left).");

    await ctl.handleAction({ type: "play", point: at("F1") });
    await flush();
    v = ctl.view();
    expect(v.status).toBe("finished");
    expect(v.problem).toMatchObject({ attempts: 2, revealed: true, solved: false, answer: { move: "E1", pv: ["E1", "D8", "E8"] } });
    expect(v.overlay?.variation?.moves.map((m) => m.point)).toEqual([at("E1"), at("D8"), at("E8")]);
    expect(v.overlay?.marks).toEqual([{ point: at("F1"), kind: "x" }]);
    expect(ofType("problem_attempt").map((e) => [e.move, e.correct, e.revealed, e.firstTry])).toEqual([
      ["D1", false, false, false],
      ["F1", false, true, false],
    ]);
    expect(stored(LIVE)).toMatchObject({ box: 1, seen: 1, solves: 0, lastResult: "failed", due: clock.now() + BOX_INTERVALS[1]! });
    const profile = store.loadProfile();
    expect(profile.problemsSolved).toBe(0);
    expect(profile.practiced.life_and_death).toBe(0);
  });

  it("says when a finished problem comes back, and next_problem brings a failed one back once it is due", async () => {
    // Everything else waits a day, so only the failed problem can come due.
    const problems = store.loadProblems();
    for (const p of problems) if (p.id !== LIVE) p.due = clock.now() + 24 * 3_600_000;
    store.saveProblems(problems);
    engine.lossAfter(["D1"], 19);
    engine.lossAfter(["F1"], 18);
    await startLive();
    expect(ctl.view().problem?.nextDue).toBeUndefined();
    await ctl.handleAction({ type: "play", point: at("D1") });
    await flush();
    expect(ctl.view().problem?.nextDue).toBeUndefined(); // not over yet
    await ctl.handleAction({ type: "play", point: at("F1") });
    await flush();
    const failedAt = clock.now();
    expect(ctl.view().problem).toMatchObject({ revealed: true, solved: false, nextDue: failedAt + BOX_INTERVALS[1]! });

    // Before it is due, Next problem moves on to another one (an early review).
    clock.advance(5 * 60_000);
    await ctl.handleAction({ type: "next_problem" });
    expect(ctl.view().problem?.id).not.toBe(LIVE);
    // Ten minutes after the failure it is due again, and it is the one next_problem picks.
    clock.advance(5 * 60_000);
    await ctl.handleAction({ type: "next_problem" });
    expect(ctl.view().problem).toMatchObject({ id: LIVE, box: 1, attempts: 0 });
    expect(ctl.view().chat.at(-1)?.text).not.toMatch(/early review/);
  });

  it("counts an unexpected move within a point of KataGo's best as correct and keeps it as an answer", async () => {
    engine.lossAfter(["D1"], 19);
    // KataGo searched H8 well in the problem position: 0.6 below its best in that same search.
    engine.candidates.set("", [{ move: "H8", scoreLead: -0.6, visits: 120 }]);
    await startLive();
    await ctl.handleAction({ type: "play", point: at("D1") });
    await flush();
    await ctl.handleAction({ type: "play", point: at("H8") });
    await flush();
    expect(ctl.view().problem).toMatchObject({ solved: true, attempts: 2, lastAttempt: { move: "H8", correct: true, pointLoss: 0.6 } });
    expect(stored(LIVE)).toMatchObject({ lastResult: "solved", box: 1 });
    expect(stored(LIVE).answers).toEqual(["E1", "H8"]);
  });

  it("judges a move KataGo barely searched as correct, but doesn't keep it as an answer", async () => {
    // H8's loss comes from two separate searches (and 10 visits in the first don't count).
    engine.candidates.set("", [{ move: "H8", scoreLead: -0.2, visits: 10 }]);
    engine.lossAfter(["H8"], 0.6);
    await startLive();
    await ctl.handleAction({ type: "play", point: at("H8") });
    await flush();
    expect(ctl.view().problem).toMatchObject({ solved: true, lastAttempt: { move: "H8", correct: true, pointLoss: 0.6 } });
    expect(stored(LIVE)).toMatchObject({ lastResult: "first_try", box: 2 });
    expect(stored(LIVE).answers).toEqual(["E1"]);
  });

  it("counts leaving after a wrong attempt as a failure, and leaving before any attempt as nothing", async () => {
    engine.lossAfter(["D1"], 19);
    await startLive();
    await ctl.handleAction({ type: "leave_problem" });
    expect(stored(LIVE)).toMatchObject({ box: 1, seen: 0, due: 0 });
    expect(stored(LIVE).lastResult).toBeUndefined();

    // Promote it first, so the failure's demotion shows.
    const problems = store.loadProblems();
    problems.find((p) => p.id === LIVE)!.box = 3;
    store.saveProblems(problems);
    for (const leave of [{ type: "leave_problem" }, { type: "next_problem" }] as const) {
      await startLive();
      await ctl.handleAction({ type: "play", point: at("D1") });
      await flush();
      clock.advance(1000);
      await ctl.handleAction(leave);
      expect(stored(LIVE)).toMatchObject({ box: 1, lastResult: "failed", due: clock.now() + BOX_INTERVALS[1]! });
    }
    expect(stored(LIVE).seen).toBe(2);
    expect(store.loadProfile().practiced.life_and_death).toBe(0);

    // A new game ends problem mode the same way; the same problem started again begins in box 1.
    await startLive();
    await ctl.handleAction({ type: "play", point: at("D1") });
    await flush();
    await ctl.handleTutor({ type: "start_problem", problemId: LIVE });
    expect(ctl.view().problem).toMatchObject({ id: LIVE, box: 1, attempts: 0 });
    expect(stored(LIVE).seen).toBe(3);
    await ctl.handleAction({ type: "play", point: at("D1") });
    await flush();
    ctl.newGame();
    expect(stored(LIVE).seen).toBe(4);
  });

  it("finishes a problem even when the profile can't be saved", async () => {
    const logs: string[] = [];
    ctl = new GameController({ engine, store, clock, botDelayMs: 0, log: (m) => logs.push(m) });
    ctl.setEngineState("ready");
    store.saveProfile = () => {
      throw new Error("disk full");
    };
    await startLive();
    await ctl.handleAction({ type: "play", point: at("E1") });
    await flush();
    expect(ctl.view().problem).toMatchObject({ solved: true, revealed: true });
    expect(stored(LIVE)).toMatchObject({ box: 2, lastResult: "first_try" });
    expect(logs).toContainEqual(expect.stringMatching(/updating the profile after problem .* failed: disk full/));
  });

  it("rejects illegal moves and moves while checking without using an attempt", async () => {
    await startLive();
    await expect(ctl.handleAction({ type: "play", point: at("C2") })).rejects.toThrow(/already taken/);
    engine.hold = true;
    await ctl.handleAction({ type: "play", point: at("E1") });
    await expect(ctl.handleAction({ type: "play", point: at("D1") })).rejects.toThrow(/still checking/);
    expect(ctl.view().problem!.attempts).toBe(1);
    engine.releaseAll();
    await flush();
    expect(ctl.view().problem!.solved).toBe(true);
  });

  it("doesn't count an attempt KataGo couldn't check", async () => {
    await startLive();
    engine.failAnalyze = true;
    await ctl.handleAction({ type: "play", point: at("D1") });
    await flush();
    expect(ctl.view().problem).toMatchObject({ attempts: 0, revealed: false });
    expect(ctl.view().chat.at(-1)?.text).toMatch(/KataGo couldn't check D1/);
  });

  it("refuses game-only actions while practicing, and lets the tutor draw on the problem", async () => {
    await startLive();
    await expect(ctl.handleAction({ type: "pass" })).rejects.toThrow(/playing a stone on the board/);
    await expect(ctl.handleAction({ type: "resign" })).rejects.toThrow(/Back to playing/);
    await expect(ctl.handleAction({ type: "ask_tutor" })).rejects.toThrow(/ask your tutor in the chat/);
    await expect(ctl.handleTutor({ type: "rethink", text: "hm" })).rejects.toThrow(/practice problem/);
    await expect(ctl.handleTutor({ type: "start_problem", problemId: "nope" })).rejects.toThrow(/No practice problem "nope"/);
    await ctl.handleTutor({ type: "show", moves: ["E1", "D1"], label: "the eye" });
    await ctl.handleTutor({ type: "mark", points: ["D1", "F1"] });
    expect(ctl.view().overlay).toEqual({
      variation: { label: "the eye", moves: [{ color: "B", point: at("E1") }, { color: "W", point: at("D1") }] },
      marks: [
        { point: at("D1"), kind: "circle" },
        { point: at("F1"), kind: "circle" },
      ],
    });
    await ctl.handleTutor({ type: "say", text: "What shape is the eye space?" });
    expect(ctl.view().chat.at(-1)).toMatchObject({ from: "tutor", text: "What shape is the eye space?" });
    await ctl.handleTutor({ type: "clear" });
    expect(ctl.view().overlay).toBeNull();
  });

  it("keeps the game waiting underneath: the bot doesn't move until the learner goes back", async () => {
    engine.hold = true;
    ctl.newGame({ humanColor: "W" });
    await flush();
    expect(engine.botCalls).toHaveLength(1);
    await ctl.handleAction({ type: "next_problem" });
    engine.releaseAll();
    await flush();
    engine.releaseAll();
    await flush();
    expect(ctl.view().mode).toBe("problem");
    engine.hold = false;
    await ctl.handleAction({ type: "leave_problem" });
    await flush();
    const v = ctl.view();
    expect(v.mode).toBe("game");
    expect(v.moves).toHaveLength(1);
    expect(v.moves[0]!.move.color).toBe("B");
    expect(v.problem).toBeNull();
  });

  it("leaves problem mode for a new game, or for the idle board", async () => {
    await startLive();
    await ctl.handleAction({ type: "leave_problem" });
    expect(ctl.view().mode).toBe("idle");
    await startLive();
    ctl.newGame();
    expect(ctl.view().mode).toBe("game");
  });

  it("still draws the learner's stone when KataGo's reply to a correct answer is a pass", async () => {
    engine.lines.set("E1", { best: "pass", pv: ["pass"] });
    await startLive();
    await ctl.handleAction({ type: "play", point: at("E1") });
    await flush();
    const v = ctl.view();
    expect(v.problem).toMatchObject({ solved: true, lastAttempt: { move: "E1", correct: true } });
    expect(v.overlay).toEqual({ variation: { label: "E1", moves: [{ color: "B", point: at("E1") }] } });
    expect(v.chat.at(-1)?.text).toBe("Correct, first try: E1.");
  });

  it("draws a known answer even when KataGo can't analyze it", async () => {
    await startLive();
    engine.failAnalyze = true;
    await ctl.handleAction({ type: "play", point: at("E1") });
    await flush();
    expect(ctl.view().problem).toMatchObject({ solved: true, lastAttempt: { move: "E1", correct: true, pointLoss: null } });
    expect(ctl.view().overlay?.variation?.moves).toEqual([{ color: "B", point: at("E1") }]);
  });

  it("compares the unrounded loss with the margin: 1.04 points is wrong, not an answer", async () => {
    engine.lossAfter(["H8"], 1.04);
    await startLive();
    await ctl.handleAction({ type: "play", point: at("H8") });
    await flush();
    expect(ctl.view().problem).toMatchObject({ solved: false, lastAttempt: { move: "H8", correct: false, pointLoss: 1 } });
    expect(stored(LIVE).answers).toEqual(["E1"]);
  });

  it("judges a move KataGo searched against its best in the same search, not a noisy second search", async () => {
    engine.lines.set("", { best: "H8", pv: ["H8", "D8"] }); // KataGo's own best, not a stored answer
    engine.lossAfter(["H8"], 3); // the separate search after H8 disagrees by 3 points
    await startLive();
    await ctl.handleAction({ type: "play", point: at("H8") });
    await flush();
    expect(ctl.view().problem).toMatchObject({ solved: true, lastAttempt: { move: "H8", correct: true, pointLoss: 0 } });
    expect(stored(LIVE).answers).toEqual(["E1", "H8"]);
  });

  it("tells the tutor which problem a chat message is about", async () => {
    ctl.newGame();
    await startLive();
    await ctl.handleAction({ type: "chat", text: "what is this?" });
    const msg = ofType("user_message").at(-1)!;
    expect(msg).toMatchObject({ text: "what is this?", problemId: LIVE });
    expect(msg.momentId).toBeUndefined();
  });

  it("holds a game mistake evaluated during practice until the learner goes back to the game", async () => {
    ctl.newGame();
    await flush();
    engine.lossAfter(["C3"], 6.2);
    engine.hold = true;
    await ctl.handleAction({ type: "play", point: at("C3") });
    await ctl.handleAction({ type: "next_problem" });
    engine.hold = false;
    engine.releaseAll();
    await flush();
    expect(ofType("teaching_moment")).toHaveLength(0);
    expect(ofType("fallback")).toHaveLength(0);
    expect(ctl.view().chat.at(-1)?.text).not.toMatch(/Press Continue/);
    expect(engine.botCalls).toHaveLength(0);
    await ctl.handleAction({ type: "leave_problem" });
    await flush();
    const v = ctl.view();
    expect(v.status).toBe("paused");
    expect(v.moment).toMatchObject({ moveNumber: 1, state: "fallback" });
    expect(ofType("teaching_moment")).toHaveLength(1);
    expect(v.chat.at(-1)?.text).toMatch(/C3 cost about 6.2 points/);
    expect(engine.botCalls).toHaveLength(0);
  });

  it("holds the KataGo fallback that comes due during practice until the learner goes back", async () => {
    ctl.setTutorAttached(true);
    ctl.newGame();
    await flush();
    engine.lossAfter(["C3"], 6.2);
    await ctl.handleAction({ type: "play", point: at("C3") });
    await flush();
    expect(ctl.view().moment?.state).toBe("waiting");
    await startLive();
    clock.advance(30_000);
    expect(ofType("fallback")).toHaveLength(0);
    expect(ctl.view().mode).toBe("problem");
    expect(ctl.view().chat.at(-1)?.text).not.toMatch(/Press Continue/);
    await ctl.handleAction({ type: "leave_problem" });
    expect(ofType("fallback")).toHaveLength(1);
    expect(ctl.view().moment?.state).toBe("fallback");
  });

  it("gives a tutor who reattaches during practice the moment whose fallback was put off", async () => {
    ctl.setTutorAttached(true);
    ctl.newGame();
    await flush();
    engine.lossAfter(["C3"], 6.2);
    await ctl.handleAction({ type: "play", point: at("C3") });
    await flush();
    await startLive();
    ctl.setTutorAttached(false); // the fallback comes due, but waits for Back to playing
    clock.advance(5000);
    ctl.setTutorAttached(true);
    expect(ctl.gameMoment()).toMatchObject({ state: "waiting", deadline: clock.now() + 30_000 });
    await ctl.handleAction({ type: "leave_problem" });
    expect(ofType("fallback")).toHaveLength(0);
    expect(ctl.view().moment?.state).toBe("waiting");
    clock.advance(30_000);
    expect(ofType("fallback")).toHaveLength(1);
    expect(ctl.view().moment?.state).toBe("fallback");
  });

  it("saves the category a tag gave the mistake while KataGo was still analyzing it", async () => {
    ctl.newGame();
    await flush();
    engine.lossAfter(["C3"], 6.2);
    await ctl.handleAction({ type: "play", point: at("C3") });
    await flush();
    engine.hold = true;
    await ctl.handleAction({ type: "resign" });
    await flush();
    const gameId = ofType("game_end")[0]!.gameId;
    await ctl.handleTutor({ type: "tag", gameId, moveNumber: 1, category: "shape" });
    engine.hold = false;
    engine.releaseAll();
    await flush(10);
    expect(store.loadProblems().find((p) => p.kind === "game")).toMatchObject({ category: "shape", prompt: expect.stringContaining("good shape") });
  });

  it("doesn't reuse a game's answers for a position whose ko ban the problem drops", async () => {
    // White's E5 takes the ko at D5, so Black's mistake C3 came while the recapture was illegal.
    engine.botMoves = ["D6", "C5", "D4", "E5"];
    const prefix = ["E6", "D6", "F5", "C5", "E4", "D4", "D5", "E5"];
    engine.lossAfter([...prefix, "C3"], 6.2);
    ctl.newGame();
    await flush();
    for (const gtp of ["E6", "F5", "E4", "D5"]) {
      await ctl.handleAction({ type: "play", point: at(gtp) });
      await flush(10);
    }
    expect(ctl.view().moves.at(-1)?.captures).toEqual([at("D5")]);
    await ctl.handleAction({ type: "play", point: at("C3") });
    await flush(10);
    await ctl.handleAction({ type: "continue" });
    engine.failAnalyze = true; // the position without its history can't be analyzed
    await ctl.handleAction({ type: "resign" });
    await flush(10);
    expect(engine.analyzeCalls.some((c) => c.opts?.maxVisits === DEEP_VISITS && c.pos.moves.length === 0)).toBe(true);
    expect(store.loadProblems().filter((p) => p.kind === "game")).toEqual([]);
  });

  it("re-analyzes a finished game's mistakes as many at a time as KataGo runs, and reads the game once", async () => {
    engine.concurrency = 2;
    ctl.newGame();
    await flush();
    engine.lossAfter(["C3"], 6.2);
    engine.lossAfter(["C3", "A9", "D4"], 5);
    engine.lossAfter(["C3", "A9", "D4", "B9", "F6"], 7);
    for (const gtp of ["C3", "D4", "F6"]) {
      await ctl.handleAction({ type: "play", point: at(gtp) });
      await flush();
      await ctl.handleAction({ type: "continue" });
      await flush();
    }
    engine.hold = true;
    await ctl.handleAction({ type: "resign" });
    const gameId = ofType("game_end")[0]!.gameId;
    ctl.newGame(); // the finished game is now only on disk
    let loads = 0;
    const loadGame = store.loadGame.bind(store);
    store.loadGame = (id) => {
      loads++;
      return loadGame(id);
    };
    await flush();
    const deep = () => engine.analyzeCalls.filter((c) => c.opts?.maxVisits === DEEP_VISITS).length;
    expect(deep()).toBe(2); // three to do, two at a time
    engine.releaseAll();
    await flush();
    expect(deep()).toBe(3);
    engine.hold = false;
    engine.releaseAll();
    await flush(10);
    expect(store.loadProblems().filter((p) => p.kind === "game").map((p) => p.source?.moveNumber)).toEqual([5, 1, 3]);
    expect(store.loadProblems().every((p) => p.kind === "generated" || gameSource(p)?.gameId === gameId)).toBe(true);
    expect(loads).toBe(1);
  });

  it("keeps the moves before a game problem's position and labels them, from the game record for older problems", async () => {
    ctl.newGame();
    await flush();
    engine.lossAfter(["C3", "A9", "D4", "B9", "F6"], 7);
    for (const gtp of ["C3", "D4", "F6"]) {
      await ctl.handleAction({ type: "play", point: at(gtp) });
      await flush();
    }
    await ctl.handleAction({ type: "continue" });
    await ctl.handleAction({ type: "resign" });
    await flush(10);
    const problem = store.loadProblems().find((p) => p.kind === "game")!;
    expect(problem.recent).toEqual([
      { color: "B", move: "C3" },
      { color: "W", move: "A9" },
      { color: "B", move: "D4" },
      { color: "W", move: "B9" },
    ]);
    const labels = [
      { color: "B", point: at("C3"), ago: 4 },
      { color: "W", point: at("A9"), ago: 3 },
      { color: "B", point: at("D4"), ago: 2 },
      { color: "W", point: at("B9"), ago: 1 },
    ];
    await ctl.handleTutor({ type: "start_problem", problemId: problem.id });
    expect(ctl.view().problem?.recentMoves).toEqual(labels);
    // A problem saved before they were kept gets them from its game, once.
    store.saveProblems(store.loadProblems().map((p) => (p.id === problem.id ? { ...p, recent: undefined } : p)));
    await ctl.handleAction({ type: "leave_problem" });
    await ctl.handleTutor({ type: "start_problem", problemId: problem.id });
    expect(ctl.view().problem?.recentMoves).toEqual(labels);
    expect(stored(problem.id).recent).toEqual(problem.recent);
    // A generated problem saved without them shows none.
    await startLive();
    expect(ctl.view().problem?.recentMoves).toBeUndefined();
  });

  it("turns a finished game's mistakes into problems, re-analyzing thin candidates", async () => {
    ctl.newGame();
    await flush();
    engine.lossAfter(["C3"], 6.2);
    await ctl.handleAction({ type: "play", point: at("C3") });
    await flush();
    await ctl.handleAction({ type: "resign" });
    await flush(10);
    const gameId = ofType("game_end")[0]!.gameId;
    const problem = store.loadProblems().find((p) => p.kind === "game")!;
    expect(problem).toMatchObject({
      id: "p1",
      toPlay: "B",
      answers: ["E1"],
      difficulty: 6.2,
      source: { gameId, moveNumber: 1, played: "C3" },
      box: 1,
      due: clock.now(),
    });
    expect(problem.stones).toEqual({ B: [], W: [] });
    // The stored candidates (one move) were thin, so the position was analyzed again, deeper.
    expect(engine.analyzeCalls.some((c) => c.opts?.maxVisits === DEEP_VISITS)).toBe(true);
    expect(ctl.view().chat.at(-1)?.text).toBe("One of your mistakes is now a practice problem. Press Practice to try it.");

    // A tag changes the problem's category and prompt with it.
    await ctl.handleTutor({ type: "tag", gameId, moveNumber: 1, category: "opening" });
    expect(store.loadProblems().find((p) => p.id === "p1")).toMatchObject({ category: "opening", prompt: expect.stringContaining("opening") });

    // The learner's own problem comes before generated ones in the focus category order.
    await ctl.handleTutor({ type: "start_problem" });
    expect(ctl.view().problem?.id).toBe("p1");
    expect(ctl.view().problem?.source).toEqual({ gameId, moveNumber: 1 });

    // A tag while the problem is on the board applies to this attempt and its result too.
    await ctl.handleTutor({ type: "tag", gameId, moveNumber: 1, category: "shape" });
    expect(ctl.view().problem).toMatchObject({ category: "shape", prompt: expect.stringContaining("good shape") });
    engine.lossAfter(["D1"], 19);
    engine.lossAfter(["F1"], 19);
    for (const gtp of ["D1", "F1"]) {
      await ctl.handleAction({ type: "play", point: at(gtp) });
      await flush();
    }
    expect(ofType("problem_attempt").map((e) => e.category)).toEqual(["shape", "shape"]);
  });
});
