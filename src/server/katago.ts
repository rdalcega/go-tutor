// KataGo analysis engine wrapper (JSON analysis protocol over stdin/stdout).
//
// PERSPECTIVE CONVENTION
//   katago/analysis.cfg sets `reportAnalysisWinratesAs = SIDETOMOVE`, so every `scoreLead` and
//   `winrate` in an `Analysis` (root and per-move) is from the point of view of `Analysis.toPlay`,
//   the player to move in the analyzed position. Per-move values are for the player making that
//   candidate move, which is the same player. KataGo reports ownership in the same perspective;
//   this module flips it so that `Analysis.ownership` is always from BLACK's view (+1 = Black owns,
//   -1 = White owns), row-major with index y * size + x and y = 0 at the top (same as `Board`).
//   `MoveEval` (see src/shared/types.ts) is from the mover's perspective: `moveEvalFrom` negates
//   the "after" analysis, whose side to move is the opponent.
//
// API
//   const kg = new KataGo({ onLog });  await kg.start();
//   kg.analyze(pos, opts)        -> Analysis (normalized as above)
//   kg.botMove(pos, "20k")       -> Gtp, sampled from the human-SL policy at that rank
//   moveEvalFrom(before, after)  -> MoveEval from the analyses of the positions around one move
//   await kg.stop()
//   The `Engine` interface is what the server depends on, so tests can supply a fake.

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { opponent } from "../engine/board.ts";
import type { GoGame } from "../engine/game.ts";
import { moveGtp, toGtp, tryFromGtp } from "../shared/coords.ts";
import { toHumanSLProfile } from "../shared/rank.ts";
import type { AtLevelEval, Color, Gtp, Move, MoveEval } from "../shared/types.ts";

/** A position as KataGo needs it. Moves are replayed from the initial stones. */
export interface Position {
  size: number;
  komi: number;
  moves: [Color, Gtp][];
  initialStones?: [Color, Gtp][];
  /** Player to move when `moves` is empty. Defaults to "W" with initial stones (handicap), else "B". */
  initialPlayer?: Color;
  rules: "chinese";
}

/**
 * The rules sent to KataGo for each `Position.rules`. KataGo's "chinese" preset uses simple ko,
 * but src/engine enforces positional superko, so the rules are spelled out to match it.
 */
export const KATAGO_RULES = {
  chinese: { ko: "POSITIONAL", scoring: "AREA", tax: "NONE", suicide: false, hasButton: false, whiteHandicapBonus: "N" },
} as const satisfies Record<Position["rules"], object>;

export interface AnalyzeOptions {
  maxVisits?: number;
  includeOwnership?: boolean;
  includePolicy?: boolean;
  /** Passed to KataGo's `overrideSettings` (e.g. `{ humanSLProfile: "rank_5k" }`). */
  overrideSettings?: Record<string, string | number | boolean>;
  /** Higher runs first, both in our queue and inside KataGo. Default 0. */
  priority?: number;
  /**
   * Cancels the query: a waiting one leaves the queue, one KataGo is searching is terminated. Either
   * way the promise rejects with an `AbortError`.
   */
  signal?: AbortSignal;
}

/**
 * Priority for work nobody is waiting on (rank estimates, practice problems from a finished game,
 * the rating migration): below the live game's queries (0) and the bot's moves (10).
 */
export const BACKGROUND_PRIORITY = -10;
/** Priority for problem generation's self-play (generate.ts): below everything else. */
export const GENERATION_PRIORITY = -20;
/** A terminated query's slot frees after this long even if KataGo never answers it. */
const TERMINATE_GRACE_MS = 10_000;

