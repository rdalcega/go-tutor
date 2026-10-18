// Test doubles for the server: a scriptable engine and a manual clock.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { boardFromDiagram } from "../../src/engine/index.ts";
import type { Gtp } from "../../src/shared/types.ts";
import type { Clock } from "../../src/server/common.ts";
import type { GameEngine } from "../../src/server/game.ts";
import { abortError, resolveKataGoPaths, sideToMove, type Analysis, type AnalyzeOptions, type Position } from "../../src/server/katago.ts";
import { positionHash, promptFor, stonesOf, type StoredProblem } from "../../src/server/problems.ts";
import { Store } from "../../src/server/store.ts";

/** Whether the real KataGo (binary, config and nets) is installed, for the tests that need it. */
export function hasKataGo(): boolean {
  try {
    resolveKataGoPaths();
    return true;
  } catch {
    return false;
  }
}

export class FakeClock implements Clock {
  t = Date.UTC(2026, 9, 15, 12, 0, 0);
  private nextId = 1;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  /** Timers fire this many ms before they are due (the clock reads that time while they run). */
  earlyMs = 0;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at - this.earlyMs <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.t = Math.max(this.t, due.at - this.earlyMs);
      due.fn();
    }
    this.t = end;
  }
}

interface Held {
  release: () => void;
}

/**
 * Score leads are set per position (the moves as a space-separated GTP list), from the side to
 * move's view, like KataGo with SIDETOMOVE. `lossAfter(["C3"], 6)` makes the human's C3 cost 6.
 */
export class FakeEngine implements GameEngine {
  readonly leads = new Map<string, number>();
  /** KataGo's preferred move in every position, and its PV. */
  best: Gtp = "E5";
  pv: Gtp[] = ["E5", "D4", "D5"];
  /** Best move and PV for particular positions (moves as GTP list), overriding `best` and `pv`. */
  readonly lines = new Map<string, { best: Gtp; pv: Gtp[] }>();
  /** More candidates after the best for particular positions (moves as GTP list), with their own lead and visits. */
  readonly candidates = new Map<string, { move: Gtp; scoreLead: number; visits: number }[]>();
  /** Queries KataGo would run at once (unset: the controller's default). */
  concurrency?: number;
  /** Analyses fail while true. */
  failAnalyze = false;
  /** Bot moves to play, in order; when empty the bot picks the first empty point from the top-left. */
  botMoves: Gtp[] = [];
  /** Ownership for includeOwnership queries (Black's view), by board size and position (moves as GTP list); default all zero. */
  ownership: ((size: number, moves: string) => number[]) | null = null;
  /**
   * The human-SL policy for policy queries with a humanSLProfile (size*size+1 entries), by position
   * and profile (e.g. "rank_5k"); default uniform, which every profile explains equally (an estimate at 20k).
   */
  humanPolicy: ((pos: Position, profile: string) => number[]) | null = null;
  /** Answers particular analyses itself (undefined: the default answer above). */
  respond: ((pos: Position, opts?: AnalyzeOptions) => Analysis | undefined) | null = null;
  /** When true, replies wait for release(). */
  hold = false;
  readonly held: Held[] = [];
  analyzeCalls: { pos: Position; opts?: AnalyzeOptions }[] = [];
  botCalls: Position[] = [];
  failBot = false;

  lossAfter(moves: Gtp[], loss: number): void {
    // The opponent is to move after the human's move, so they lead by `loss`.
    this.leads.set(moves.join(" "), loss);
  }

  releaseAll(): void {
    for (const h of this.held.splice(0)) h.release();
  }

