import type { Gtp, Point } from "./types.ts";

/** GTP column letters: A–T without I (enough for 19×19; up to 25 with the rest of the alphabet). */
export const GTP_COLUMNS = "ABCDEFGHJKLMNOPQRSTUVWXYZ";

/** GTP coordinate of a point, or "pass" for null. Row 1 is the bottom row. */
export function toGtp(point: Point | null, size: number): Gtp {
  if (point === null) return "pass";
  if (!inBounds(point, size)) {
    throw new RangeError(`Point (${point.x}, ${point.y}) is off a ${size}×${size} board`);
  }
  return `${GTP_COLUMNS[point.x]}${size - point.y}`;
}

/**
 * Parse a GTP coordinate ("D4", "q16", "pass"). Returns null for a pass.
 * Throws a RangeError with a readable message for anything that is not a point on this board.
 */
export function fromGtp(gtp: Gtp, size: number): Point | null {
  const text = gtp.trim().toUpperCase();
  if (text === "PASS") return null;
  const match = /^([A-Z])(\d{1,2})$/.exec(text);
  const x = match ? GTP_COLUMNS.indexOf(match[1]!) : -1;
  const row = match ? Number(match[2]) : NaN;
  const point = { x, y: size - row };
  if (x < 0 || !inBounds(point, size)) {
    const last = GTP_COLUMNS[size - 1] ?? "?";
    throw new RangeError(`"${gtp}" is not a point on a ${size}×${size} board (use A1–${last}${size}, no I, or "pass")`);
  }
  return point;
}

/** Like fromGtp but returns undefined instead of throwing for invalid input. */
export function tryFromGtp(gtp: Gtp, size: number): Point | null | undefined {
  try {
    return fromGtp(gtp, size);
  } catch {
    return undefined;
  }
}

export function inBounds(p: Point, size: number): boolean {
  return Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x < size && p.y < size;
}

/** Stable string key for a point, for use in Sets and Maps. */
export function pointKey(p: Point): string {
  return `${p.x},${p.y}`;
}

export function parsePointKey(key: string): Point {
  const [x, y] = key.split(",").map(Number);
  return { x: x!, y: y! };
}

export function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}