/** The error an aborted query rejects with. */
export function abortError(): Error {
  const err = new Error("The KataGo query was cancelled");
  err.name = "AbortError";
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export interface MoveInfo {
  move: Gtp;
  /** From the perspective of `Analysis.toPlay`. */
  scoreLead: number;
  winrate: number;
  visits: number;
  /** 0 = KataGo's preferred move. */
  order: number;
  prior: number;
  pv: Gtp[];
}

export interface Analysis {
  id: string;
  toPlay: Color;
  rootInfo: { scoreLead: number; winrate: number; visits: number };
  /** Sorted by `order`. */
  moveInfos: MoveInfo[];
  /** size*size, Black's perspective (see the convention above). Only with includeOwnership. */
  ownership?: number[];
  /** size*size+1 (last = pass), -1 = illegal. Only with includePolicy. */
  policy?: number[];
  /** Present with includePolicy when a humanSLProfile is set. Same layout as `policy`. */
  humanPolicy?: number[];
}

export interface BotMoveOptions {
  /** Search visits for the bot query; the move comes from the raw human policy, so this stays low. */
  maxVisits?: number;
  random?: () => number;
}

export interface Engine {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Queries KataGo runs at once; more wait in the queue. */
  readonly concurrency: number;
  analyze(pos: Position, opts?: AnalyzeOptions): Promise<Analysis>;
  /** `rank` like "20k", "1d" or "rank_20k". */
  botMove(pos: Position, rank: string, opts?: BotMoveOptions): Promise<Gtp>;
}

export interface KataGoOptions {
  /** Defaults to `katago` found on PATH. */
  binary?: string;
  /** Defaults to <repo>/katago/analysis.cfg. */
  config?: string;
  /** Defaults to $KATAGO_MODEL, else the newest kata1-b18c384nbt-*.bin.gz next to the binary. */
  model?: string;
  /** Defaults to $KATAGO_HUMAN_MODEL, else <repo>/katago/b18c384nbt-humanv0.bin.gz. */
  humanModel?: string;
  /** Max queries in flight inside KataGo; match numAnalysisThreads in the config. Default 2. */
  concurrency?: number;
  /** Receives every stderr line and any protocol warnings. */
  onLog?: (line: string) => void;
  /** Called if the process exits after a successful start (crash or kill). */
  onExit?: (err: Error) => void;
  /** Startup timeout; the first launch can run a long GPU tuning pass. Default 10 min. */
  startTimeoutMs?: number;
  /** RNG for bot move sampling. Default Math.random. */
  random?: () => number;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const READY_MARKER = "ready to begin handling requests";

/** Smallest share of human-policy mass a move needs to be sampled. */
export const MIN_POLICY_MASS = 0.01;
/** The bot also passes when the regular (strongest-play) policy puts at least this much on pass. */
export const PASS_POLICY_THRESHOLD = 0.5;

export function sideToMove(pos: Position): Color {
  const last = pos.moves.at(-1);
  if (last) return opponent(last[0]);
  return pos.initialPlayer ?? (pos.initialStones?.length ? "W" : "B");
}

/** The position after `moves` in a game set up like `game` (its handicap or setup stones), as KataGo needs it. */
export function positionOf(game: Pick<GoGame, "size" | "komi" | "initialStones" | "initialPlayer">, moves: readonly Move[]): Position {
  return {
    size: game.size,
    komi: game.komi,
    rules: "chinese",
    moves: moves.map((m) => [m.color, moveGtp(m, game.size)]),
    initialStones: game.initialStones.map((s) => [s.color, toGtp(s.point, game.size)]),
    initialPlayer: game.initialPlayer,
  };
}

/** Policy index (y * size + x, y = 0 at the top; size*size = pass) to a GTP coordinate. */
export function policyIndexToGtp(index: number, size: number): Gtp {
  if (index === size * size) return "pass";
  return toGtp({ x: index % size, y: Math.floor(index / size) }, size);
}

/** Index of a GTP move in a policy array (y * size + x, y = 0 at the top; size*size = pass). Throws for a point off the board. */
export function policyIndex(move: Gtp, size: number): number {
  const point = tryFromGtp(move, size);
  if (point === undefined) throw new Error(`"${move}" is not a point on a ${size}×${size} board`);
  return point ? point.y * size + point.x : size * size;
}

/** The query that reads the human-SL policy at `rank` (one visit: no search), with any further options. */
export function humanPolicyOptions(rank: string, extra: AnalyzeOptions = {}): AnalyzeOptions {
  return { ...extra, maxVisits: 1, includePolicy: true, overrideSettings: { ...extra.overrideSettings, humanSLProfile: toHumanSLProfile(rank) } };
}

/** The human-SL policy of an analysis (size*size+1 entries, the last for pass; -1 = illegal); throws when the human model wasn't loaded. */
export function humanPolicyOf(analysis: Pick<Analysis, "humanPolicy">, size: number): number[] {
  const human = analysis.humanPolicy;
  if (!human || human.length !== size * size + 1) throw new Error("KataGo response has no humanPolicy; is the human model loaded?");
  return human;
}

/** The human-SL probability of `move` in an analysis made with the human policy (0 for an illegal move). */
export function humanMoveProbability(analysis: Pick<Analysis, "humanPolicy">, move: Gtp, size: number): number {
  return Math.max(0, humanPolicyOf(analysis, size)[policyIndex(move, size)] ?? 0);
}

/**
 * Picks the bot's move from a policy-bearing analysis. Pure, for testing.
 * Passes when pass is the human policy's argmax or the regular policy strongly prefers it;
 * otherwise samples a board move at temperature 1 among entries with at least MIN_POLICY_MASS.
 */
export function chooseBotMove(
  analysis: Pick<Analysis, "humanPolicy" | "policy">,
  size: number,
  random: () => number = Math.random,
): Gtp {
  const human = humanPolicyOf(analysis, size);
  const passIndex = size * size;
  const regularPass = analysis.policy?.[passIndex] ?? 0;
  const top = topHumanMove(analysis, size);
  if (top === "pass" || regularPass >= PASS_POLICY_THRESHOLD) return "pass";

  const candidates: { index: number; p: number }[] = [];
  let total = 0;
  for (let i = 0; i < passIndex; i++) {
    const p = human[i]!;
    if (p >= MIN_POLICY_MASS) {
      candidates.push({ index: i, p });
      total += p;
    }
  }
  // Every board move is under 1%: the most likely one.
  if (candidates.length === 0) return top;
  let r = random() * total;
  for (const c of candidates) {
    r -= c.p;
    if (r < 0) return policyIndexToGtp(c.index, size);
  }
  return policyIndexToGtp(candidates.at(-1)!.index, size);
}

/**
 * A candidate with at least this many visits in the "before" search is judged against KataGo's best
 * within that one search: two separate searches' root values differ by a point or more run to run.
 */
export const TRUSTED_CANDIDATE_VISITS = 50;

/** `move` as a candidate of the `before` search, when KataGo searched it well (TRUSTED_CANDIDATE_VISITS). */
export function trustedCandidate(before: Pick<Analysis, "moveInfos">, move: Gtp): MoveInfo | undefined {
  return before.moveInfos.find((m) => m.move === move && m.visits >= TRUSTED_CANDIDATE_VISITS);
}

/**
 * Combines analyses of the position before and after a move into a MoveEval (mover's perspective).
 * With `played`, a move KataGo searched well in the "before" position loses its candidate's
 * shortfall against the best candidate of that same search (far less noisy than comparing two
 * searches); any other move loses the root lead before minus the root lead after.
 */
export function moveEvalFrom(before: Analysis, after: Analysis, played?: Gtp): MoveEval {
  if (after.toPlay !== opponent(before.toPlay)) {
    throw new Error("moveEvalFrom: 'after' must be the position right after one move from 'before'");
  }
  const leadBefore = before.rootInfo.scoreLead;
  const best = before.moveInfos[0];
  const candidate = played && best ? trustedCandidate(before, played) : undefined;
  let leadAfter = -after.rootInfo.scoreLead;
  let winrateAfter = 1 - after.rootInfo.winrate;
  if (candidate && best) {
    leadAfter = leadBefore - Math.max(0, best.scoreLead - candidate.scoreLead);
    winrateAfter = Math.min(1, Math.max(0, before.rootInfo.winrate - Math.max(0, best.winrate - candidate.winrate)));
  }
  return {
    leadBefore,
    leadAfter,
    pointLoss: Math.max(0, leadBefore - leadAfter),
    winrateBefore: before.rootInfo.winrate,
    winrateAfter,
    bestMove: best?.move ?? "pass",
    bestPv: best?.pv ?? [],
    candidates: before.moveInfos.slice(0, 5).map((m) => ({
      move: m.move,
      lead: m.scoreLead,
      winrate: m.winrate,
      visits: m.visits,
      pv: m.pv,
    })),
  };
}

/** The human policy's most likely move, pass included (entries of -1 are illegal); pass when no move has any probability. */
export function topHumanMove(analysis: Pick<Analysis, "humanPolicy">, size: number): Gtp {
  const human = humanPolicyOf(analysis, size);
  let best = -1;
  for (let i = 0; i < human.length; i++) {
    if (human[i]! > 0 && (best < 0 || human[i]! > human[best]!)) best = i;
  }
  return best < 0 ? "pass" : policyIndexToGtp(best, size);
}

/**
 * Whether judging `played` against the reference move `reference` needs the analysis of the
 * position after the reference move: unless it is the played move, or KataGo searched it well in
 * the "before" position (then that search values it).
 */
export function needsReferenceAnalysis(before: Analysis, played: Gtp, reference: Gtp): boolean {
  return played !== reference && !trustedCandidate(before, reference);
}

/**
 * The played move against the reference move `reference.move` (the human-SL net's top move at
 * `reference.rank`), both valued by the main net, from the mover's perspective. The played move's
 * value is `evaluation.leadAfter`; the reference is valued the same way (`moveEvalFrom`): by its
 * shortfall from the best candidate when searched well in `before`, otherwise by the root lead
 * after it, so `afterReference` (the position after the reference move) is then required
 * (`needsReferenceAnalysis`). The loss is capped at `evaluation.pointLoss`: the reference can't
 * beat KataGo's best.
 */
export function atLevelEvalFrom(
  evaluation: MoveEval,
  before: Analysis,
  after: Analysis,
  played: Gtp,
  reference: { rank: string; move: Gtp },
  afterReference?: Analysis,
): AtLevelEval {
  const { rank, move } = reference;
  const fromSearch = trustedCandidate(before, move);
  const line = (a: Analysis) => [move, ...(a.moveInfos[0]?.pv ?? [])];
  if (move === played) return { rank, move, pv: fromSearch?.pv ?? line(after), loss: 0 };
  const best = before.moveInfos[0];
  let leadAfterReference: number;
  let pv: Gtp[];
  if (fromSearch && best) {
    leadAfterReference = before.rootInfo.scoreLead - Math.max(0, best.scoreLead - fromSearch.scoreLead);
    pv = fromSearch.pv;
  } else {
    if (!afterReference) throw new Error("atLevelEvalFrom: the analysis after the reference move is needed");
    if (afterReference.toPlay !== opponent(before.toPlay)) {
      throw new Error("atLevelEvalFrom: 'afterReference' must be the position right after one move from 'before'");
    }
    leadAfterReference = -afterReference.rootInfo.scoreLead; // the opponent is to move there
    pv = line(afterReference);
  }
  return { rank, move, pv, loss: Math.min(leadAfterReference - evaluation.leadAfter, evaluation.pointLoss) };
}

/** Locates the binary, config and nets. Throws a message a person can act on. */
export function resolveKataGoPaths(opts: Pick<KataGoOptions, "binary" | "config" | "model" | "humanModel"> = {}) {
  const binary = opts.binary ?? findOnPath("katago");
  if (!binary) throw new Error("katago is not on PATH. Install it with `brew install katago`, then run `npm run setup:katago`.");
  const config = opts.config ?? join(REPO_ROOT, "katago", "analysis.cfg");
  if (!existsSync(config)) throw new Error(`KataGo config not found at ${config}. Run \`npm run setup:katago\`.`);
  const model = opts.model ?? process.env.KATAGO_MODEL ?? findMainNet(binary);
  if (!model || !existsSync(model)) {
    throw new Error("KataGo main net not found. Set KATAGO_MODEL or reinstall with `brew install katago`.");
  }
  const humanModel = opts.humanModel ?? process.env.KATAGO_HUMAN_MODEL ?? join(REPO_ROOT, "katago", "b18c384nbt-humanv0.bin.gz");
  if (!existsSync(humanModel)) throw new Error(`KataGo human net not found at ${humanModel}. Run \`npm run setup:katago\`.`);
  return { binary, config, model, humanModel };
}

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Homebrew layout: <prefix>/bin/katago -> ../share/katago/kata1-b18c384nbt-*.bin.gz */
function findMainNet(binary: string): string | undefined {
  const dirs = [join(dirname(realpathSync(binary)), "..", "share", "katago"), "/opt/homebrew/opt/katago/share/katago", "/usr/local/opt/katago/share/katago"];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const nets = readdirSync(dir).filter((f) => /^kata1-b18c384nbt-.*\.bin\.gz$/.test(f)).sort();
    if (nets.length) return join(dir, nets.at(-1)!);
  }
  return undefined;
}

// COREML TEMP FILES
//   With the Metal/CoreML ("mux") backend, every KataGo start converts each net to a CoreML package,
//   `$TMPDIR/katago_coreml/model_<katago pid>_<n>_<id>.mlpackage` (deleted after conversion unless
//   KataGo dies first), and CoreML compiles it to `model_<katago pid>_<n>_<id>.mlmodelc` (about 50 MB
//   each, several per start) in the macOS per-user temp dir (Foundation's temporary directory, which
//   ignores $TMPDIR), which nobody deletes. So `KataGo` deletes a process's files once it exits, and
//   each start sweeps the files of pids that are no longer running (left by a crash or a SIGKILL of the
//   server). Files of a live pid are never touched: another server or test may be using them.

const COREML_FILE = /^model_(\d+)_.*\.(?:mlmodelc|mlpackage)$/;

/**
 * Where KataGo's CoreML backend may write: $TMPDIR (KataGo inherits our env; os.tmpdir() reads it),
 * the macOS per-user temp dir and /tmp, each with its `katago_coreml` subfolder. Resolved and
 * deduplicated; missing folders are left out.
 */
export function coremlTempDirs(): string[] {
  const bases = [tmpdir(), "/tmp"];
  if (process.platform === "darwin") {
    try {
      const userTemp = execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (userTemp) bases.push(userTemp);
    } catch {
      // No getconf: nothing more to add.
    }
  }
  const unique = new Set<string>();
  for (const dir of bases.flatMap((b) => [b, join(b, "katago_coreml")])) {
    try {
      unique.add(realpathSync(dir));
    } catch {
      // A missing dir has nothing to clean.
    }
  }
  return [...unique];
}

/** True when `pid` names a running process (EPERM means it exists but belongs to another user). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Deletes the CoreML files in `dirs` whose pid passes `shouldRemove`. Returns the paths removed. */
function removeCoreMLFiles(dirs: string[], shouldRemove: (pid: number) => boolean): string[] {
  const removed: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = COREML_FILE.exec(name);
      if (!m || !shouldRemove(Number(m[1]))) continue;
      const path = join(dir, name);
      try {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
      } catch {
        // Best effort: whatever is left is swept on a later start.
      }
    }
  }
  return removed;
}

