// Spaced repetition for practice problems (Leitner boxes), shared by the server (problems.ts)
// and the browser's mock server, so both schedule a problem the same way.

export const MAX_BOX = 5;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/**
 * How long until a problem is due again after a result, by Leitner box (index = box). Box 1 comes
 * back within the session; a problem solved first try five times in a row waits three weeks.
 */
export const BOX_INTERVALS: readonly number[] = [0, 10 * MINUTE, DAY, 3 * DAY, 7 * DAY, 21 * DAY];

/** Practice problems missed in one session before practice closes (the limit: src/server/lessons.ts). */
export const PRACTICE_MISS_LIMIT = 3;
/** How long practice stays closed after PRACTICE_MISS_LIMIT misses. */
export const PRACTICE_PAUSE_MS = 60 * MINUTE;

export type ProblemResult = "first_try" | "solved" | "failed";

export function resultOf(solved: boolean, attempts: number): ProblemResult {
  return !solved ? "failed" : attempts <= 1 ? "first_try" : "solved";
}

/** The box after a result: solved first try moves up a box, solved on a later try keeps it, failing goes back to box 1. */
export function nextBox(box: number, result: ProblemResult): number {
  const next = result === "first_try" ? box + 1 : result === "failed" ? 1 : box;
  return Math.max(1, Math.min(MAX_BOX, next));
}

/** What scheduling reads and writes of a problem. */
export interface Scheduled {
  box: number;
  due: number;
  seen: number;
  solves: number;
  lastResult?: ProblemResult;
  lastSeen?: number;
}

/** A new problem's schedule: box 1, due at once, never shown. */
export function freshSchedule(now: number): Pick<Scheduled, "box" | "due" | "seen" | "solves"> {
  return { box: 1, due: now, seen: 0, solves: 0 };
}

/** Leitner scheduling (mutates): the problem moves to its next box and is due again after that box's interval. */
export function schedule(p: Scheduled, result: ProblemResult, now: number): void {
  p.box = nextBox(p.box, result);
  p.due = now + BOX_INTERVALS[p.box]!;
  p.seen++;
  if (result !== "failed") p.solves++;
  p.lastResult = result;
  p.lastSeen = now;
}
