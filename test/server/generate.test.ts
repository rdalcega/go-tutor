// Generated practice problems (src/server/generate.ts): the pure helpers, the candidate filters,
// and the generator against a scripted fake engine (batches, persistence, the trigger, yielding).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GoGame, boardFromDiagram, emptyBoard } from "../../src/engine/index.ts";
import { fromGtp, toGtp } from "../../src/shared/coords.ts";
import type { Board, Color, Gtp } from "../../src/shared/types.ts";
import type { TutorEventInput } from "../../src/server/common.ts";
import { GameController } from "../../src/server/game.ts";
import {
  BATCH_SIZE,
  CONFIRM_VISITS,
  POLL_MS,
  ProblemGenerator,
  SIZE_SETTINGS,
  bandDistance,
  batchQuotas,
  batchRanks,
  difficultyBand,
  difficultyRating,
  examineCandidate,
  flippedPoints,
  isLocal,
  masteryNeeded,
  nextBatchTrigger,
  nextGeneratedId,
  normalizeGeneration,
  removeLegacyBuiltins,
  swapColors,
  wrongGap,
  type CandidateInput,
  type GenerationFile,
  type GeneratorDeps,
} from "../../src/server/generate.ts";
import { GENERATION_PRIORITY, isAbortError, sideToMove, type Analysis, type AnalyzeOptions, type MoveInfo, type Position } from "../../src/server/katago.ts";
import { generatedSource, positionHash, problemGame, type StoredProblem } from "../../src/server/problems.ts";
import type { Store } from "../../src/server/store.ts";
import { FakeClock, FakeEngine, flush, liveProblem, tempStore } from "./fakes.ts";

const at = (gtp: Gtp, size = 9) => fromGtp(gtp, size)!;

describe("batches", () => {
  it("splits each batch 7/7/6, rotating which size gets 6 (19×19 first)", () => {
    expect(batchQuotas(1)).toEqual({ 9: 7, 13: 7, 19: 6 });
    expect(batchQuotas(2)).toEqual({ 9: 7, 13: 6, 19: 7 });
    expect(batchQuotas(3)).toEqual({ 9: 6, 13: 7, 19: 7 });
    expect(batchQuotas(4)).toEqual(batchQuotas(1));
    for (let n = 1; n <= 6; n++) expect(Object.values(batchQuotas(n)).reduce((a, b) => a + b)).toBe(BATCH_SIZE);
  });

  it("puts the weaker side at the learner's rank and the other 5 ranks stronger, inside 20k–9d", () => {
    expect(batchRanks(10)).toEqual({ weaker: "20k", stronger: "15k" });
    expect(batchRanks(13.6)).toEqual({ weaker: "16k", stronger: "11k" });
    expect(batchRanks(4)).toEqual({ weaker: "20k", stronger: "15k" }); // below KataGo's weakest profile
    expect(batchRanks(35)).toEqual({ weaker: "6d", stronger: "9d" });
    expect(batchRanks(38)).toEqual({ weaker: "9d", stronger: "9d" });
  });

  it("prefers difficulties from the learner's rank to 4 ranks stronger", () => {
    expect(difficultyBand(10.4)).toEqual([10, 14]);
    expect(difficultyBand(37)).toEqual([37, 38]);
    expect(bandDistance(12, [10, 14])).toBe(0);
    expect(bandDistance(8.5, [10, 14])).toBe(1.5);
    expect(bandDistance(20, [10, 14])).toBe(6);
  });

  it("names generated problems gen1, gen2, … after the highest one", () => {
    expect(nextGeneratedId([])).toBe("gen1");
    expect(nextGeneratedId([{ id: "p7" }, { id: "gen3" }, { id: "gen12" }])).toBe("gen13");
  });
});

