// Persistence under data/ (GO_TUTOR_DATA overrides): games as SGF + JSON, the learner profile,
// and the tutor event log. Everything is synchronous: the app is local and single-user, and
// sync writes keep the on-disk order identical to the order things happened in.

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MISTAKE_CATEGORIES, TUTOR_LEVELS, type MistakeCategory, type Profile, type SavedGame, type TutorEvent, type TutorLevel } from "../shared/types.ts";
import { withBuiltins, type StoredProblem } from "./problems.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function defaultProfile(): Profile {
  return {
    botRank: "20k",
    rating: 10,
    handicap: 0,
    ratingHistory: [],
    mistakeThreshold: 4,
    thresholdHistory: [],
    mistakeCounts: Object.fromEntries(MISTAKE_CATEGORIES.map((c) => [c, 0])) as Record<MistakeCategory, number>,
    recentMistakes: [],
    recentGames: [],
    practiced: {},
    gamesPlayed: 0,
    problemsSolved: 0,
    tutorLevel: "coach",
  };
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.GO_TUTOR_DATA || join(REPO_ROOT, "data"));
}

const GAME_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidGameId(id: string): boolean {
  return GAME_ID.test(id);
}

/** Write to a temp file and rename it over the target, so readers never see half a file. */
function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true }); // the data dir may have been removed while running
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** By default the event log is rotated to events.1.jsonl (replacing the previous one) once it grows past this. */
export const EVENT_LOG_MAX_BYTES = 8 * 1024 * 1024;
/** The log is read from its end backwards in chunks of this size. */
const READ_CHUNK_BYTES = 64 * 1024;

/** Index entry per saved game, so finding the newest one doesn't parse every game. */
interface GameIndexEntry {
  createdAt: number;
  /** Played to a result (not abandoned). */
  finished: boolean;
}

function indexEntry(game: SavedGame): GameIndexEntry {
  return { createdAt: game.createdAt ?? 0, finished: !!game.result && game.result.reason !== "abandon" };
}

/** Ids in id order, numeric suffixes compared as numbers ("-9" before "-10"). */
function sortIds(ids: string[]): string[] {
  return ids.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/**
 * Visits a file's lines from its end backwards, newest first, reading fixed chunks and each byte
 * once; a line split across chunks is kept until its start is read. Stops when `visit` returns
 * true. Returns the bytes read (for tests).
 */
export function readLinesBackward(path: string, visit: (line: string) => boolean, chunkBytes = READ_CHUNK_BYTES): number {
  if (!existsSync(path)) return 0;
  const fd = openSync(path, "r");
  let read = 0;
  try {
    let pos = fstatSync(fd).size;
    /** The start of the file so far read: everything before its first newline is a partial line. */
    let rest = Buffer.alloc(0);
    while (pos > 0) {
      const len = Math.min(chunkBytes, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      readSync(fd, chunk, 0, len, pos);
      read += len;
      const buf = rest.length ? Buffer.concat([chunk, rest]) : chunk;
      // Newlines are single bytes in UTF-8, so splitting on them never cuts a character.
      let end = buf.length;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] !== 0x0a) continue;
        if (visit(buf.toString("utf8", i + 1, end))) return read;
        end = i;
      }
      rest = buf.subarray(0, end);
    }
    if (rest.length) visit(rest.toString("utf8"));
    return read;
  } finally {
    closeSync(fd);
  }
}

/** An event from a log line, or null for a blank or torn line (a crash mid-write). */
function parseEvent(line: string): TutorEvent | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as TutorEvent;
  } catch {
    return null;
  }
}

/**
 * The events in a log file with seq > since, oldest first, read from the end backwards only as far
 * as needed. `reached` says whether the file goes back to `since` (otherwise older ones are in the
 * rotated log).
 */
function eventsAfter(path: string, since: number): { events: TutorEvent[]; reached: boolean } {
  const events: TutorEvent[] = [];
  let reached = false;
  readLinesBackward(path, (line) => {
    const event = parseEvent(line);
    if (!event) return false;
    if (event.seq <= since) return (reached = true);
    events.push(event);
    return false;
  });
  events.reverse();
  // A file that starts right after `since` holds everything newer too.
  if (!reached && events[0] && events[0].seq <= since + 1) reached = true;
  return { events, reached };
}