/** Deletes the CoreML files that the KataGo process `pid` wrote (call once it has exited). */
export function removeCoreMLModels(pid: number, dirs: string[] = coremlTempDirs()): string[] {
  return removeCoreMLFiles(dirs, (p) => p === pid);
}

/** Deletes the CoreML files of every pid that is no longer running. */
export function sweepStaleCoreMLModels(dirs: string[] = coremlTempDirs(), isAlive: (pid: number) => boolean = isPidAlive): string[] {
  return removeCoreMLFiles(dirs, (pid) => pid > 0 && !isAlive(pid));
}

interface RawMoveInfo {
  move: string;
  scoreLead: number;
  winrate: number;
  visits: number;
  order: number;
  prior: number;
  pv?: string[];
}

interface RawResponse {
  id?: string;
  error?: string;
  warning?: string;
  field?: string;
  isDuringSearch?: boolean;
  noResults?: boolean;
  rootInfo?: { scoreLead: number; winrate: number; visits: number; currentPlayer: Color };
  moveInfos?: RawMoveInfo[];
  ownership?: number[];
  policy?: number[];
  humanPolicy?: number[];
}

interface Job {
  id: string;
  query: Record<string, unknown>;
  priority: number;
  toPlay: Color;
  resolve: (a: Analysis) => void;
  reject: (e: Error) => void;
  /** Cancelled while KataGo was searching it: its (partial) result is dropped when it arrives. */
  aborted?: boolean;
}

