import { describe, expect, it } from "vitest";
import { allowedActions, retryBlocked, takeBackBlocked, type ActionState } from "../../src/shared/allowed.ts";
import type { Move } from "../../src/shared/types.ts";

const B = (x: number, y: number): { move: Move } => ({ move: { color: "B", point: { x, y } } });
const W = (x: number, y: number): { move: Move } => ({ move: { color: "W", point: { x, y } } });
const pass = (color: "B" | "W"): { move: Move } => ({ move: { color, pass: true } });

const game = (over: Partial<ActionState> = {}): ActionState => ({
  mode: "game",
  status: "playing",
  finished: false,
  humanColor: "B",
  toPlay: "B",
  moves: [],
  moment: null,
  engineReady: true,
  tutorAttached: false,
  problem: null,
  overlay: false,
  ...over,
});

const ALWAYS = ["new_game", "chat", "next_problem", "set_tutor_level", "set_judge_mode"];

describe("allowedActions", () => {
  it("offers only the always-on actions without a game or after it ended", () => {
    expect(allowedActions(game({ mode: "idle", humanColor: null }))).toEqual(ALWAYS);
    expect(allowedActions(game({ finished: true, moves: [B(0, 0)] }))).toEqual(ALWAYS);
  });

  it("offers a review of a finished game's mistakes once they are practice problems", () => {
    expect(allowedActions(game({ finished: true, reviewProblems: 2 }))).toEqual([...ALWAYS, "review_game"]);
    expect(allowedActions(game({ finished: true, reviewProblems: 0 }))).toEqual(ALWAYS);
    expect(allowedActions(game({ reviewProblems: 2 }))).not.toContain("review_game");
  });

  it("lets the learner play on their turn with KataGo ready", () => {
    expect(allowedActions(game())).toEqual([...ALWAYS, "resign", "play", "pass", "ask_tutor"]);
    // The bot's turn: no play, and no hint either.
    expect(allowedActions(game({ toPlay: "W", moves: [B(0, 0)] }))).toEqual([...ALWAYS, "resign", "retry"]);
    // KataGo starting: no play; a hint only when a tutor can answer it.
    expect(allowedActions(game({ engineReady: false }))).toEqual([...ALWAYS, "resign"]);
    expect(allowedActions(game({ engineReady: false, tutorAttached: true }))).toEqual([...ALWAYS, "resign", "ask_tutor"]);
    // Two passes: the score is coming, nothing more to play.
    expect(allowedActions(game({ moves: [B(0, 0), pass("W"), pass("B"), pass("W")] }))).not.toContain("play");
  });

  it("offers Continue and Try again during a pause, until the moment's move is taken back", () => {
    const moment = { moveNumber: 1, state: "waiting" as const };
    expect(allowedActions(game({ status: "paused", toPlay: "W", moves: [B(2, 2)], moment }))).toEqual([...ALWAYS, "resign", "continue", "retry", "take_back"]);
    const takenBack = game({ moves: [], moment: { moveNumber: 1, state: "tutor" } });
    expect(retryBlocked(takenBack)).toBe("taken_back");
    expect(allowedActions(takenBack)).not.toContain("retry");
    expect(retryBlocked(game({ moves: [W(0, 0)], humanColor: "B" }))).toBe("no_move");
    expect(retryBlocked(game({ humanColor: null }))).toBe("no_game");
    expect(retryBlocked(game({ finished: true, moves: [B(0, 0)] }))).toBe("finished");
  });

  it("offers Take back on the learner's turn or in a pause, not while the bot thinks", () => {
    // The learner's turn after the bot's reply: their move and the reply go.
    expect(allowedActions(game({ moves: [B(2, 2), W(6, 6)] }))).toContain("take_back");
    expect(takeBackBlocked(game({ moves: [B(2, 2), W(6, 6)] }))).toBeNull();
    // Their move is being evaluated or the bot is thinking: not yet.
    expect(takeBackBlocked(game({ toPlay: "W", moves: [B(2, 2)] }))).toBe("not_now");
    expect(allowedActions(game({ toPlay: "W", moves: [B(2, 2)] }))).not.toContain("take_back");
    // A pause: like Try again.
    expect(takeBackBlocked(game({ status: "paused", toPlay: "W", moves: [B(2, 2)], moment: { moveNumber: 1, state: "fallback" } }))).toBeNull();
    // Nothing of theirs to take back, a finished game, or a game being scored after two passes.
    expect(takeBackBlocked(game())).toBe("no_move");
    expect(takeBackBlocked(game({ finished: true, moves: [B(0, 0), W(1, 1)] }))).toBe("finished");
    expect(takeBackBlocked(game({ moves: [B(0, 0), W(1, 1), pass("B"), pass("W")] }))).toBe("not_now");
    // Every tutor level and with a tutor attached: the rules don't depend on either.
    expect(allowedActions(game({ tutorAttached: true, moves: [B(2, 2), W(6, 6)] }))).toContain("take_back");
  });

  it("lets the learner play a problem until it is revealed, while KataGo isn't checking", () => {
    const problem = (revealed: boolean, checking: boolean) => game({ mode: "problem", problem: { revealed, checking } });
    expect(allowedActions(problem(false, false))).toEqual([...ALWAYS, "leave_problem", "play"]);
    // Once answered, the problem can be played out.
    expect(allowedActions(problem(true, false))).toEqual([...ALWAYS, "leave_problem", "playout_start"]);
    expect(allowedActions(problem(false, true))).toEqual([...ALWAYS, "leave_problem"]);
    expect(allowedActions({ ...problem(false, false), engineReady: false })).toEqual([...ALWAYS, "leave_problem"]);
  });

  it("steps through a play-out, and lets the learner play only on their turn while KataGo isn't thinking", () => {
    const po = { cursor: 0, length: 0, thinking: false, learnerToPlay: true, over: false };
    const playout = (p: Partial<typeof po> = {}, s: Partial<ActionState> = {}) =>
      allowedActions(game({ mode: "problem", problem: { revealed: true, checking: false, playout: { ...po, ...p } }, ...s }));
    const base = [...ALWAYS, "leave_problem", "playout_exit"];
    // At the problem position: Forward has KataGo move for the learner; no Back, no Play it out again.
    expect(playout()).toEqual([...base, "playout_forward", "play", "pass"]);
    expect(playout({ cursor: 2, length: 3 })).toEqual([...base, "playout_back", "playout_forward", "play", "pass"]);
    // KataGo's turn: Forward asks it, the learner can't play.
    expect(playout({ cursor: 1, length: 1, learnerToPlay: false })).toEqual([...base, "playout_back", "playout_forward"]);
    // Thinking: Back cancels its answer; nothing else moves.
    expect(playout({ cursor: 1, length: 1, thinking: true, learnerToPlay: false })).toEqual([...base, "playout_back"]);
    // Over: only stored moves and Back.
    expect(playout({ cursor: 2, length: 2, over: true })).toEqual([...base, "playout_back"]);
    expect(playout({ cursor: 1, length: 2, over: true })).toEqual([...base, "playout_back", "playout_forward"]);
    // KataGo not ready: stored moves still step; nothing new is asked for.
    expect(playout({ cursor: 1, length: 2 }, { engineReady: false })).toEqual([...base, "playout_back", "playout_forward"]);
    expect(playout({ cursor: 2, length: 2 }, { engineReady: false })).toEqual([...base, "playout_back"]);
    // ... but the learner may replay the line's next move while the line goes on past it.
    expect(playout({ cursor: 0, length: 2 }, { engineReady: false })).toEqual([...base, "playout_forward", "play", "pass"]);
    // The game's state underneath doesn't count.
    expect(playout({}, { humanColor: "W", toPlay: "W", status: "paused" })).toContain("play");
  });

  it("offers hiding the drawing whenever one is on the board, in every mode", () => {
    expect(allowedActions(game({ mode: "idle", humanColor: null, overlay: true }))).toEqual([...ALWAYS, "clear_overlay"]);
    expect(allowedActions(game({ overlay: true }))).toContain("clear_overlay");
    expect(allowedActions(game({ finished: true, overlay: true }))).toContain("clear_overlay");
    expect(allowedActions(game({ mode: "problem", problem: { revealed: true, checking: false }, overlay: true }))).toContain("clear_overlay");
    expect(allowedActions(game())).not.toContain("clear_overlay");
  });

  it("returns a fresh array every time", () => {
    const a = allowedActions(game({ mode: "idle", humanColor: null }));
    a.push("resign");
    expect(allowedActions(game({ mode: "idle", humanColor: null }))).toEqual(ALWAYS);
  });
});
