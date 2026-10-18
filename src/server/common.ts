// What the game controller (game.ts) and the practice session (practice.ts) share: errors meant
// for people, the clock, event inputs, and turning GTP from KataGo or the tutor into board drawings.

import { opponent, type GoGame, type IllegalReason } from "../engine/index.ts";
import { tryFromGtp } from "../shared/coords.ts";
import type { Color, Gtp, MarkKind, Overlay, Point, TutorEvent } from "../shared/types.ts";

/** An error whose message is meant for the person (or tutor) who sent the request. */
export class UserError extends Error {}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A TutorEvent before the bridge stamps `seq` and `ts`. */
export type TutorEventInput = DistributiveOmit<TutorEvent, "seq" | "ts">;

export type Stone = { color: Color; point: Point };

export const ILLEGAL_TEXT: Record<IllegalReason, string> = {
  occupied: "That point is already taken.",
  suicide: "That move would leave your stones without liberties (suicide is not allowed).",
  ko: "That move would repeat an earlier position (ko). Play elsewhere first.",
  not_your_turn: "It's not your turn.",
  game_over: "The game is over.",
  off_board: "That point is off the board.",
};

/** Moves of KataGo's line drawn as ghost stones (a fallback, an answer that was missed). */
export const PV_STONES = 6;

/** One more than the largest number in the ids of the form `<prefix><n>` (1 when there is none): the next free id's number. */
export function nextNumber(ids: Iterable<string>, prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const n = id.slice(prefix.length);
    if (/^\d+$/.test(n)) max = Math.max(max, Number(n));
  }
  return max + 1;
}

/**
 * Ghost stones for the first `max` moves of a line (KataGo's PV), played out on `replay` (which
 * it changes) so the line stops at a pass or a move that isn't legal there.
 */
export function lineStones(replay: GoGame, line: readonly Gtp[], max: number): Stone[] {
  const stones: Stone[] = [];
  for (const gtp of line.slice(0, max)) {
    const point = tryFromGtp(gtp, replay.size);
    const color = replay.toPlay;
    if (!point || !replay.play({ color, point }).ok) break;
    stones.push({ color, point });
  }
  return stones;
}

/** A tutor's coordinate on a `size` board; a pass is null when allowed. */
export function parsePoint(gtp: Gtp, size: number, allowPass: boolean): Point | null {
  const point = tryFromGtp(gtp, size);
  if (point === undefined || (point === null && !allowPass)) {
    throw new UserError(`"${gtp}" is not a point on a ${size}×${size} board (columns skip I, row 1 is the bottom).`);
  }
  return point;
}

/** A tutor's `show`: stones in alternating colors from `firstColor`; a pass is skipped but still takes a turn. */
export function alternatingStones(moves: readonly Gtp[], firstColor: Color, size: number): Stone[] {
  if (moves.length === 0) throw new UserError("show needs at least one move.");
  const stones: Stone[] = [];
  let color = firstColor;
  for (const gtp of moves) {
    const point = parsePoint(gtp, size, true);
    if (point) stones.push({ color, point });
    color = opponent(color);
  }
  return stones;
}

/** A tutor's `mark`. */
export function markPoints(points: readonly Gtp[], size: number, kind: MarkKind, text?: string): NonNullable<Overlay["marks"]> {
  if (points.length === 0) throw new UserError("mark needs at least one point.");
  return points.map((gtp) => ({ point: parsePoint(gtp, size, false)!, kind, ...(text && { text }) }));
}