  /** Like KataGo, a cancelled query (`signal`) rejects with an AbortError, also while held. */
  private reply<T>(make: () => T, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const run = () => {
        if (settled) return;
        settled = true;
        try {
          if (signal?.aborted) throw abortError();
          resolve(make());
        } catch (err) {
          reject(err as Error);
        }
      };
      signal?.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        reject(abortError());
      });
      if (this.hold) this.held.push({ release: run });
      else queueMicrotask(run);
    });
  }

  analyze(pos: Position, opts?: AnalyzeOptions): Promise<Analysis> {
    this.analyzeCalls.push({ pos, opts });
    return this.reply(() => {
      if (this.failAnalyze) throw new Error("fake analysis failure");
      const custom = this.respond?.(pos, opts);
      if (custom) return custom;
      const key = pos.moves.map((m) => m[1]).join(" ");
      const lead = this.leads.get(key) ?? 0;
      const line = this.lines.get(key) ?? { best: this.best, pv: this.pv };
      const analysis: Analysis = {
        id: `fake${this.analyzeCalls.length}`,
        toPlay: sideToMove(pos),
        rootInfo: { scoreLead: lead, winrate: 0.5, visits: 400 },
        moveInfos: [
          { move: line.best, scoreLead: lead, winrate: 0.5, visits: 300, order: 0, prior: 0.4, pv: line.pv },
          ...(this.candidates.get(key) ?? []).map((c, i) => ({ ...c, winrate: 0.5, order: i + 1, prior: 0.1, pv: [c.move] })),
        ],
      };
      if (opts?.includeOwnership) analysis.ownership = this.ownership?.(pos.size, key) ?? new Array(pos.size * pos.size).fill(0);
      const profile = opts?.overrideSettings?.humanSLProfile;
      if (opts?.includePolicy && typeof profile === "string") {
        const n = pos.size * pos.size + 1;
        analysis.humanPolicy = this.humanPolicy?.(pos, profile) ?? new Array(n).fill(1 / n);
      }
      return analysis;
    }, opts?.signal);
  }

  botMove(pos: Position): Promise<Gtp> {
    this.botCalls.push(pos);
    return this.reply(() => {
      if (this.failBot) throw new Error("fake bot failure");
      const next = this.botMoves.shift();
      if (next) return next;
      const taken = new Set(pos.moves.map((m) => m[1]));
      const cols = "ABCDEFGHJ";
      for (let row = pos.size; row >= 1; row--) {
        for (const c of cols.slice(0, pos.size)) if (!taken.has(`${c}${row}`)) return `${c}${row}`;
      }
      return "pass";
    });
  }
}

/** Temp dirs made by `tempDir` in this test file, removed after its tests (and, as a fallback, on exit). */
const tempDirs: string[] = [];

function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

afterAll(async () => {
  // A controller's end-of-tick save from the last test would otherwise recreate its dir.
  await flush(10);
  removeTempDirs();
});
process.on("exit", removeTempDirs);

/** A new empty go-tutor-test-* directory, deleted after the test file's tests. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "go-tutor-test-"));
  tempDirs.push(dir);
  return dir;
}

export function tempStore(): Store {
  return new Store(tempDir());
}

/**
 * A generated 9×9 problem: Black's group at the bottom lives with E1 (a straight three's middle);
 * D1 and F1 are the wrong eye points. Other problems take `overrides` (a different id needs a
 * different `hash` to be stored next to it).
 */
export function liveProblem(overrides: Partial<StoredProblem> = {}): StoredProblem {
  const board = boardFromDiagram([
    ". . . . . . . . .",
    ". . . . . . . . .",
    ". . . . . . . . .",
    "X X X X X X X X X",
    "O O O O O O O O O",
    ". . . . . . . . .",
    "O O O O O O O O O",
    ". O X X X X X O .",
    ". O X . . . X O .",
  ]);
  return {
    id: "gen1",
    kind: "generated",
    size: 9,
    komi: 7,
    stones: stonesOf(board),
    toPlay: "B",
    prompt: promptFor("life_and_death", "B"),
    category: "life_and_death",
    answers: ["E1"],
    bestMove: "E1",
    bestPv: ["E1", "D8", "E8"],
    difficulty: 12,
    source: {
      kind: "generated",
      batchId: "batch1",
      weakerRank: "20k",
      strongerRank: "15k",
      difficultyRank: "17k",
      difficultyRating: 13.2,
      moveNumber: 30,
      played: "D1",
      swapped: false,
    },
    hash: positionHash(board, "B"),
    createdAt: 0,
    box: 1,
    due: 0,
    seen: 0,
    solves: 0,
    ...overrides,
  };
}

/** Stores these problems (replacing any), for tests that need practice problems to exist. */
export function seedProblems(store: Store, problems: StoredProblem[] = [liveProblem()]): void {
  store.saveProblems(problems);
}

/** Let queued promise callbacks and setImmediate work run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setImmediate(r));
}