/** Whether the file's last byte is something other than a newline (a line torn by a crash). */
function endsMidLine(path: string): boolean {
  if (!existsSync(path)) return false;
  const size = statSync(path).size;
  if (size === 0) return false;
  const fd = openSync(path, "r");
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

export class Store {
  readonly dir: string;
  /** Bytes in events.jsonl, once the first append has looked at it. */
  private eventLogBytes: number | null = null;
  /** games/index.json in memory: read (and checked against the files) once, then kept up to date by saveGame. */
  private gameIndex: Map<string, GameIndexEntry> | null = null;

  private readonly maxEventLogBytes: number;

  constructor(dir: string = defaultDataDir(), opts: { maxEventLogBytes?: number } = {}) {
    this.dir = resolve(dir);
    this.maxEventLogBytes = opts.maxEventLogBytes ?? EVENT_LOG_MAX_BYTES;
    mkdirSync(this.gamesDir, { recursive: true });
  }

  private get gamesDir(): string {
    return join(this.dir, "games");
  }

  private get profilePath(): string {
    return join(this.dir, "profile.json");
  }

  private get eventsPath(): string {
    return join(this.dir, "events.jsonl");
  }

  private get rotatedEventsPath(): string {
    return join(this.dir, "events.1.jsonl");
  }

  private get indexPath(): string {
    return join(this.gamesDir, "index.json");
  }

  private get problemsPath(): string {
    return join(this.dir, "problems.json");
  }

  // --- profile -------------------------------------------------------------

  /** The profile, with defaults for anything missing. A corrupt file is set aside, not lost. */
  loadProfile(): Profile {
    const base = defaultProfile();
    if (!existsSync(this.profilePath)) return base;
    try {
      const saved = JSON.parse(readFileSync(this.profilePath, "utf8")) as Partial<Profile>;
      const tutorLevel = TUTOR_LEVELS.includes(saved.tutorLevel as TutorLevel) ? saved.tutorLevel! : base.tutorLevel;
      return { ...base, ...saved, mistakeCounts: { ...base.mistakeCounts, ...saved.mistakeCounts }, tutorLevel };
    } catch {
      renameSync(this.profilePath, `${this.profilePath}.corrupt-${Date.now()}`);
      return base;
    }
  }

  saveProfile(profile: Profile): void {
    writeAtomic(this.profilePath, JSON.stringify(profile, null, 2) + "\n");
  }

  // --- practice problems ---------------------------------------------------

  /**
   * Every practice problem: the learner's (problems.json) and the built-in set, whose progress is
   * stored there too. A corrupt file is set aside, not lost.
   */
  loadProblems(): StoredProblem[] {
    let stored: StoredProblem[] = [];
    if (existsSync(this.problemsPath)) {
      try {
        const saved = JSON.parse(readFileSync(this.problemsPath, "utf8")) as { problems?: StoredProblem[] };
        stored = Array.isArray(saved.problems) ? saved.problems : [];
      } catch {
        renameSync(this.problemsPath, `${this.problemsPath}.corrupt-${Date.now()}`);
      }
    }
    return withBuiltins(stored);
  }

  saveProblems(problems: readonly StoredProblem[]): void {
    writeAtomic(this.problemsPath, JSON.stringify({ version: 1, problems }, null, 1) + "\n");
  }

  // --- games ---------------------------------------------------------------

  gameExists(id: string): boolean {
    return isValidGameId(id) && existsSync(join(this.gamesDir, `${id}.json`));
  }

  saveGame(game: SavedGame, sgf: string): void {
    if (!isValidGameId(game.id)) throw new Error(`Invalid game id "${game.id}"`);
    const index = this.loadIndex();
    writeAtomic(join(this.gamesDir, `${game.id}.sgf`), sgf);
    writeAtomic(join(this.gamesDir, `${game.id}.json`), JSON.stringify(game) + "\n");
    const entry = indexEntry(game);
    const old = index.get(game.id);
    if (old?.createdAt !== entry.createdAt || old.finished !== entry.finished) {
      index.set(game.id, entry);
      this.writeIndex(index);
    }
  }

  loadGame(id: string): SavedGame | null {
    if (!this.gameExists(id)) return null;
    try {
      return JSON.parse(readFileSync(join(this.gamesDir, `${id}.json`), "utf8")) as SavedGame;
    } catch {
      return null;
    }
  }

  /** Saved game ids on disk in id order, numeric suffixes compared as numbers ("-9" before "-10"). */
  gameIds(): string[] {
    if (!existsSync(this.gamesDir)) return [];
    return sortIds(
      readdirSync(this.gamesDir)
        .filter((f) => f.endsWith(".json") && f !== "index.json")
        .map((f) => f.slice(0, -".json".length))
        .filter(isValidGameId),
    );
  }

  /**
   * The newest saved game by creation time, ties broken by id; with `finished`, the newest one played
   * to a result (not abandoned). Ids are local time, so on their own they misorder across a clock change.
   */
  lastGame(opts: { finished?: boolean } = {}): SavedGame | null {
    const index = this.loadIndex();
    // Newest first: ids are in id order, and the sort is stable, so equal createdAt keeps the later id first.
    const ids = sortIds([...index.keys()])
      .reverse()
      .filter((id) => !opts.finished || index.get(id)?.finished)
      .sort((a, b) => (index.get(b)?.createdAt ?? 0) - (index.get(a)?.createdAt ?? 0));
    for (const id of ids) {
      const game = this.loadGame(id);
      if (game) return game; // a corrupt file falls through to the next newest
    }
    return null;
  }

  /**
   * games/index.json (createdAt and finished per id). The first call reads it and brings it in step
   * with the files on disk: a game missing from it (an older data dir, a crash between writes) is
   * read once and added. After that it lives in memory and saveGame keeps it current.
   */
  private loadIndex(): Map<string, GameIndexEntry> {
    if (this.gameIndex) return this.gameIndex;
    const index = new Map<string, GameIndexEntry>();
    try {
      const saved = JSON.parse(readFileSync(this.indexPath, "utf8")) as Record<string, GameIndexEntry>;
      for (const [id, entry] of Object.entries(saved)) index.set(id, entry);
    } catch {
      // Missing or corrupt: rebuilt below.
    }
    const ids = this.gameIds();
    const present = new Set(ids);
    let changed = false;
    for (const id of [...index.keys()]) {
      if (present.has(id)) continue;
      index.delete(id);
      changed = true;
    }
    this.gameIndex = index;
    for (const id of ids) {
      if (index.has(id)) continue;
      const game = this.loadGame(id);
      if (!game) continue;
      index.set(id, indexEntry(game));
      changed = true;
    }
    if (changed) this.writeIndex(index);
    return index;
  }

  private writeIndex(index: Map<string, GameIndexEntry>): void {
    try {
      writeAtomic(this.indexPath, JSON.stringify(Object.fromEntries(index)) + "\n");
    } catch {
      // The index is a cache; it is rebuilt from the games when missing.
    }
  }

  // --- tutor event log -----------------------------------------------------

  /** Append one event; `json` is the event already stringified, when the caller has it. */
  appendEvent(event: TutorEvent, json = JSON.stringify(event)): void {
    mkdirSync(this.dir, { recursive: true }); // the data dir may have been removed while running
    if (this.eventLogBytes === null) {
      // A crash can leave half a line; end it so the next event starts on a line of its own.
      if (endsMidLine(this.eventsPath)) appendFileSync(this.eventsPath, "\n");
      this.eventLogBytes = existsSync(this.eventsPath) ? statSync(this.eventsPath).size : 0;
    }
    if (this.eventLogBytes > this.maxEventLogBytes) {
      renameSync(this.eventsPath, this.rotatedEventsPath);
      this.eventLogBytes = 0;
    }
    const line = json + "\n";
    appendFileSync(this.eventsPath, line);
    this.eventLogBytes += Buffer.byteLength(line);
  }

  /**
   * Logged events with seq > since, oldest first (the rotated log too, when needed), read from the
   * end of the log backwards only as far as `since`. Unparseable lines are skipped.
   */
  readEvents(since = -Infinity): TutorEvent[] {
    const current = eventsAfter(this.eventsPath, since);
    if (current.reached) return current.events;
    return [...eventsAfter(this.rotatedEventsPath, since).events, ...current.events];
  }

  /** The seq of the last logged event, or 0. Reads the log from its end back to its last complete event. */
  lastEventSeq(): number {
    for (const path of [this.eventsPath, this.rotatedEventsPath]) {
      let seq: number | null = null;
      readLinesBackward(path, (line) => {
        seq = parseEvent(line)?.seq ?? null;
        return seq !== null;
      });
      if (seq !== null) return seq;
    }
    return 0;
  }
}