describe("the next batch's trigger", () => {
  const batch = (id: string, finished: boolean) => ({
    id,
    number: Number(id.slice(5)),
    weakerRank: "20k",
    strongerRank: "15k",
    trigger: "first" as const,
    band: [10, 14] as [number, number],
    quotas: batchQuotas(1),
    createdAt: 0,
    ...(finished && { finishedAt: 1 }),
    problemIds: [],
    stats: { 9: stats(), 13: stats(), 19: stats() },
  });
  const stats = () => ({ found: 0, games: 0, moves: 0, ms: 0, screened: 0, candidates: 0, rejected: {}, reserved: 0 });
  const problems = (mastered: number, total = 20) =>
    Array.from({ length: total }, (_, i) =>
      liveProblem({ id: `gen${i + 1}`, hash: `h${i}`, box: i < mastered ? 3 + (i % 3) : 2 }),
    );

  it("starts the first batch when there is none, and never while one is in progress", () => {
    expect(nextBatchTrigger({ version: 1, batches: [], progress: null }, [])).toBe("first");
    const running: GenerationFile = { version: 1, batches: [batch("batch1", false)], progress: { batchId: "batch1", game: null, reserve: [] } };
    expect(nextBatchTrigger(running, problems(20))).toBeNull();
  });

  it("repairs a generation file whose progress doesn't belong to an unfinished newest batch", () => {
    const stray: GenerationFile = { version: 1, batches: [], progress: { batchId: "batch7", game: null, reserve: [] } };
    expect(normalizeGeneration(stray)).toMatch(/batch7 dropped/);
    expect(stray.progress).toBeNull();
    const nameless: GenerationFile = { version: 1, batches: [batch("batch1", true)], progress: { game: null, reserve: [] } as unknown as GenerationFile["progress"] };
    expect(normalizeGeneration(nameless)).toMatch(/no batch dropped/);
    expect(nameless.progress).toBeNull();
    const abandoned: GenerationFile = { version: 1, batches: [batch("batch2", false)], progress: null };
    expect(normalizeGeneration(abandoned)).toMatch(/resuming batch2/);
    expect(abandoned.progress).toEqual({ batchId: "batch2", game: null, reserve: [] });
    const fine: GenerationFile = { version: 1, batches: [batch("batch2", false)], progress: { batchId: "batch2", game: null, reserve: [] } };
    expect(normalizeGeneration(fine)).toBeNull();
    expect(fine.progress?.batchId).toBe("batch2");
    const damaged: GenerationFile = { version: 1, batches: [batch("batch2", false)], progress: { batchId: "batch2", game: { size: 9 } } as unknown as GenerationFile["progress"] };
    expect(normalizeGeneration(damaged)).toMatch(/damaged progress for batch2 reset/);
    expect(damaged.progress).toEqual({ batchId: "batch2", game: null, reserve: [] });
  });

  it("starts the next batch once 15 of the newest batch's 20 problems are in box 3 or higher", () => {
    const file: GenerationFile = { version: 1, batches: [batch("batch1", true)], progress: null };
    expect(masteryNeeded(20)).toBe(15);
    expect(nextBatchTrigger(file, problems(14))).toBeNull();
    expect(nextBatchTrigger(file, problems(15))).toBe("mastery");
    // Another batch's problems don't count.
    const other = problems(20).map((p) => ({ ...p, source: { ...generatedSource(p)!, batchId: "batch0" } }));
    expect(nextBatchTrigger(file, other)).toBeNull();
  });
});

describe("candidate filters", () => {
  it("swaps every stone's color", () => {
    const board = boardFromDiagram([". X O", "O . X", ". . ."]);
    expect(swapColors(board)).toEqual(boardFromDiagram([". O X", "X . O", ". . ."]));
  });

  it("finds the stones of groups whose ownership flips, and empty points that flip", () => {
    const board = boardFromDiagram([". . . . .", ". X X . .", ". . . . .", ". . . O .", ". . . . ."]);
    const own = (values: Record<string, number>) => {
      const o = new Array(25).fill(0.05);
      for (const [gtp, v] of Object.entries(values)) {
        const p = fromGtp(gtp, 5)!;
        o[p.y * 5 + p.x] = v;
      }
      return o;
    };
    // Black's two stones go from alive (+0.8) to dead (-0.7); White's stone barely moves; A1 flips.
    const before = own({ B4: 0.8, C4: 0.8, D2: -0.9, A1: 0.6 });
    const after = own({ B4: -0.7, C4: -0.7, D2: -0.8, A1: -0.6 });
    expect(flippedPoints(board, before, after).map((p) => toGtp(p, 5)).sort()).toEqual(["A1", "B4", "C4"]);
    expect(flippedPoints(board, before, before)).toEqual([]);
    expect(flippedPoints(board, [], after)).toEqual([]);
  });

  it("calls a best move local within 2 lines of a recent move, or touching a point whose fate changed", () => {
    expect(isLocal(at("E5"), [at("C3")], [])).toBe(true); // two lines each way
    expect(isLocal(at("E5"), [at("B3"), at("H8")], [])).toBe(false);
    expect(isLocal(at("E5"), [at("A1")], [at("F6")])).toBe(true);
    expect(isLocal(at("E5"), [at("A1")], [at("G7")])).toBe(false);
  });

  it("measures how much worse the best move that isn't an answer is, among well-searched moves", () => {
    const c = (move: Gtp, lead: number, visits: number) => ({ move, lead, visits, pv: [move] });
    expect(wrongGap([c("E5", 3, 400), c("D5", 2.5, 100), c("C3", -1, 60), c("A1", 2.9, 3)], ["E5", "D5"])).toBe(4);
    expect(wrongGap([c("E5", 3, 400), c("pass", 1, 80)], ["E5"])).toBe(2);
    expect(wrongGap([c("E5", 3, 400)], ["E5"])).toBe(Infinity);
  });

  it("puts the difficulty where the answers' human-style probability first reaches 50%", () => {
    const ratings = [10, 12, 15, 18];
    expect(difficultyRating([0.6, 0.7, 0.8, 0.9], ratings)).toEqual({ rating: 10, floor: true, ceiling: false });
    expect(difficultyRating([0.1, 0.2, 0.3, 0.4], ratings)).toEqual({ rating: 18, floor: false, ceiling: true });
    // 0.3 at 12 and 0.7 at 15: halfway, 13.5.
    expect(difficultyRating([0.1, 0.3, 0.7, 0.9], ratings)).toEqual({ rating: 13.5, floor: false, ceiling: false });
    // The first crossing counts, even if a stronger profile dips again.
    expect(difficultyRating([0.2, 0.6, 0.4, 0.9], ratings).rating).toBe(11.5);
  });
});

// ---------------------------------------------------------------------------
// examineCandidate
// ---------------------------------------------------------------------------

/** An analysis for the fake engines below. */
function analysis(pos: Position, lead: number, moves: { move: Gtp; lead: number; visits: number }[] = [], extra: Partial<Analysis> = {}): Analysis {
  const moveInfos: MoveInfo[] = moves.map((m, i) => ({ move: m.move, scoreLead: m.lead, visits: m.visits, winrate: 0.5, order: i, prior: 0.1, pv: [m.move] }));
  return { id: "a", toPlay: sideToMove(pos), rootInfo: { scoreLead: lead, winrate: 0.5, visits: 400 }, moveInfos, ...extra };
}

