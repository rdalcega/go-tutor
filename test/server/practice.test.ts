// Problem mode in the GameController: starting problems, judging attempts, spaced repetition,
// the profile, problem generation at game end, and returning to the game.
import { beforeEach, describe, expect, it } from "vitest";
import type { TutorEventInput } from "../../src/server/common.ts";
import { GameController } from "../../src/server/game.ts";
import { playoutMove } from "../../src/server/practice.ts";
import { BOX_INTERVALS, DEEP_VISITS, gameSource, problemGame } from "../../src/server/problems.ts";
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
    expect(ctl.view().chat.at(-1)?.text).toBe("One of your mistakes is now a practice problem. Press Review mistakes to try it.");
    // The finished game offers a review of its mistakes.
    expect(ctl.view()).toMatchObject({ reviewProblems: 1, allowed: expect.arrayContaining(["review_game"]) });

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

    // The tutor's review of the last game: its one problem, whatever its due time.
    await ctl.handleTutor({ type: "start_problem", gameId: "last" });
    expect(ctl.view().problem).toMatchObject({ id: "p1", review: { gameId, index: 1, total: 1 } });
  });
});

describe("reviewing a game's mistakes", () => {
  // Game g7's mistakes as problems, stored out of move order (a taken-back first try at move 9
  // comes before the move that stayed), one of them not due for weeks; and another game's.
  const fromGame = (id: string, gameId: string, moveNumber: number, takenBack?: number) =>
    liveProblem({ id, kind: "game", hash: id, source: { gameId, moveNumber, played: "D1", ...(takenBack !== undefined && { takenBack }) } });
  beforeEach(() => {
    setup();
    seedProblems(store, [
      fromGame("p1", "g7", 9),
      { ...fromGame("p2", "g7", 3), box: 4, due: clock.now() + 30 * 86_400_000 },
      fromGame("p3", "g7", 9, 1),
      fromGame("p4", "g8", 2),
    ]);
  });

  it("goes through the game's problems in move order, each once, and ends with how it went", async () => {
    await ctl.handleAction({ type: "review_game", gameId: "g7" });
    let v = ctl.view();
    expect(v.problem).toMatchObject({ id: "p2", review: { gameId: "g7", index: 1, total: 3 } });
    expect(ofType("problem_start").at(-1)).toMatchObject({ problemId: "p2", review: { gameId: "g7", index: 1, total: 3 } });
    expect(v.chat.at(-1)?.text).toContain("Review 1/3, mistake from your game g7 (move 3)");
    // Solved: scheduled as usual.
    await ctl.handleAction({ type: "play", point: at("E1") });
    await flush();
    expect(stored("p2")).toMatchObject({ box: 5, solves: 1 });

    await ctl.handleAction({ type: "next_problem" });
    expect(ctl.view().problem).toMatchObject({ id: "p3", review: { index: 2, total: 3 } });
    await ctl.handleAction({ type: "next_problem" }); // skipped without an attempt
    expect(ctl.view().problem).toMatchObject({ id: "p1", review: { index: 3, total: 3 } });
    engine.lossAfter(["D1"], 19);
    engine.lossAfter(["F1"], 19);
    for (const gtp of ["D1", "F1"]) {
      await ctl.handleAction({ type: "play", point: at(gtp) });
      await flush();
    }
    expect(stored("p1")).toMatchObject({ box: 1, lastResult: "failed" });

    // After the last one, back to the board rather than on into the due queue.
    await ctl.handleAction({ type: "next_problem" });
    v = ctl.view();
    expect(v.mode).toBe("idle");
    expect(v.problem).toBeNull();
    expect(v.chat.at(-1)?.text).toBe("Review done: you solved 1 of 3. Practice brings back the ones you missed.");
    // Practice is the due queue again.
    await ctl.handleAction({ type: "next_problem" });
    expect(ctl.view().problem?.review).toBeUndefined();
  });

  it("waits for KataGo's verdict before moving on, and skips a problem that can't be set up", async () => {
    // p3 (move 9's first try) is broken: a stone off the board.
    const problems = store.loadProblems();
    problems.find((p) => p.id === "p3")!.stones.B.push("Z99");
    store.saveProblems(problems);
    await ctl.handleAction({ type: "review_game", gameId: "g7" });
    engine.hold = true;
    await ctl.handleAction({ type: "play", point: at("E1") });
    expect(ctl.view().allowed).not.toContain("next_problem");
    await expect(ctl.handleAction({ type: "next_problem" })).rejects.toThrow();
    engine.releaseAll();
    await flush();
    expect(ctl.view().allowed).toContain("next_problem");
    await ctl.handleAction({ type: "next_problem" });
    expect(ctl.view().problem).toMatchObject({ id: "p1", review: { index: 3, total: 3 } });
    await ctl.handleAction({ type: "next_problem" });
    // The problem that couldn't be set up doesn't count.
    expect(ctl.view().chat.at(-1)?.text).toBe("Review done: you solved 1 of 2. Practice brings back the ones you missed.");
  });

  it("refuses a review none of whose problems can be set up", async () => {
    const problems = store.loadProblems();
    for (const p of problems) if (p.id !== "p4") p.stones.B.push("Z99");
    store.saveProblems(problems);
    await expect(ctl.handleAction({ type: "review_game", gameId: "g7" })).rejects.toThrow(/couldn't be set up/);
    expect(ctl.view().problem).toBeNull();
  });

  it("ends the review when the learner leaves it, or another problem starts", async () => {
    await ctl.handleTutor({ type: "start_problem", gameId: "g7" });
    await ctl.handleAction({ type: "leave_problem" });
    await ctl.handleAction({ type: "next_problem" });
    expect(ctl.view().problem?.review).toBeUndefined();

    await ctl.handleAction({ type: "review_game", gameId: "g7" });
    await ctl.handleTutor({ type: "start_problem", problemId: "p4" });
    await ctl.handleAction({ type: "next_problem" });
    expect(ctl.view().problem?.review).toBeUndefined();
  });

  it("refuses a game without problems, a game in progress, and a problem id with a game", async () => {
    await expect(ctl.handleAction({ type: "review_game", gameId: "g9" })).rejects.toThrow(/no practice problems/);
    await expect(ctl.handleTutor({ type: "start_problem", gameId: "g7", problemId: "p1" })).rejects.toThrow(/not both/);
    await expect(ctl.handleTutor({ type: "start_problem", gameId: "" })).rejects.toThrow(/Name the game/);
    ctl.newGame();
    const gameId = ctl.view().gameId!;
    await expect(ctl.handleTutor({ type: "start_problem", gameId })).rejects.toThrow(/still going/);
    expect(ctl.view()).not.toHaveProperty("reviewProblems");
    expect(ctl.view().allowed).not.toContain("review_game");
  });
});

describe("playing a problem out", () => {
  beforeEach(() => setup());

  const playout = () => ctl.view().problem?.playout;
  const act = (a: Parameters<GameController["handleAction"]>[0]) => ctl.handleAction(a);
  const stone = (gtp: string) => ctl.view().board[at(gtp).y]![at(gtp).x];
  /** Solve the problem (E1), then play it out: the answer's line E1 D8 E8 is ahead. */
  async function solveAndPlayOut(): Promise<void> {
    await startLive();
    await act({ type: "play", point: at("E1") });
    await flush();
    await act({ type: "playout_start" });
  }

  it("is offered only once the problem is answered, solved or failed, and starts with the answer's line ahead", async () => {
    await startLive();
    expect(ctl.view().allowed).not.toContain("playout_start");
    await expect(act({ type: "playout_start" })).rejects.toThrow(/Answer the problem first/);
    await act({ type: "play", point: at("E1") });
    await flush();
    const answered = ctl.view();
    expect(answered.allowed).toContain("playout_start");
    await act({ type: "playout_start" });
    const v = ctl.view();
    expect(v.problem?.playout).toEqual({ line: ["E1", "D8", "E8"], cursor: 0, thinking: false, over: false });
    // The answer's ghost stones go: the play-out puts real stones on the board.
    expect(v.overlay).toBeNull();
    expect(v.board).toEqual(answered.board);
    expect(v.moves).toEqual([]);
    expect(v.allowed).toEqual(expect.arrayContaining(["playout_forward", "playout_exit", "play", "pass"]));
    expect(v.allowed).not.toContain("playout_start");
    expect(v.allowed).not.toContain("playout_back");

    // Failed: KataGo's answer is ahead.
    setup();
    engine.lossAfter(["D1"], 19.3);
    engine.lossAfter(["F1"], 18.7);
    await startLive();
    await act({ type: "play", point: at("D1") });
    await flush();
    await act({ type: "play", point: at("F1") });
    await flush();
    await act({ type: "playout_start" });
    expect(playout()).toMatchObject({ line: ["E1", "D8", "E8"], cursor: 0 });
  });

  it("steps through the line without asking KataGo, and Done puts the answer's drawing back", async () => {
    await solveAndPlayOut();
    const calls = engine.analyzeCalls.length;
    await act({ type: "playout_forward" });
    await act({ type: "playout_forward" });
    let v = ctl.view();
    expect(v.problem?.playout).toMatchObject({ cursor: 2, line: ["E1", "D8", "E8"] });
    expect(stone("E1")).toBe("B");
    expect(stone("D8")).toBe("W");
    expect(v.moves.map((r) => [r.number, r.move.color])).toEqual([
      [1, "B"],
      [2, "W"],
    ]);
    expect(v.moves.every((r) => r.eval === undefined)).toBe(true);
    expect(v.toPlay).toBe("B");
    await act({ type: "playout_back" });
    expect(playout()?.cursor).toBe(1);
    expect(stone("D8")).toBeNull();
    expect(engine.analyzeCalls.length).toBe(calls);
    await act({ type: "playout_back" });
    await expect(act({ type: "playout_back" })).rejects.toThrow(/problem position/);

    await act({ type: "playout_exit" });
    v = ctl.view();
    expect(v.problem?.playout).toBeUndefined();
    expect(v.overlay?.variation?.moves.map((m) => m.point)).toEqual([at("E1"), at("D8"), at("E8")]);
    expect(v.moves).toEqual([]);
    expect(v.allowed).toContain("playout_start");
  });

  it("answers the learner's own move with KataGo at full strength, dropping the moves that were ahead", async () => {
    engine.lines.set("D1", { best: "E1", pv: ["E1", "F1"] });
    await solveAndPlayOut();
    await act({ type: "play", point: at("D1") });
    expect(playout()).toMatchObject({ line: ["D1"], cursor: 1, thinking: true });
    expect(ctl.view().engineBusy).toBe(true);
    expect(ctl.view().allowed).not.toContain("play");
    await expect(act({ type: "play", point: at("F1") })).rejects.toThrow(/thinking/);
    await flush();
    expect(playout()).toEqual({ line: ["D1", "E1"], cursor: 2, thinking: false, over: false });
    expect(stone("E1")).toBe("W");
    // The main net (no human-style profile), never the bot.
    const last = engine.analyzeCalls.at(-1)!;
    expect(last.pos.moves).toEqual([["B", "D1"]]);
    expect(last.opts?.overrideSettings).toBeUndefined();
    expect(engine.botCalls).toEqual([]);
  });

  it("steps forward when the learner plays the next move of the line, keeping the rest", async () => {
    await solveAndPlayOut();
    const calls = engine.analyzeCalls.length;
    await act({ type: "play", point: at("E1") });
    expect(playout()).toMatchObject({ line: ["E1", "D8", "E8"], cursor: 1, thinking: false });
    expect(engine.analyzeCalls.length).toBe(calls);
  });

  it("stops KataGo's search when its move is no longer wanted", async () => {
    await solveAndPlayOut();
    engine.hold = true;
    await act({ type: "play", point: at("A9") });
    const signal = engine.analyzeCalls.at(-1)!.opts?.signal;
    expect(signal?.aborted).toBe(false);
    await act({ type: "playout_back" });
    expect(signal?.aborted).toBe(true);
    await flush();
    expect(ctl.view().engineBusy).toBe(false);
    await act({ type: "play", point: at("A9") });
    const next = engine.analyzeCalls.at(-1)!.opts?.signal;
    await act({ type: "leave_problem" });
    expect(next?.aborted).toBe(true);
  });

  it("drops the moves ahead only for a legal move, and refuses moves on KataGo's turn", async () => {
    await solveAndPlayOut();
    await act({ type: "playout_forward" });
    // White's turn: the learner can't play, and the line stays.
    await expect(act({ type: "play", point: at("A9") })).rejects.toThrow(/KataGo's move/);
    await act({ type: "playout_back" });
    await expect(act({ type: "play", point: at("C1") })).rejects.toThrow(/already taken/);
    expect(playout()?.line).toEqual(["E1", "D8", "E8"]);
    await act({ type: "play", point: at("A9") });
    expect(playout()?.line).toEqual(["A9"]);
    await flush();
    // KataGo's favorite (E5) is taken here, so it passes.
    expect(playout()).toMatchObject({ line: ["A9", "pass"], cursor: 2 });
  });

  it("has KataGo move for the learner when they step forward at the end of the line, one move per press", async () => {
    engine.lines.set("A9", { best: "B9", pv: ["B9"] });
    engine.lines.set("A9 B9", { best: "C9", pv: ["C9"] });
    engine.lines.set("A9 B9 C9", { best: "D9", pv: ["D9"] });
    await solveAndPlayOut();
    await act({ type: "play", point: at("A9") });
    await flush();
    expect(playout()).toMatchObject({ line: ["A9", "B9"], cursor: 2 });
    await act({ type: "playout_forward" });
    await flush();
    expect(playout()).toMatchObject({ line: ["A9", "B9", "C9"], cursor: 3, thinking: false });
    expect(stone("C9")).toBe("B");
    // KataGo's turn: Forward asks it for White's move.
    await act({ type: "playout_forward" });
    await flush();
    expect(playout()).toMatchObject({ line: ["A9", "B9", "C9", "D9"], cursor: 4 });
  });

  it("emits nothing to the tutor and records nothing", async () => {
    engine.lines.set("A9", { best: "B9", pv: ["B9"] });
    engine.lines.set("A9 B9", { best: "C9", pv: ["C9"] });
    engine.lines.set("A9 B9 C9", { best: "D9", pv: ["D9"] });
    await solveAndPlayOut();
    const before = { events: events.length, problems: JSON.stringify(store.loadProblems()), profile: JSON.stringify(store.loadProfile()), version: ctl.view().profileVersion };
    await act({ type: "playout_forward" });
    await act({ type: "playout_back" });
    await act({ type: "play", point: at("A9") });
    await flush();
    await act({ type: "playout_forward" }); // KataGo for the learner
    await flush();
    await act({ type: "playout_forward" }); // KataGo for itself
    await flush();
    await act({ type: "pass" });
    await flush();
    await act({ type: "playout_exit" });
    expect(events.length).toBe(before.events);
    expect(JSON.stringify(store.loadProblems())).toBe(before.problems);
    expect(JSON.stringify(store.loadProfile())).toBe(before.profile);
    expect(ctl.view().profileVersion).toBe(before.version);
  });

  it("drops KataGo's answer when the learner steps back or leaves while it thinks, also when it fails", async () => {
    await solveAndPlayOut();
    engine.hold = true;
    await act({ type: "play", point: at("A9") });
    expect(playout()?.thinking).toBe(true);
    expect(ctl.view().allowed).toContain("playout_back");
    await act({ type: "playout_back" });
    expect(playout()).toMatchObject({ cursor: 0, thinking: false, line: ["A9"] });
    // A new request while the old one is still out: the old one's end doesn't touch it.
    await act({ type: "play", point: at("B9") });
    engine.held.shift()!.release();
    await flush();
    expect(playout()).toMatchObject({ cursor: 1, thinking: true, line: ["B9"] });
    engine.releaseAll();
    await flush();
    expect(playout()).toMatchObject({ cursor: 2, thinking: false });

    const chat = ctl.view().chat.length;
    await act({ type: "playout_back" });
    await act({ type: "playout_back" });
    await act({ type: "play", point: at("A9") });
    await act({ type: "playout_exit" });
    engine.failAnalyze = true;
    engine.releaseAll();
    await flush();
    expect(ctl.view().chat.length).toBe(chat);
    expect(playout()).toBeUndefined();
  });

  it("says when KataGo can't answer, and Forward tries again; stored moves step while KataGo isn't ready", async () => {
    await solveAndPlayOut();
    engine.failAnalyze = true;
    await act({ type: "play", point: at("A9") });
    await flush();
    expect(playout()).toMatchObject({ line: ["A9"], cursor: 1, thinking: false });
    expect(ctl.view().chat.at(-1)?.text).toMatch(/KataGo couldn't answer .* Press ▶ to try again/);
    engine.failAnalyze = false;
    await act({ type: "playout_forward" });
    await flush();
    expect(playout()).toMatchObject({ line: ["A9", "pass"], cursor: 2 });

    ctl.setEngineState("starting");
    await act({ type: "playout_back" });
    await act({ type: "playout_forward" });
    expect(playout()?.cursor).toBe(2);
    await expect(act({ type: "playout_forward" })).rejects.toThrow(/starting up/);
    await expect(act({ type: "play", point: at("B9") })).rejects.toThrow(/starting up/);
  });

  it("ends after two passes, when only Back is left", async () => {
    engine.lines.set("pass", { best: "pass", pv: ["pass"] });
    await solveAndPlayOut();
    await act({ type: "pass" });
    await flush();
    let v = ctl.view();
    expect(v.problem?.playout).toEqual({ line: ["pass", "pass"], cursor: 2, thinking: false, over: true });
    expect(v.moves.map((r) => "pass" in r.move)).toEqual([true, true]);
    expect(v.allowed).not.toContain("playout_forward");
    expect(v.allowed).not.toContain("play");
    await expect(act({ type: "playout_forward" })).rejects.toThrow(/Both sides passed/);
    await expect(act({ type: "play", point: at("A9") })).rejects.toThrow(/Both sides passed/);
    await act({ type: "playout_back" });
    expect(playout()).toMatchObject({ cursor: 1, over: false });
    // The learner's own second pass ends it without asking KataGo.
    await act({ type: "playout_back" });
    await act({ type: "play", point: at("A9") });
    await flush();
    expect(playout()).toMatchObject({ line: ["A9", "pass"], cursor: 2 });
    const calls = engine.analyzeCalls.length;
    await act({ type: "pass" });
    await flush();
    expect(playout()).toMatchObject({ line: ["A9", "pass", "pass"], cursor: 3, over: true });
    expect(engine.analyzeCalls.length).toBe(calls);
  });

  it("refuses game actions, and ends with the problem", async () => {
    await solveAndPlayOut();
    await expect(act({ type: "take_back" })).rejects.toThrow(/step back with ◀/);
    await expect(act({ type: "retry" })).rejects.toThrow(/step back with ◀/);
    await expect(act({ type: "ask_tutor" })).rejects.toThrow(/chat/);
    await act({ type: "playout_start" }); // already playing out: nothing changes
    expect(playout()?.cursor).toBe(0);
    engine.hold = true;
    await act({ type: "play", point: at("A9") });
    // Next is allowed while KataGo thinks: the play-out goes with the problem.
    expect(ctl.view().allowed).toContain("next_problem");
    await act({ type: "next_problem" });
    engine.releaseAll();
    await flush();
    expect(ctl.view().problem?.id).toBe("gen2");
    expect(playout()).toBeUndefined();
    await act({ type: "leave_problem" });
    await expect(act({ type: "playout_forward" })).rejects.toThrow(/practice problem you have answered/);
  });

  it("keeps the tutor out: no drawing, and one say per answer it owes", async () => {
    ctl.setTutorAttached(true);
    await solveAndPlayOut();
    await expect(ctl.handleTutor({ type: "show", moves: ["E1"] })).rejects.toThrow(/playing the answered problem out/);
    await expect(ctl.handleTutor({ type: "mark", points: ["E1"] })).rejects.toThrow(/playing the answered problem out/);
    // The learner pressed Play it out before the tutor answered the solve: that answer still goes, once.
    await ctl.handleTutor({ type: "say", text: "Nice, E1 makes two eyes." });
    await expect(ctl.handleTutor({ type: "say", text: "Nice!" })).rejects.toThrow(/playing the answered problem out/);
    await ctl.handleAction({ type: "chat", text: "why does White play there?" });
    expect(ofType("user_message").at(-1)).toMatchObject({ problemId: LIVE, playout: true });
    await ctl.handleTutor({ type: "say", text: "To take away the eye." });
    expect(ctl.view().chat.at(-1)).toMatchObject({ from: "tutor", text: "To take away the eye." });
    await expect(ctl.handleTutor({ type: "say", text: "And more." })).rejects.toThrow(/one say/);
    // Harmless: clear and resume.
    await ctl.handleTutor({ type: "clear" });
    await ctl.handleTutor({ type: "resume" });
    // A question asked just before (or with the tutor away) is still answered, once.
    await act({ type: "playout_exit" });
    ctl.setTutorAttached(false);
    await ctl.handleAction({ type: "chat", text: "hm" });
    await act({ type: "playout_start" });
    ctl.setTutorAttached(true);
    await ctl.handleTutor({ type: "say", text: "late answer" });
    await expect(ctl.handleTutor({ type: "say", text: "later" })).rejects.toThrow(/one say/);
    // Back on the answered problem, the tutor talks and draws as usual.
    await act({ type: "playout_exit" });
    await ctl.handleTutor({ type: "say", text: "Well done." });
    await ctl.handleTutor({ type: "mark", points: ["E1"] });
    // The answer's drawing came back, and the mark joins it.
    expect(ctl.view().overlay?.variation).toBeDefined();
  });

  it("plays KataGo's best legal candidate, or a pass", () => {
    const game = problemGame(liveProblem());
    const info = (move: string) => ({ move, scoreLead: 0, winrate: 0.5, visits: 10, order: 0, prior: 0.1, pv: [move] });
    // E5 is taken (KataGo's rules can disagree with ours on a repeated position).
    expect(playoutMove({ moveInfos: [info("E5"), info("A9")] }, game)).toBe("A9");
    expect(playoutMove({ moveInfos: [info("E5"), info("pass"), info("A9")] }, game)).toBe("pass");
    expect(playoutMove({ moveInfos: [info("E5")] }, game)).toBe("pass");
    expect(playoutMove({ moveInfos: [] }, game)).toBe("pass");
  });
});
