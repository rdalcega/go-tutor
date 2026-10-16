// Which browser actions the server accepts right now. Pure, so the server's GameController and the
// UI's dev mock (web/src/mock.ts) share one set of rules.

import type { ClientAction, Color, GameStatus, Move, TeachingMoment } from "./types.ts";

export type ActionType = ClientAction["type"];

/** The state the rules read: a slice of the game (or the practice problem on the board). */
export interface ActionState {
  mode: "idle" | "game" | "problem";
  status: GameStatus;
  /** The game has a result (resigned, scored, abandoned). */
  finished: boolean;
  /** The learner's color; null without a game. */
  humanColor: Color | null;
  toPlay: Color;
  moves: readonly { move: Move }[];
  moment: Pick<TeachingMoment, "moveNumber" | "state"> | null;
  engineReady: boolean;
  tutorAttached: boolean;
  /** In problem mode: the answer is shown, or KataGo is still checking the last attempt. */
  problem: { revealed: boolean; checking: boolean } | null;
}

/** Actions the browser can send in any mode. */
const ALWAYS: readonly ActionType[] = ["new_game", "chat", "next_problem"];

/** Two consecutive passes: the game is over, though its score may not be in yet. */
function twoPasses(moves: ActionState["moves"]): boolean {
  const n = moves.length;
  return n >= 2 && "pass" in moves[n - 1]!.move && "pass" in moves[n - 2]!.move;
}

/**
 * Why Try again can't take back a move now, or null when it can: there must be a game without a
 * result, a move of the learner's to take back, and the open moment's move must not already be
 * taken back.
 */
export function retryBlocked(s: Pick<ActionState, "humanColor" | "finished" | "moves" | "moment">): "no_game" | "finished" | "taken_back" | "no_move" | null {
  if (s.humanColor === null) return "no_game";
  if (s.finished) return "finished";
  const open = s.moment && s.moment.state !== "resolved" ? s.moment : null;
  if (open && open.moveNumber > s.moves.length) return "taken_back";
  if (!s.moves.some((r) => r.move.color === s.humanColor)) return "no_move";
  return null;
}

/** The browser actions accepted in this state. Always a fresh array. */
export function allowedActions(s: ActionState): ActionType[] {
  if (s.mode === "problem") {
    const canPlay = s.problem !== null && !s.problem.revealed && !s.problem.checking && s.engineReady;
    return [...ALWAYS, "leave_problem", ...(canPlay ? (["play"] as const) : [])];
  }
  if (s.mode === "idle" || s.humanColor === null || s.finished) return [...ALWAYS];
  const allowed: ActionType[] = [...ALWAYS, "resign"];
  const humanToPlay = s.toPlay === s.humanColor;
  const paused = s.status === "paused";
  if (humanToPlay && !twoPasses(s.moves) && !paused && s.engineReady) allowed.push("play", "pass");
  if (paused) allowed.push("continue");
  if (retryBlocked(s) === null) allowed.push("retry");
  if (humanToPlay && (s.tutorAttached || s.engineReady)) allowed.push("ask_tutor");
  return allowed;
}