/**
 * KataGo for one candidate: the problem position (no moves) has `best` (and the other searched
 * moves), the position after the mistake leaves the opponent `afterLead` ahead, and every human-SL
 * profile gives the answers `answerProb` in all.
 */
function candidateEngine(opts: { best: { move: Gtp; lead: number; visits: number }[]; afterLead: number; answerProb?: number[] | number }) {
  const calls: { pos: Position; opts: AnalyzeOptions }[] = [];
  let profile = 0;
  return {
    calls,
    analyze: async (pos: Position, o: AnalyzeOptions): Promise<Analysis> => {
      calls.push({ pos, opts: o });
      const n = pos.size * pos.size + 1;
      if (o.maxVisits === 1) {
        const p = Array.isArray(opts.answerProb) ? (opts.answerProb[profile++] ?? 0) : (opts.answerProb ?? 0.6);
        const policy = new Array(n).fill(0);
        const answer = fromGtp(opts.best[0]!.move, pos.size)!;
        policy[answer.y * pos.size + answer.x] = p;
        return analysis(pos, 0, [], { humanPolicy: policy });
      }
      if (pos.moves.length === 0) return analysis(pos, opts.best[0]!.lead, opts.best, { ownership: new Array(n - 1).fill(0) });
      return analysis(pos, opts.afterLead, [], { ownership: new Array(n - 1).fill(0) });
    },
  };
}

/** The game before a mistake: `moves` played from the empty 9×9 board, then the mistake is `played` by the side to move. */
function candidate(moves: Gtp[], played: Gtp, size: 9 | 13 | 19 = 9): CandidateInput {
  const game = new GoGame(size, 7);
  for (const m of moves) expect(game.playAt(at(m, size)).ok).toBe(true);
  const zeros = new Array(size * size).fill(0);
  const screen = (pos: Position) => analysis(pos, 0, [], { ownership: zeros });
  const pos: Position = { size, komi: 7, rules: "chinese", moves: [] };
  return {
    size,
    moveNumber: moves.length + 1,
    played,
    before: game,
    recent: moves.slice(-2),
    screenBefore: screen(pos),
    screenAfter: screen({ ...pos, moves: [["B", "A1"]] }),
  };
}

// Black to play after these moves; Black's mistake would be A9, far from the fight at D4.
const OPENING = ["D4", "E4", "D5", "E5", "D6", "E6"];

