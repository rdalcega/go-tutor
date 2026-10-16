import { describe, expect, it } from "vitest";
import { allowedActions, retryBlocked, type ActionState } from "../../src/shared/allowed.ts";
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

const ALWAYS = ["new_game", "chat", "next_problem", "set_tutor_level"];

describe("allowedActions", () => {
  it("offers only the always-on actions without a game or after it ended", () => {
    expect(allowedActions(game({ mode: "idle", humanColor: null }))).toEqual(ALWAYS);
    expect(allowedActions(game({ finished: true, moves: [B(0, 0)] }))).toEqual(ALWAYS);
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
    expect(allowedActions(game({ status: "paused", toPlay: "W", moves: [B(2, 2)], moment }))).toEqual([...ALWAYS, "resign", "continue", "retry"]);
    const takenBack = game({ moves: [], moment: { moveNumber: 1, state: "tutor" } });
    expect(retryBlocked(takenBack)).toBe("taken_back");
    expect(allowedActions(takenBack)).not.toContain("retry");
    expect(retryBlocked(game({ moves: [W(0, 0)], humanColor: "B" }))).toBe("no_move");
    expect(retryBlocked(game({ humanColor: null }))).toBe("no_game");
    expect(retryBlocked(game({ finished: true, moves: [B(0, 0)] }))).toBe("finished");
  });

  it("lets the learner play a problem until it is revealed, while KataGo isn't checking", () => {
    const problem = (revealed: boolean, checking: boolean) => game({ mode: "problem", problem: { revealed, checking } });
    expect(allowedActions(problem(false, false))).toEqual([...ALWAYS, "leave_problem", "play"]);
    expect(allowedActions(problem(true, false))).toEqual([...ALWAYS, "leave_problem"]);
    expect(allowedActions(problem(false, true))).toEqual([...ALWAYS, "leave_problem"]);
    expect(allowedActions({ ...problem(false, false), engineReady: false })).toEqual([...ALWAYS, "leave_problem"]);
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
