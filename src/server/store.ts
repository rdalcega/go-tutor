// Persistence under data/ (GO_TUTOR_DATA overrides): games as SGF + JSON, the learner profile,
// and the tutor event log. Everything is synchronous: the app is local and single-user, and
// sync writes keep the on-disk order identical to the order things happened in.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChatMessage,
  GameResult,
  GameSettings,
  GameSummary,
  MistakeCategory,
  MoveRecord,
  Profile,
  TeachingMoment,
  TutorEvent,
} from "../shared/types.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const MISTAKE_CATEGORIES: readonly MistakeCategory[] = [
  "life_and_death",
  "capturing_race",
  "opening",
  "direction",
  "shape",
  "endgame",
  "tactics",
  "other",
];

/** games/<id>.json. GET /api/game/:id returns this as is. */
export interface SavedGame {
  id: string;
  settings: GameSettings;
  createdAt: number;
  updatedAt: number;
  moves: MoveRecord[];
  result: GameResult | null;
  summary: GameSummary | null;
  /** Chat messages from this game. */
  chat: ChatMessage[];
  /** Mistake tags by move number, set with `tutor tag`. */
  tags: Record<number, { category: MistakeCategory; note?: string }>;
  /** The teaching moment as of the last save, so a restart can tell an open one from a dismissed one. */
  moment?: TeachingMoment | null;
}

export function defaultProfile(): Profile {
  return {
    botRank: "20k",
    rating: 10,
    ratingHistory: [],
    mistakeThreshold: 4,
    mistakeCounts: Object.fromEntries(MISTAKE_CATEGORIES.map((c) => [c, 0])) as Record<MistakeCategory, number>,
    recentMistakes: [],
    gamesPlayed: 0,
    problemsSolved: 0,
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
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** By default the event log is rotated to events.1.jsonl (replacing the previous one) once it grows past this. */
export const EVENT_LOG_MAX_BYTES = 8 * 1024 * 1024;
/** How much of the log's end is read to find the last seq. */
const TAIL_BYTES = 64 * 1024;

/** Index entry per saved game, so finding the newest one doesn't parse every game. */
interface GameIndexEntry {
  createdAt: number;
  /** Played to a result (not abandoned). */
  finished: boolean;
}

function indexEntry(game: SavedGame): GameIndexEntry {
  return { createdAt: game.createdAt ?? 0, finished: !!game.result && game.result.reason !== "abandon" };
}

/** The complete lines in the last `bytes` of a file, oldest first. */
function tailLines(path: string, bytes: number): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift(); // starts mid-line
  return lines;
}

function parseEvents(lines: string[], since: number): TutorEvent[] {
  const events: TutorEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as TutorEvent;
      if (event.seq > since) events.push(event);
    } catch {
      // A torn last line after a crash; ignore it.
    }
  }
  return events;
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
  private gameIndex: Map<string, GameIndexEntry> | null = null;

  private readonly maxEventLogBytes: number;

  constructor(dir: string = defaultDataDir(), opts: { maxEventLogBytes?: number } = {}) {
    this.dir = resolve(dir);
    this.maxEventLogBytes = opts.maxEventLogBytes ?? EVENT_LOG_MAX_BYTES;
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

  // --- profile -------------------------------------------------------------

  /** The profile, with defaults for anything missing. A corrupt file is set aside, not lost. */
  loadProfile(): Profile {
    const base = defaultProfile();
    if (!existsSync(this.profilePath)) return base;
    try {
      const saved = JSON.parse(readFileSync(this.profilePath, "utf8")) as Partial<Profile>;
      return { ...base, ...saved, mistakeCounts: { ...base.mistakeCounts, ...saved.mistakeCounts } };
    } catch {
      renameSync(this.profilePath, `${this.profilePath}.corrupt-${Date.now()}`);
      return base;
    }
  }

  saveProfile(profile: Profile): void {
    writeAtomic(this.profilePath, JSON.stringify(profile, null, 2) + "\n");
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

  /** Saved game ids in id order, numeric suffixes compared as numbers ("-9" before "-10"). */
  gameIds(): string[] {
    if (!existsSync(this.gamesDir)) return [];
    return readdirSync(this.gamesDir)
      .filter((f) => f.endsWith(".json") && f !== "index.json")
      .map((f) => f.slice(0, -".json".length))
      .filter(isValidGameId)
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  }

  /**
   * The newest saved game by creation time, ties broken by id; with `finished`, the newest one played
   * to a result (not abandoned). Ids are local time, so on their own they misorder across a clock change.
   */
  lastGame(opts: { finished?: boolean } = {}): SavedGame | null {
    const index = this.loadIndex();
    // Newest first: ids are in id order, and the sort is stable, so equal createdAt keeps the later id first.
    const ids = this.gameIds()
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
   * games/index.json (createdAt and finished per id), kept in step with the files on disk: a game
   * missing from it (an older data dir, a crash between writes) is read once and added.
   */
  private loadIndex(): Map<string, GameIndexEntry> {
    if (!this.gameIndex) {
      this.gameIndex = new Map();
      try {
        const saved = JSON.parse(readFileSync(this.indexPath, "utf8")) as Record<string, GameIndexEntry>;
        for (const [id, entry] of Object.entries(saved)) this.gameIndex.set(id, entry);
      } catch {
        // Missing or corrupt: rebuilt below.
      }
    }
    const index = this.gameIndex;
    const ids = this.gameIds();
    const present = new Set(ids);
    let changed = false;
    for (const id of [...index.keys()]) {
      if (present.has(id)) continue;
      index.delete(id);
      changed = true;
    }
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

  appendEvent(event: TutorEvent): void {
    mkdirSync(this.dir, { recursive: true });
    if (this.eventLogBytes === null) {
      // A crash can leave half a line; end it so the next event starts on a line of its own.
      if (endsMidLine(this.eventsPath)) appendFileSync(this.eventsPath, "\n");
      this.eventLogBytes = existsSync(this.eventsPath) ? statSync(this.eventsPath).size : 0;
    }
    if (this.eventLogBytes > this.maxEventLogBytes) {
      renameSync(this.eventsPath, this.rotatedEventsPath);
      this.eventLogBytes = 0;
    }
    const line = JSON.stringify(event) + "\n";
    appendFileSync(this.eventsPath, line);
    this.eventLogBytes += Buffer.byteLength(line);
  }

  /** Logged events with seq > since, oldest first (the rotated log too, when needed). Unparseable lines are skipped. */
  readEvents(since = -Infinity): TutorEvent[] {
    const read = (path: string) => (existsSync(path) ? parseEvents(readFileSync(path, "utf8").split("\n"), since) : []);
    const current = read(this.eventsPath);
    const first = current[0];
    if (first && first.seq <= since + 1) return current;
    return [...read(this.rotatedEventsPath), ...current];
  }

  /** The highest seq in the log, or 0. Reads only the end of the log (more if its last line is huge). */
  lastEventSeq(): number {
    for (const path of [this.eventsPath, this.rotatedEventsPath]) {
      if (!existsSync(path)) continue;
      const size = statSync(path).size;
      for (let bytes = TAIL_BYTES; ; bytes *= 4) {
        const events = parseEvents(tailLines(path, bytes), -Infinity);
        if (events.length > 0) return events.reduce((max, e) => Math.max(max, e.seq), 0);
        if (bytes >= size) break;
      }
    }
    return 0;
  }
}
