// Hand-rolled argument parsing for the tutor CLI. Pure: argv in, a typed Invocation out.

import { toGtp, tryFromGtp } from "../shared/coords.ts";
import { normalizeBotRank } from "../shared/rank.ts";
import { MARK_KINDS, MISTAKE_CATEGORIES, type Color, type GameSettings, type MarkKind, type MistakeCategory, type TutorCommand } from "../shared/types.ts";

export class UsageError extends Error {}

export type Invocation =
  | { kind: "help"; topic?: string }
  | { kind: "watch"; since?: number; json: boolean }
  | { kind: "state"; json: boolean }
  | { kind: "summary"; json: boolean }
  | { kind: "problems"; json: boolean }
  | { kind: "review"; gameId: string; json: boolean }
  | { kind: "command"; command: TutorCommand; json: boolean };

/** Flags that never take a value. Every other `--flag` consumes the next token (or `=value`). */
const BOOLEAN_FLAGS = new Set(["json", "help"]);

interface Split {
  positional: string[];
  flags: Map<string, string | true>;
}

/** Splits tokens into positionals and flags. `--` ends flag parsing. */
export function splitArgs(tokens: string[]): Split {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") {
      positional.push(...tokens.slice(i + 1));
      break;
    }
    if (token === "-h") {
      flags.set("help", true);
      continue;
    }
    if (!token.startsWith("--") || token.length === 2) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
    } else if (BOOLEAN_FLAGS.has(body)) {
      flags.set(body, true);
    } else {
      const value = tokens[i + 1];
      if (value === undefined) throw new UsageError(`--${body} needs a value`);
      flags.set(body, value);
      i++;
    }
  }
  return { positional, flags };
}

/** The largest board: coordinates are checked against 19×19 here, and against the actual board by the server. */
const MAX_SIZE = 19;

/** Uppercases and validates a GTP coordinate ("d4" → "D4"). */
export function parseGtp(raw: string, allowPass = false): string {
  const point = tryFromGtp(raw, MAX_SIZE);
  if (point === null && allowPass) return "pass";
  if (!point) throw new UsageError(`not a board coordinate: "${raw}" (expected e.g. D4; columns A-T without I)`);
  return toGtp(point, MAX_SIZE);
}

function parseColor(raw: string, flag: string): Color {
  const up = raw.toUpperCase();
  if (up === "B" || up === "BLACK") return "B";
  if (up === "W" || up === "WHITE") return "W";
  throw new UsageError(`--${flag} must be B or W, got "${raw}"`);
}

function parseIntStrict(raw: string, what: string): number {
  if (!/^\d+$/.test(raw)) throw new UsageError(`${what} must be a non-negative integer, got "${raw}"`);
  return Number(raw);
}

class Flags {
  private used = new Set<string>(["json", "help"]);
  constructor(
    private readonly command: string,
    private readonly map: Map<string, string | true>,
  ) {}

  string(name: string): string | undefined {
    this.used.add(name);
    const v = this.map.get(name);
    if (v === true) throw new UsageError(`--${name} needs a value`);
    return v;
  }

  /** Rejects flags the command does not know, so typos are not silently ignored. */
  done(): void {
    for (const name of this.map.keys()) {
      if (!this.used.has(name)) throw new UsageError(`unknown option --${name} for "${this.command}"`);
    }
  }
}

function requireText(positional: string[], command: string): string {
  const text = positional.join(" ").trim();
  if (!text) throw new UsageError(`${command} needs text, e.g. tutor ${command} "Look at the cut at D5."`);
  return text;
}

function noPositionals(positional: string[], command: string): void {
  if (positional.length > 0) throw new UsageError(`${command} takes no arguments, got "${positional.join(" ")}"`);
}