describe("examineCandidate", () => {
  it("turns a big, clear, local mistake into a problem with its category and difficulty", async () => {
    const engine = candidateEngine({
      best: [
        { move: "D7", lead: 2, visits: 600 },
        { move: "E7", lead: -4, visits: 200 },
      ],
      afterLead: 5, // after A9 White leads by 5: A9 loses 7
      answerProb: [0.1, 0.3, 0.7, 0.9, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    });
    const verdict = await examineCandidate(candidate(OPENING, "A9"), { analyze: engine.analyze, knownHashes: new Set() });
    expect(verdict).toMatchObject({ ok: true, metrics: { loss: 7, answers: 1, gap: 6, local: true } });
    if (!verdict.ok) throw new Error("expected a problem");
    expect(verdict.problem).toMatchObject({ size: 9, answers: ["D7"], bestMove: "D7", pointLoss: 7, moveNumber: 7, played: "A9", swapped: false });
    // 0.3 at 18k (12) and 0.7 at 15k (15): 13.5.
    expect(verdict.problem.difficultyRating).toBe(13.5);
    expect(verdict.problem.stones.B).toEqual(["D6", "D5", "D4"]);
    // The deeper analysis, the position after the mistake, then 13 policy queries (one per human-SL profile).
    expect(engine.calls.map((c) => c.opts.maxVisits)).toEqual([CONFIRM_VISITS, 800, ...new Array(13).fill(1)]);
    expect(engine.calls[0]!.pos).toMatchObject({ initialPlayer: "B", komi: 7, moves: [] });
    expect(engine.calls[2]!.opts.overrideSettings).toEqual({ humanSLProfile: "rank_20k" });
  });

  it("swaps the colors of a White mistake so Black is to play, and analyzes the swapped position", async () => {
    const engine = candidateEngine({ best: [{ move: "E7", lead: 1, visits: 600 }], afterLead: 6 });
    const input = candidate(OPENING.slice(0, 5), "A9"); // White to play
    expect(input.before.toPlay).toBe("W");
    const verdict = await examineCandidate(input, { analyze: engine.analyze, knownHashes: new Set() });
    if (!verdict.ok) throw new Error(`expected a problem, got ${verdict.reason}`);
    expect(verdict.problem.swapped).toBe(true);
    // White's stones are Black's now, and Black is to play.
    expect(verdict.problem.stones).toEqual({ B: ["E5", "E4"], W: ["D6", "D5", "D4"] });
    expect(verdict.problem.hash).toBe(positionHash(swapColors(input.before.board), "B"));
    expect(engine.calls[0]!.pos.initialStones).toContainEqual(["B", "E5"]);
    expect(engine.calls[1]!.pos.moves).toEqual([["B", "A9"]]);
    expect(problemGame({ size: 9, komi: 7, stones: verdict.problem.stones, toPlay: "B" }).toPlay).toBe("B");
  });

  it("drops a position the problems already have, a ko, and KataGo passing", async () => {
    const engine = candidateEngine({ best: [{ move: "D7", lead: 2, visits: 600 }], afterLead: 5 });
    const input = candidate(OPENING, "A9");
    const hash = positionHash(input.before.board, "B");
    expect(await examineCandidate(input, { analyze: engine.analyze, knownHashes: new Set([hash]) })).toEqual({ ok: false, reason: "duplicate" });
    expect(engine.calls).toHaveLength(0);

    // A ko: Black just took at E5's neighbor and White can't retake at once.
    const ko = new GoGame(9, 7);
    for (const m of ["D5", "E5", "E4", "F4", "E6", "F6", "A1", "G5", "F5"]) expect(ko.playAt(at(m)).ok).toBe(true);
    expect(ko.illegalReason(at("E5"))).toBe("ko");
    expect(await examineCandidate({ ...input, before: ko, played: "A9" }, { analyze: engine.analyze, knownHashes: new Set() })).toEqual({ ok: false, reason: "ko" });

    const passing = candidateEngine({ best: [{ move: "pass", lead: 0, visits: 600 }], afterLead: 5 });
    expect(await examineCandidate(input, { analyze: passing.analyze, knownHashes: new Set() })).toEqual({ ok: false, reason: "pass" });
  });

  it("drops a mistake the deeper analysis doesn't confirm, or with too many answers, or unclear, or not local", async () => {
    const run = async (best: { move: Gtp; lead: number; visits: number }[], afterLead: number, moves = OPENING) =>
      examineCandidate(candidate(moves, "A9"), { analyze: candidateEngine({ best, afterLead }).analyze, knownHashes: new Set() });
    // A9 loses only 3 in the deeper analysis.
    expect(await run([{ move: "D7", lead: 1, visits: 600 }], 2)).toMatchObject({ ok: false, reason: "not_confirmed", metrics: { loss: 3 } });
    // Four moves within a point of the best.
    const four = ["D7", "E7", "C7", "F7"].map((move, i) => ({ move, lead: 2 - i * 0.2, visits: 200 }));
    expect(await run(four, 5)).toMatchObject({ ok: false, reason: "too_many_answers", metrics: { answers: 4 } });
    // The best wrong move is only 2 points worse (9×9 wants 3).
    expect(await run([{ move: "D7", lead: 2, visits: 600 }, { move: "C7", lead: 0, visits: 200 }], 5)).toMatchObject({ ok: false, reason: "unclear", metrics: { gap: 2 } });
    // The best move is far from the last two moves (E6, D6) and nothing's fate changed.
    expect(await run([{ move: "J1", lead: 2, visits: 600 }], 5)).toMatchObject({ ok: false, reason: "not_local", metrics: { local: false } });
  });
});

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/**
 * The first `count` empty points of a position in reading order, from the top row (`fromTop`) or
 * from the bottom row backwards.
 */
function emptyPoints(pos: Position, count: number, fromTop = true): Gtp[] {
  const taken = new Set([...(pos.initialStones ?? []).map((s) => s[1]), ...pos.moves.map((m) => m[1])]);
  const out: Gtp[] = [];
  const cells = pos.size * pos.size;
  for (let i = 0; i < cells && out.length < count; i++) {
    const k = fromTop ? i : cells - 1 - i;
    const gtp = toGtp({ x: k % pos.size, y: Math.floor(k / pos.size) }, pos.size);
    if (!taken.has(gtp)) out.push(gtp);
  }
  return out;
}

/** Whether Black's stones in a problem position are in the top half (self-play below: Black fills from the top). */
function blackOnTop(pos: Position): boolean {
  const black = (pos.initialStones ?? []).find((s) => s[0] === "B");
  return !black || fromGtp(black[1], pos.size)!.y < pos.size / 2;
}

/**
 * KataGo for self-play: Black plays the first empty point in reading order from the top, White the
 * first from the bottom, so the two never touch and no stone is captured; every move "loses" 2 ×
 * `lead`, and both sides pass after `gameLength` moves. In a problem position, Black (to play)
 * continues from its own side: the first empty point there is where the mistake went, the second
 * is the best move, 6 points better than the third. The answers' human-SL probability is
 * `answerProb(position)`.
 */
function selfPlayEngine(opts: { lead?: number; gameLength?: number; answerProb?: (pos: Position) => number; fixedBest?: Gtp } = {}): FakeEngine {
  const engine = new FakeEngine();
  const lead = opts.lead ?? 5;
  /**
   * With `fixedBest`, every problem's best move is that (empty) point, and it is local because the
   * screening ownership there flips with every move of Black's (the weaker side of a first game).
   */
  const best = (pos: Position): Gtp => opts.fixedBest ?? emptyPoints(pos, 2, blackOnTop(pos))[1]!;
  engine.respond = (pos, o) => {
    const n = pos.size * pos.size + 1;
    const zeros = new Array(n - 1).fill(0);
    if (o?.maxVisits === 1) {
      const policy = new Array(n).fill(0);
      const p = fromGtp(best(pos), pos.size)!;
      policy[p.y * pos.size + p.x] = opts.answerProb?.(pos) ?? 0.6;
      return analysis(pos, 0, [], { humanPolicy: policy });
    }
    if (pos.initialStones) {
      if (pos.moves.length > 0) return analysis(pos, 10, [], { ownership: zeros });
      // Not the first empty point: that's where the mistake went.
      const wrong = emptyPoints(pos, 4, blackOnTop(pos))
        .slice(1)
        .filter((g) => g !== best(pos))
        .at(-1)!;
      return analysis(pos, 0, [{ move: best(pos), lead: 0, visits: 600 }, { move: wrong, lead: -6, visits: 200 }], { ownership: zeros });
    }
    const humanPolicy = new Array(n).fill(0);
    const next = fromGtp(emptyPoints(pos, 1, sideToMove(pos) === "B")[0]!, pos.size)!;
    humanPolicy[next.y * pos.size + next.x] = 1;
    const policy = new Array(n).fill(0);
    if (pos.moves.length >= (opts.gameLength ?? 30)) policy[n - 1] = 1; // pass: the game ends
    const ownership = [...zeros];
    if (opts.fixedBest) {
      const p = fromGtp(opts.fixedBest, pos.size)!;
      ownership[p.y * pos.size + p.x] = sideToMove(pos) === "B" ? 0.8 : -0.8;
    }
    return analysis(pos, lead, [], { ownership, humanPolicy, policy });
  };
  return engine;
}

interface Harness {
  generator: ProblemGenerator;
  engine: FakeEngine;
  store: Store;
  clock: FakeClock;
  events: TutorEventInput[];
  chat: string[];
  mayRun: { value: boolean };
  rating: { value: number };
}

function harness(engine = selfPlayEngine(), store = tempStore(), extra: Partial<GeneratorDeps> = {}): Harness {
  const clock = new FakeClock();
  const events: TutorEventInput[] = [];
  const chat: string[] = [];
  const mayRun = { value: true };
  const rating = { value: 10 };
  let generator: ProblemGenerator;
  generator = new ProblemGenerator({
    engine,
    store,
    clock,
    log: () => {},
    rating: () => rating.value,
    mayRun: () => mayRun.value,
    // As the controller's: every change is reported back to the generator.
    updateProblems: (change) => {
      const problems = store.loadProblems();
      const out = change(problems);
      store.saveProblems(problems);
      generator.problemsChanged(problems);
      return out;
    },
    changed: () => {},
    emit: (e) => events.push(e),
    system: (text) => chat.push(text),
    ...extra,
  });
  // A generator that never finishes would run on microtasks until memory runs out: stop it.
  let queries = 0;
  const respond = engine.respond;
  engine.respond = (pos, o) => {
    if (++queries > 20_000) {
      generator.stop();
      throw new Error("the generator ran away");
    }
    return respond?.(pos, o);
  };
  return { generator, engine, store, clock, events, chat, mayRun, rating };
}

/** Lets the generator run until `done` (or `steps` rounds of queued work have run). */
async function runUntil(h: Harness, done: () => boolean, steps = 400): Promise<void> {
  for (let i = 0; i < steps && !done(); i++) await flush(20);
}

/**
 * Stops the generator as soon as `done` holds (checked at each KataGo query): the fake engine
 * answers at once, so without it a whole batch runs before the test gets a turn.
 */
async function runUntilStopped(h: Harness, done: () => boolean): Promise<void> {
  const respond = h.engine.respond;
  h.engine.respond = (pos, o) => {
    if (done()) h.generator.stop();
    return respond?.(pos, o);
  };
  h.generator.start();
  await runUntil(h, () => done());
  h.generator.stop();
  await h.generator.idle();
  h.engine.respond = respond;
}

const generatedProblems = (store: Store) => store.loadProblems().filter((p) => p.kind === "generated");

describe("ProblemGenerator", () => {
  it("generates the first batch, 20k vs 15k, 7/7/6 problems from both colors' mistakes, Black to play", async () => {
    const h = harness();
    h.generator.start();
    expect(h.events[0]).toMatchObject({ type: "generation", status: "started", batch: { id: "batch1", weakerRank: "20k", strongerRank: "15k", trigger: "first", target: 20 } });
    expect(h.chat[0]).toContain("Your practice problems are being made");
    expect(h.generator.status()).toMatchObject({ state: "generating", current: { id: "batch1", found: 0, band: "20k–16k" } });
    await runUntil(h, () => !!h.generator.batches[0]?.finishedAt, 2000);
    await h.generator.idle();

    const batch = h.generator.batches[0]!;
    expect(batch.finishedAt).toBeDefined();
    const problems = generatedProblems(h.store);
    expect(problems).toHaveLength(20);
    expect(batch.problemIds).toEqual(problems.map((p) => p.id));
    const bySize = (size: number) => problems.filter((p) => p.size === size).length;
    expect([bySize(9), bySize(13), bySize(19)]).toEqual([7, 7, 6]);
    for (const p of problems) {
      expect(p).toMatchObject({ kind: "generated", komi: 7, toPlay: "B", box: 1, seen: 0 });
      expect(p.prompt).toMatch(/^Black to play\./);
      expect(p.answers).toHaveLength(1);
      expect(generatedSource(p)).toMatchObject({ kind: "generated", batchId: "batch1", weakerRank: "20k", strongerRank: "15k", difficultyRank: "20k", difficultyRating: 10 });
      expect(generatedSource(p)!.moveNumber).toBeGreaterThanOrEqual(5);
    }
    // The first game of each size has the weaker side as Black; a second one would be White's.
    expect(problems.filter((p) => generatedSource(p)!.swapped).map((p) => `${p.size}:${generatedSource(p)!.moveNumber}`)).toEqual([]);
    expect(new Set(problems.map((p) => p.hash)).size).toBe(20);
    // Every self-play query is at the lowest priority, cancellable, with the side to move's human-SL profile.
    const selfPlay = h.engine.analyzeCalls.filter((c) => !c.pos.initialStones);
    expect(selfPlay.every((c) => c.opts?.priority === GENERATION_PRIORITY && c.opts.signal)).toBe(true);
    expect(selfPlay[0]!.opts).toMatchObject({ maxVisits: SIZE_SETTINGS[9].screenVisits, includeOwnership: true, includePolicy: true, overrideSettings: { humanSLProfile: "rank_20k" } });
    expect(selfPlay[1]!.opts?.overrideSettings).toEqual({ humanSLProfile: "rank_15k" });

    expect(h.events.at(-1)).toMatchObject({ type: "generation", status: "finished", batch: { id: "batch1", found: 20 } });
    expect(h.chat.at(-1)).toBe("20 new practice problems are ready (7 on 9×9, 7 on 13×13, 6 on 19×19). Press Practice to try them.");
    expect(h.generator.status()).toMatchObject({ state: "idle", current: null, last: { id: "batch1", problems: 20, mastered: 0, needed: 15 }, batches: 1 });
    const saved = JSON.parse(readFileSync(join(h.store.dir, "generation.json"), "utf8")) as GenerationFile;
    expect(saved.progress).toBeNull();
    expect(saved.batches[0]!.stats[9]).toMatchObject({ found: 7, games: 1 });
  });

  it("swaps the colors when the weaker side is White (every other game)", async () => {
    // Nine moves a game: 9×9's first game finds 3 problems (moves 5, 7, 9 are Black's), its second 2 (White's 6 and 8).
    const h = harness(selfPlayEngine({ gameLength: 9 }));
    await runUntilStopped(h, () => (h.generator.batches[0]?.stats[9].games ?? 0) >= 2);
    const nine = generatedProblems(h.store).filter((p) => p.size === 9);
    const swapped = nine.filter((p) => generatedSource(p)!.swapped);
    expect(swapped.length).toBeGreaterThan(0);
    // A swapped problem's stones are the original game's with colors exchanged, and Black is to play.
    for (const p of swapped) {
      const source = generatedSource(p)!;
      expect(source.moveNumber % 2).toBe(0); // White's move in the game
      expect(p.toPlay).toBe("B");
      // White moved first-empty-in-reading-order too, so Black (originally White) has one stone fewer.
      expect(p.stones.B.length).toBe(p.stones.W.length - 1);
    }
  });

  it("takes one problem per answer point from a game: the weaker side missing the same point again is a repeat", async () => {
    // Every 9×9 problem's answer is E5: one per game, the rest repeats.
    const h = harness(selfPlayEngine({ fixedBest: "E5", gameLength: 12 }));
    await runUntilStopped(h, () => (h.generator.batches[0]?.stats[9].games ?? 0) >= 1 && (h.generator.batches[0]?.stats[9].found ?? 0) >= 1);
    const stats = h.generator.batches[0]!.stats[9];
    expect(stats.found).toBe(1);
    expect(stats.rejected.repeat).toBeGreaterThanOrEqual(2);
    expect(generatedProblems(h.store).filter((p) => p.size === 9).map((p) => p.answers)).toEqual([["E5"]]);
  });

  it("keeps out-of-band problems in reserve and takes the closest once more than two wait", async () => {
    // Every answer is hard (no human-SL profile finds it half the time): 9d, far from the 20k–16k band.
    const h = harness(selfPlayEngine({ answerProb: () => 0.1 }));
    await runUntilStopped(h, () => (h.generator.batches[0]?.stats[9].found ?? 0) >= 3);
    const stats = h.generator.batches[0]!.stats[9];
    // The first two wait; from then on each new one releases the closest waiting.
    expect(stats.reserved).toBe(stats.found + 2);
    const saved = h.store.loadGeneration();
    expect(saved.progress?.reserve.filter((p) => p.size === 9)).toHaveLength(2);
    expect(generatedSource(generatedProblems(h.store)[0]!)).toMatchObject({ difficultyRank: "9d", difficultyRating: 38 });
  });

  it("persists its progress after every move, and a restart resumes the game in progress", async () => {
    const store = tempStore();
    const first = harness(selfPlayEngine({ gameLength: 40 }), store);
    await runUntilStopped(first, () => (store.loadGeneration().progress?.game?.moves.length ?? 0) >= 12);
    const saved = store.loadGeneration();
    const moves = saved.progress!.game!.moves;
    expect(moves.length).toBeGreaterThanOrEqual(12);
    const found = saved.batches[0]!.stats[9].found;

    // A new server run: same batch, same game, continuing from its last move.
    const second = harness(selfPlayEngine({ gameLength: 40 }), store);
    await runUntilStopped(second, () => (store.loadGeneration().progress?.game?.moves.length ?? 0) > moves.length);
    expect(second.events).toEqual([]); // no new batch
    const resumed = store.loadGeneration();
    expect(resumed.batches).toHaveLength(1);
    expect(resumed.progress!.game!.moves.slice(0, moves.length)).toEqual(moves);
    expect(resumed.batches[0]!.stats[9].found).toBeGreaterThanOrEqual(found);
    // A last move by the weaker side (Black, odd numbers) is screened in the second run: the
    // position before it is analyzed again first. Otherwise play goes on from the position.
    const firstQuery = second.engine.analyzeCalls[0]!.pos.moves.length;
    expect(firstQuery).toBe(moves.length % 2 === 1 ? moves.length - 1 : moves.length);
  });

  it("waits while it may not use KataGo, and a cancelled step runs again", async () => {
    const h = harness();
    h.mayRun.value = false;
    h.generator.start();
    await flush(20);
    expect(h.engine.analyzeCalls).toHaveLength(0);
    expect(h.generator.status().state).toBe("waiting");
    h.mayRun.value = true;
    h.engine.hold = true;
    h.clock.advance(POLL_MS);
    await flush(20);
    expect(h.engine.analyzeCalls.length).toBeGreaterThan(0);
    const first = h.engine.analyzeCalls.at(-1)!;
    // The learner needs KataGo: the query in flight is cancelled, and the generator waits.
    h.mayRun.value = false;
    h.generator.noteActivity();
    await flush(20);
    expect(first.opts?.signal?.aborted).toBe(true);
    const calls = h.engine.analyzeCalls.length;
    h.clock.advance(5 * POLL_MS);
    await flush(20);
    expect(h.engine.analyzeCalls).toHaveLength(calls);
    expect(h.store.loadGeneration().progress?.game?.moves ?? []).toEqual([]); // nothing kept from the cancelled step
    // Free again: the same position is asked again.
    h.mayRun.value = true;
    h.clock.advance(POLL_MS);
    await flush(20);
    expect(h.engine.analyzeCalls.at(-1)!.pos).toEqual(first.pos);
    h.engine.hold = false;
    h.engine.releaseAll();
    h.generator.stop();
    await h.generator.idle();
  });

  it("starts the next batch at the learner's rank once 15 problems are mastered, and on demand", async () => {
    const h = harness();
    h.generator.start();
    await runUntil(h, () => !!h.generator.batches[0]?.finishedAt, 2000);
    await h.generator.idle();
    expect(() => h.generator.checkTrigger()).not.toThrow();
    expect(h.generator.batches).toHaveLength(1); // nothing mastered yet

    // 15 problems reach box 3: the next batch starts with the learner's rank (rating 13.4 → 17k).
    const problems = h.store.loadProblems();
    problems.slice(0, 15).forEach((p) => (p.box = 3));
    h.store.saveProblems(problems);
    h.generator.problemsChanged(problems);
    expect(h.generator.status().last).toMatchObject({ mastered: 15, needed: 15 });
    h.rating.value = 13.4;
    h.mayRun.value = false;
    h.generator.checkTrigger();
    expect(h.generator.batches[1]).toMatchObject({ id: "batch2", weakerRank: "17k", strongerRank: "12k", trigger: "mastery", band: [13, 17], quotas: { 9: 7, 13: 6, 19: 7 } });
    expect(h.chat.at(-1)).toContain("20 new problems are being made at your level (17k)");
    expect(() => h.generator.startNow()).toThrow(/already being generated: batch2, 0\/20/);
    h.generator.stop();
    await h.generator.idle();
  });

  it("drops progress for a batch that isn't there, and starts a new one", async () => {
    const store = tempStore();
    store.saveGeneration({ version: 1, batches: [], progress: { batchId: "batch7", game: null, reserve: [] } });
    const h = harness(selfPlayEngine(), store);
    h.mayRun.value = true;
    await runUntilStopped(h, () => h.generator.batches.length > 0);
    expect(h.generator.batches[0]).toMatchObject({ id: "batch1", trigger: "first" });
    expect(store.loadGeneration().progress?.batchId).toBe("batch1");
  });

  it("resumes the newest batch when the progress names another one and it never finished", async () => {
    const store = tempStore();
    const first = harness(selfPlayEngine(), store);
    first.mayRun.value = false;
    first.generator.startNow(); // batch1, in progress
    first.generator.stop();
    const file = store.loadGeneration();
    file.progress = { batchId: "batch7", game: null, reserve: [] }; // a damaged file: the progress belongs to no batch
    store.saveGeneration(file);
    const h = harness(selfPlayEngine(), store);
    h.mayRun.value = true;
    await runUntilStopped(h, () => store.loadGeneration().progress?.batchId === "batch1");
    expect(store.loadGeneration().progress?.batchId).toBe("batch1"); // not stuck without a batch, nor a batch2 started over it
    expect(h.generator.batches.map((b) => b.id)).toEqual(["batch1"]);
  });

  it("starts a batch on demand when none is in progress", () => {
    const h = harness();
    h.mayRun.value = false;
    // Not started yet (no trigger runs): --now starts the first batch.
    expect(h.generator.startNow()).toMatchObject({ id: "batch1", trigger: "first", weakerRank: "20k" });
    const file = h.store.loadGeneration();
    file.batches[0]!.finishedAt = 1;
    file.progress = null;
    h.store.saveGeneration(file);
    const again = harness(selfPlayEngine(), h.store);
    again.mayRun.value = false;
    again.rating.value = 12;
    expect(again.generator.startNow()).toMatchObject({ id: "batch2", trigger: "manual", weakerRank: "18k", strongerRank: "13k" });
    again.generator.stop();
    h.generator.stop();
  });
});

describe("removing the old built-in problems", () => {
  it("backs up problems.json, keeps the learner's problems and schedules, and does nothing a second time", () => {
    const store = tempStore();
    const own = liveProblem({ id: "p1", kind: "game", source: { gameId: "g1", moveNumber: 9, played: "C3" }, box: 2, due: 123, seen: 3, solves: 2 });
    const builtin = { ...liveProblem({ id: "b-live-straight-three", hash: "b1" }), kind: "builtin" } as unknown as StoredProblem;
    store.saveProblems([builtin, own, { ...builtin, id: "b-net", hash: "b2" }]);
    const original = readFileSync(join(store.dir, "problems.json"), "utf8");
    const first = removeLegacyBuiltins(store, Date.UTC(2026, 9, 17));
    expect(first.removed).toBe(2);
    expect(first.backupDir).toMatch(/backup-2026-10-17T00-00-00-000Z$/);
    expect(readFileSync(join(first.backupDir!, "problems.json"), "utf8")).toBe(original);
    expect(store.loadProblems()).toEqual([own]);
    expect(removeLegacyBuiltins(store, Date.UTC(2026, 9, 18))).toEqual({ removed: 0, backupDir: null });
    expect(existsSync(join(store.dir, "backup-2026-10-18T00-00-00-000Z"))).toBe(false);
  });
});

describe("generation in the controller", () => {
  function controllerHarness(store = tempStore()) {
    const engine = selfPlayEngine();
    const clock = new FakeClock();
    const ctl = new GameController({ engine, store, clock, botDelayMs: 0 });
    return { engine, clock, ctl, store };
  }

  it("waits for KataGo, steps aside while the learner plays, and resumes when they're idle", async () => {
    const { engine, clock, ctl } = controllerHarness();
    engine.hold = true;
    ctl.startGeneration(); // KataGo is still starting
    await flush(10);
    expect(ctl.view().generation).toMatchObject({ state: "waiting", current: { id: "batch1", found: 0, target: 20 } });
    expect(engine.analyzeCalls).toHaveLength(0);
    ctl.setEngineState("ready");
    await flush(10);
    const generation = () => engine.analyzeCalls.filter((c) => c.opts?.priority === GENERATION_PRIORITY);
    expect(generation()).toHaveLength(1);
    expect(ctl.view().generation?.state).toBe("generating");

    // A chat line needs no KataGo: generation goes on. The learner starting a game cancels its query, and generation waits.
    await ctl.handleAction({ type: "chat", text: "hi" });
    await flush(10);
    expect(generation()[0]!.opts?.signal?.aborted).toBe(false);
    await ctl.handleAction({ type: "new_game" });
    await flush(10);
    expect(generation()[0]!.opts?.signal?.aborted).toBe(true);
    clock.advance(5000);
    await flush(10);
    expect(generation()).toHaveLength(1);
    // Ten seconds after the learner's last action, with nothing of theirs in flight, it resumes.
    engine.releaseAll(); // the game's own analysis
    await flush(10);
    clock.advance(6000);
    await flush(10);
    expect(generation().length).toBeGreaterThan(1);
    await ctl.stopGeneration();
  });

  it("says the first problems are being generated when Practice has nothing yet", async () => {
    const { engine, ctl } = controllerHarness();
    engine.hold = true;
    ctl.startGeneration();
    await expect(ctl.handleAction({ type: "next_problem" })).rejects.toThrow(
      /Your first practice problems are being generated from games KataGo plays against itself: 0\/20 so far \(it starts once KataGo is ready\)/,
    );
    await ctl.stopGeneration();
    const idle = controllerHarness();
    await expect(idle.ctl.handleAction({ type: "next_problem" })).rejects.toThrow(/There are no practice problems yet/);
  });

  it("starts the next batch from the tutor's generate command, and checks the trigger after a problem result", async () => {
    const { engine, ctl, store } = controllerHarness();
    engine.hold = true;
    await expect(ctl.handleTutor({ type: "generate" })).resolves.toBeUndefined();
    expect(ctl.view().generation?.current).toMatchObject({ id: "batch1", trigger: "first" });
    await expect(ctl.handleTutor({ type: "generate" })).rejects.toThrow(/already being generated/);
    // A finished batch whose problems are mastered: a solved problem's result starts the next one.
    const file = store.loadGeneration();
    file.batches[0]!.finishedAt = 1;
    file.progress = null;
    store.saveGeneration(file);
    const problems = Array.from({ length: 20 }, (_, i) => liveProblem({ id: `gen${i + 1}`, hash: `h${i}`, box: i < 14 ? 3 : 2 }));
    store.saveProblems(problems);
    const next = controllerHarness(store);
    next.engine.hold = true;
    next.ctl.startGeneration();
    expect(next.ctl.view().generation?.current).toBeNull(); // 14 of 15 mastered
    next.ctl.setEngineState("ready");
    // gen15 is in box 2: solving it on the first try moves it to box 3, the 15th mastered.
    next.engine.respond = null;
    next.engine.lines.set("", { best: "E1", pv: ["E1", "D8"] });
    await next.ctl.handleTutor({ type: "start_problem", problemId: "gen15" });
    await next.ctl.handleAction({ type: "play", point: at("E1") });
    for (let i = 0; i < 5; i++) {
      next.engine.releaseAll();
      await flush(5);
    }
    expect(store.loadProblems().find((p) => p.id === "gen15")!.box).toBe(3);
    expect(next.ctl.view().generation?.current).toMatchObject({ id: "batch2", trigger: "mastery" });
    await next.ctl.stopGeneration();
    await ctl.stopGeneration();
  });
});