export class KataGo implements Engine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly waiting: Job[] = [];
  private readonly inFlight = new Map<string, Job>();
  private readonly stderrTail: string[] = [];
  private isReady = false;
  private stopping = false;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly opts: KataGoOptions = {}) {}

  start(): Promise<void> {
    this.startPromise ??= Promise.resolve()
      .then(() => this.launch())
      .catch((err: unknown) => {
        this.startPromise = null;
        throw err;
      });
    return this.startPromise;
  }

  private launch(): Promise<void> {
    const paths = resolveKataGoPaths(this.opts);
    const args = ["analysis", "-config", paths.config, "-model", paths.model, "-human-model", paths.humanModel];
    this.stopping = false;
    this.stderrTail.length = 0;
    const tempDirs = coremlTempDirs();
    this.logRemoved(sweepStaleCoreMLModels(tempDirs));
    // Its own process group, so a Ctrl-C or hangup sent to the terminal's group reaches only the
    // server, which then stops KataGo itself (stop() + the cleanup below) instead of seeing it crash
    // and restarting it. KataGo still exits on stdin EOF if the server dies without stopping it.
    const proc = spawn(paths.binary, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.proc = proc;
    // Registered before any other "close" listener (stop() waits on one), so the files are gone by
    // the time stop() resolves. Runs on every exit: stop, crash, kill or startup failure.
    proc.on("close", () => {
      if (proc.pid !== undefined) this.logRemoved(removeCoreMLModels(proc.pid, tempDirs));
    });
    // Writes after a crash raise EPIPE here; the exit handler reports the failure.
    proc.stdin.on("error", (err) => this.opts.onLog?.(`katago stdin: ${err.message}`));

    return new Promise<void>((resolveStart, rejectStart) => {
      let started = false;
      const timer = setTimeout(() => {
        rejectStart(new Error(`KataGo did not become ready within ${this.startTimeoutMs / 1000}s.${this.tailText()}`));
        proc.kill();
      }, this.startTimeoutMs);

      createInterface({ input: proc.stderr }).on("line", (line) => {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
        this.opts.onLog?.(line);
        if (!started && line.includes(READY_MARKER)) {
          started = true;
          this.isReady = true;
          clearTimeout(timer);
          resolveStart();
          this.pump();
        }
      });
      createInterface({ input: proc.stdout }).on("line", (line) => this.onStdout(line));

      proc.on("error", (err) => {
        clearTimeout(timer);
        if (started) return;
        const launchErr = new Error(`Could not launch KataGo (${paths.binary}): ${err.message}`);
        // Settle queued queries here: the "close" that follows ignores a process it no longer owns.
        if (this.proc === proc) {
          this.proc = null;
          this.failAll(launchErr);
        }
        rejectStart(launchErr);
      });
      // "close" rather than "exit", so the last stderr lines are in the tail.
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        if (this.proc !== proc) return;
        const wasReady = this.isReady;
        this.isReady = false;
        this.proc = null;
        this.startPromise = null;
        const err = new Error(
          this.stopping ? "KataGo was stopped" : `KataGo exited (code ${code ?? "none"}, signal ${signal ?? "none"}).${this.tailText()}`,
        );
        this.failAll(err);
        if (!started) rejectStart(err);
        else if (wasReady && !this.stopping) this.opts.onExit?.(err);
      });
    });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    const exited = new Promise<void>((r) => proc.once("close", () => r()));
    proc.stdin.end(); // KataGo finishes and exits on EOF
    const killTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
    proc.kill("SIGTERM");
    await exited;
    clearTimeout(killTimer);
  }

  analyze(pos: Position, opts: AnalyzeOptions = {}): Promise<Analysis> {
    const id = `q${this.nextId++}`;
    const query: Record<string, unknown> = {
      id,
      rules: KATAGO_RULES[pos.rules],
      komi: pos.komi,
      boardXSize: pos.size,
      boardYSize: pos.size,
      moves: pos.moves,
    };
    if (pos.initialStones?.length) query.initialStones = pos.initialStones;
    if (pos.moves.length === 0) query.initialPlayer = sideToMove(pos);
    if (opts.maxVisits !== undefined) query.maxVisits = opts.maxVisits;
    if (opts.includeOwnership) query.includeOwnership = true;
    if (opts.includePolicy) query.includePolicy = true;
    if (opts.overrideSettings) query.overrideSettings = opts.overrideSettings;
    if (opts.priority) query.priority = opts.priority;

    return new Promise<Analysis>((resolveJob, rejectJob) => {
      if (!this.proc) {
        rejectJob(new Error("KataGo is not running; call start() first."));
        return;
      }
      const { signal } = opts;
      if (signal?.aborted) {
        rejectJob(abortError());
        return;
      }
      const onAbort = () => this.abort(job);
      const job: Job = {
        id,
        query,
        priority: opts.priority ?? 0,
        toPlay: sideToMove(pos),
        resolve: (a) => {
          signal?.removeEventListener("abort", onAbort);
          resolveJob(a);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          rejectJob(e);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // Keep the waiting list sorted by priority, FIFO within a priority.
      const at = this.waiting.findIndex((j) => j.priority < job.priority);
      if (at < 0) this.waiting.push(job);
      else this.waiting.splice(at, 0, job);
      this.pump();
    });
  }

  /**
   * Cancel a query: a waiting one leaves the queue at once; one in flight is terminated (KataGo
   * then sends what it has, which `finish` drops), and its slot frees when that arrives.
   */
  private abort(job: Job): void {
    const waiting = this.waiting.indexOf(job);
    if (waiting >= 0) {
      this.waiting.splice(waiting, 1);
      job.reject(abortError());
      return;
    }
    if (!this.inFlight.has(job.id) || job.aborted) return;
    job.aborted = true;
    this.proc?.stdin.write(JSON.stringify({ id: `terminate-${job.id}`, action: "terminate", terminateId: job.id }) + "\n");
    // KataGo answers a terminated query at once; should it never, its slot still frees (a late answer is ignored).
    setTimeout(() => {
      if (this.inFlight.get(job.id) === job) this.finish(job, abortError());
    }, TERMINATE_GRACE_MS).unref();
  }

  async botMove(pos: Position, rank: string, opts: BotMoveOptions = {}): Promise<Gtp> {
    const analysis = await this.analyze(pos, {
      maxVisits: opts.maxVisits ?? 40,
      includePolicy: true,
      overrideSettings: { humanSLProfile: toHumanSLProfile(rank) },
      priority: 10,
    });
    return chooseBotMove(analysis, pos.size, opts.random ?? this.opts.random);
  }

  private get startTimeoutMs(): number {
    return this.opts.startTimeoutMs ?? 10 * 60_000;
  }

  get concurrency(): number {
    return Math.max(1, this.opts.concurrency ?? 2);
  }

  private pump(): void {
    while (this.isReady && this.proc && this.inFlight.size < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.inFlight.set(job.id, job);
      this.proc.stdin.write(JSON.stringify(job.query) + "\n");
    }
  }

  private onStdout(line: string): void {
    if (!line.trim()) return;
    let msg: RawResponse;
    try {
      msg = JSON.parse(line) as RawResponse;
    } catch {
      this.opts.onLog?.(`katago: unparseable output: ${line.slice(0, 200)}`);
      return;
    }
    const job = msg.id !== undefined ? this.inFlight.get(msg.id) : undefined;
    if (msg.warning) this.opts.onLog?.(`katago warning${msg.id ? ` (${msg.id})` : ""}: ${msg.warning}${msg.field ? ` [${msg.field}]` : ""}`);
    if (msg.error) {
      if (job) this.finish(job, new Error(`KataGo rejected the query: ${msg.error}${msg.field ? ` (field ${msg.field})` : ""}`));
      else this.opts.onLog?.(`katago error: ${msg.error}`);
      return;
    }
    // Warnings arrive as their own line before the real response.
    if (!job || msg.isDuringSearch || (msg.warning && !msg.rootInfo)) return;
    if (msg.noResults || !msg.rootInfo) {
      this.finish(job, new Error("KataGo returned no results for the query"));
      return;
    }
    let result: Analysis | Error;
    try {
      result = normalize(msg, job);
    } catch (err) {
      result = err instanceof Error ? err : new Error(String(err));
    }
    this.finish(job, result);
  }

  private finish(job: Job, result: Analysis | Error): void {
    this.inFlight.delete(job.id);
    if (job.aborted) job.reject(abortError());
    else if (result instanceof Error) job.reject(result);
    else job.resolve(result);
    this.pump();
  }

  private failAll(err: Error): void {
    for (const job of [...this.inFlight.values(), ...this.waiting]) job.reject(err);
    this.inFlight.clear();
    this.waiting.length = 0;
  }

  private logRemoved(removed: string[]): void {
    if (removed.length) this.opts.onLog?.(`removed ${removed.length} CoreML temp model(s) left by KataGo`);
  }

  private tailText(): string {
    return this.stderrTail.length ? `\nLast KataGo output:\n${this.stderrTail.slice(-8).join("\n")}` : "";
  }
}

function normalize(msg: RawResponse, job: Job): Analysis {
  const root = msg.rootInfo!;
  if (root.currentPlayer && root.currentPlayer !== job.toPlay) {
    throw new Error(`KataGo thinks ${root.currentPlayer} is to move, expected ${job.toPlay}`);
  }
  const moveInfos = (msg.moveInfos ?? [])
    .map((m) => ({
      move: m.move,
      scoreLead: m.scoreLead,
      winrate: m.winrate,
      visits: m.visits,
      order: m.order,
      prior: m.prior,
      pv: m.pv ?? [],
    }))
    .sort((a, b) => a.order - b.order);
  const analysis: Analysis = {
    id: job.id,
    toPlay: job.toPlay,
    rootInfo: { scoreLead: root.scoreLead, winrate: root.winrate, visits: root.visits },
    moveInfos,
  };
  if (msg.ownership) analysis.ownership = job.toPlay === "B" ? msg.ownership : msg.ownership.map((v) => -v);
  if (msg.policy) analysis.policy = msg.policy;
  if (msg.humanPolicy) analysis.humanPolicy = msg.humanPolicy;
  return analysis;
}
