// Test doubles for the server: a scriptable engine and a manual clock.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Gtp } from "../../src/shared/types.ts";
import type { Clock, GameEngine } from "../../src/server/game.ts";
import { sideToMove, type Analysis, type AnalyzeOptions, type Position } from "../../src/server/katago.ts";
import { Store } from "../../src/server/store.ts";

export class FakeClock implements Clock {
  t = Date.UTC(2026, 9, 15, 12, 0, 0);
  private nextId = 1;
  private timers: { id: number; at: number; fn: () => void }[] = [];

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
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.t = due.at;
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

  private reply<T>(make: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        try {
          resolve(make());
        } catch (err) {
          reject(err as Error);
        }
      };
      if (this.hold) this.held.push({ release: run });
      else queueMicrotask(run);
    });
  }

  analyze(pos: Position, opts?: AnalyzeOptions): Promise<Analysis> {
    this.analyzeCalls.push({ pos, opts });
    return this.reply(() => {
      if (this.failAnalyze) throw new Error("fake analysis failure");
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
      return analysis;
    });
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

export function tempStore(): Store {
  return new Store(mkdtempSync(join(tmpdir(), "go-tutor-test-")));
}

/** Let queued promise callbacks and setImmediate work run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setImmediate(r));
}