export function parseInvocation(argv: string[]): Invocation {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    return { kind: "help", topic: rest[0] };
  }
  const { positional, flags: flagMap } = splitArgs(rest);
  if (flagMap.has("help")) return { kind: "help", topic: name };
  const json = flagMap.get("json") === true;
  const flags = new Flags(name, flagMap);

  const result = ((): Invocation => {
    const cmd = (command: TutorCommand): Invocation => ({ kind: "command", command, json });
    switch (name) {
      case "watch": {
        noPositionals(positional, name);
        const since = flags.string("since");
        return { kind: "watch", json, ...(since !== undefined && { since: parseIntStrict(since, "--since") }) };
      }
      case "state":
        noPositionals(positional, name);
        return { kind: "state", json };
      case "summary":
      case "problems":
        noPositionals(positional, name);
        return { kind: name, json };
      case "review": {
        if (positional.length > 1) throw new UsageError(`review takes one game id (or "last")`);
        return { kind: "review", gameId: positional[0] ?? "last", json };
      }
      case "say":
      case "rethink": {
        const momentId = flags.string("moment");
        const text = requireText(positional, name);
        return cmd({ type: name, text, ...(momentId && { momentId }) });
      }
      case "show": {
        if (positional.length === 0) throw new UsageError("show needs at least one move, e.g. tutor show D5 E4 C6");
        const moves = positional.map((m) => parseGtp(m, true));
        const label = flags.string("label");
        const start = flags.string("start");
        return cmd({
          type: "show",
          moves,
          ...(label !== undefined && { label }),
          ...(start !== undefined && { start: parseColor(start, "start") }),
        });
      }
      case "mark": {
        if (positional.length === 0) throw new UsageError("mark needs at least one point, e.g. tutor mark D5");
        const points = positional.map((p) => parseGtp(p));
        const kind = flags.string("kind");
        const text = flags.string("text");
        if (kind !== undefined && !MARK_KINDS.includes(kind as MarkKind)) {
          throw new UsageError(`--kind must be one of ${MARK_KINDS.join(", ")}, got "${kind}"`);
        }
        return cmd({
          type: "mark",
          points,
          ...(kind !== undefined && { kind: kind as MarkKind }),
          ...(text !== undefined && { text }),
        });
      }
      case "clear":
      case "resume":
        noPositionals(positional, name);
        return cmd({ type: name });
      case "claim": {
        const [momentId, ...extra] = positional;
        if (!momentId || extra.length) throw new UsageError("claim takes exactly one moment id, e.g. tutor claim m3");
        return cmd({ type: "claim", momentId });
      }
      case "new-game": {
        noPositionals(positional, name);
        const settings: Partial<GameSettings> = {};
        const size = flags.string("size");
        if (size !== undefined) {
          if (size !== "9" && size !== "13" && size !== "19") throw new UsageError(`--size must be 9, 13 or 19`);
          settings.size = Number(size) as 9 | 13 | 19;
        }
        const rank = flags.string("rank");
        if (rank !== undefined) {
          try {
            settings.botRank = normalizeBotRank(rank);
          } catch (e) {
            throw new UsageError(`--rank must be a rank from 20k to 9d, like 18k or 2d (${(e as Error).message})`);
          }
        }
        const color = flags.string("color");
        if (color !== undefined) settings.humanColor = parseColor(color, "color");
        const komi = flags.string("komi");
        if (komi !== undefined) {
          const k = Number(komi);
          if (!Number.isFinite(k) || komi.trim() === "") throw new UsageError(`--komi must be a number`);
          settings.komi = k;
        }
        const handicap = flags.string("handicap");
        if (handicap !== undefined) settings.handicap = parseIntStrict(handicap, "--handicap");
        return cmd({ type: "new_game", ...(Object.keys(settings).length > 0 && { settings }) });
      }
      case "problem": {
        if (positional.length > 1) throw new UsageError("problem takes at most one problem id");
        const problemId = positional[0];
        return cmd({ type: "start_problem", ...(problemId && { problemId }) });
      }
      case "tag": {
        const [gameId, moveRaw, category, ...noteParts] = positional;
        if (!gameId || !moveRaw || !category) {
          throw new UsageError("tag needs <gameId> <move#> <category> [note], e.g. tutor tag g12 14 shape \"empty triangle\"");
        }
        const moveNumber = parseIntStrict(moveRaw, "move#");
        if (!MISTAKE_CATEGORIES.includes(category as MistakeCategory)) {
          throw new UsageError(`category must be one of ${MISTAKE_CATEGORIES.join(", ")}, got "${category}"`);
        }
        const note = noteParts.join(" ").trim();
        return cmd({ type: "tag", gameId, moveNumber, category: category as MistakeCategory, ...(note && { note }) });
      }
      default:
        throw new UsageError(`unknown command "${name}"`);
    }
  })();
  flags.done();
  return result;
}
