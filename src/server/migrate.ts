// Rating model 2 migration: re-estimate the learner's rank from the moves of their saved games.
// Games saved before taken-back moves were kept lost their first attempts and the help the learner
// had; the event log (data/events.jsonl) still has them: every move event, the teaching moments
// with their evals, the undos and the hint requests. `reconstructGame` rebuilds a game's full human
// history from it (pure); `migrateRatingModel` runs the rank estimate over each game, rebuilds the
// rating history, adds the taken-back mistakes to the tallies and as practice problems, and writes
// everything after backing up what it changes. It runs once (`Profile.ratingModel`); if KataGo
// fails partway it writes nothing and throws `MigrationAborted`, and the controller tries again.

import { gameFromLine, movesFromLine, writeSgf } from "../engine/index.ts";
import { moveGtp, movePoint, samePoint } from "../shared/coords.ts";
import { ratingToRank } from "../shared/rank.ts";
import { assistText, rankEstimateText } from "../shared/text.ts";
import {
  ASSIST_KINDS,
  type AssistCounts,
  type AssistKind,
  type ChatMessage,
  type GameSummary,
  type MistakeCategory,
  type Move,
  type MoveRecord,
  type Profile,
  type RankEstimate,
  type SavedGame,
  type TakenBackMove,
  type TutorEvent,
} from "../shared/types.ts";
import { estimateRank, positionFor, rankSamples, type PolicyEngine } from "./estimate.ts";
import { BACKGROUND_PRIORITY } from "./katago.ts";
import { addProblems, generateProblems, nextProblemId, type StoredProblem } from "./problems.ts";
import {
  MIN_BOT_RATING,
  applyEstimate,
  botFor,
  classifyPlayed,
  clearEstimating,
  firstAttemptMistakes,
  isRated,
  mistakeKey,
  noAssistance,
  totalPointLoss,
  worstFirst,
} from "./profile.ts";
import type { Store } from "./store.ts";

/** With fewer unassisted moves than this over all games, the rating starts over at 20k. */
export const MIN_MIGRATION_MOVES = 10;
/** Visits for the ownership analyses that categorize a taken-back mistake. */
const CLASSIFY_VISITS = 100;
const RECENT_MISTAKES_CAP = 50;

/** One saved game with what the event log adds to it. */
export interface Reconstruction {
  /** The saved moves, with `assist` set from the log. */
  moves: MoveRecord[];
  takenBack: TakenBackMove[];
  assistance: AssistCounts;
  /** The log's moves replay to exactly the saved game (else only the saved moves and any first attempts found are used). */
  complete: boolean;
  /** Events of the game found in the log. */
  events: number;
}

const sameMove = (a: Move, b: Move) => a.color === b.color && ("pass" in a ? "pass" in b : samePoint(movePoint(a), movePoint(b)));

/**
 * Whether the learner's hint request at `asked` was answered before their next move at `next`
 * (ms): a tutor message in between, or KataGo's own hint (a system message). Returns the kinds of
 * help that adds.
 */
function hintHelp(chat: readonly ChatMessage[], asked: number, next: number): AssistKind[] {
  const between = chat.filter((m) => m.ts > asked && m.ts < next);
  if (between.some((m) => m.from === "system" && m.text.startsWith("Hint from KataGo: look at"))) return ["hint", "shown"];
  if (between.some((m) => m.from === "tutor" || (m.from === "system" && m.text.startsWith("Hint from KataGo")))) return ["hint"];
  return [];
}

/**
 * A saved game's full human-move history from the event log: the first attempts that were taken
 * back (with the eval their teaching moment carried, and the position they were played in), which
 * moves had help (a hint answered, a take-back, a rethink), and the help counts. Pure.
 */
export function reconstructGame(saved: SavedGame, events: readonly TutorEvent[]): Reconstruction {
  const mine = events.filter((e) => "gameId" in e && e.gameId === saved.id);
  const human = saved.settings.humanColor;
  const size = saved.settings.size;
  const stack: MoveRecord[] = [];
  const takenBack: TakenBackMove[] = [];
  const assistance = noAssistance();
  let help: { at: number; kinds: Set<AssistKind> } | null = null;
  let hint: { at: number; ts: number } | null = null;
  let consistent = true;
  for (const e of mine) {
    if (e.type === "game_end") break;
    if (e.type === "move") {
      if (e.record.number !== stack.length + 1) {
        consistent = false;
        break;
      }
      const record: MoveRecord = { number: e.record.number, move: e.record.move, captures: e.record.captures };
      if (e.by === "human") {
        const at = stack.length;
        // Moves logged since help was recorded carry it; a drawing ("shown") is known only that way.
        const kinds = new Set([...(help?.at === at ? help.kinds : []), ...(e.record.assist ?? [])]);
        if (hint?.at === at) for (const k of hintHelp(saved.chat ?? [], hint.ts, e.ts)) kinds.add(k);
        if (kinds.size) record.assist = ASSIST_KINDS.filter((k) => kinds.has(k));
        help = null;
        hint = null;
      }
      stack.push(record);
    } else if (e.type === "teaching_moment") {
      // The moment's record carries the move's eval (the move event went out before it).
      const top = stack[e.record.number - 1];
      if (top && e.record.eval && sameMove(top.move, e.record.move)) top.eval = e.record.eval;
    } else if (e.type === "hint_request") {
      assistance.hints++;
      hint = { at: stack.length, ts: e.ts };
    } else if (e.type === "undo") {
      if (e.moves > stack.length) {
        consistent = false;
        break;
      }
      const removed = stack.splice(e.moves);
      const line = stack.map((r) => moveGtp(r.move, size));
      for (const record of removed) {
        if (record.move.color !== human) continue;
        takenBack.push({ moveNumber: record.number, record, by: e.by, ts: e.ts, before: line });
      }
      if (e.by === "human") assistance.takeBacks++;
      else assistance.rethinks++;
      help = { at: stack.length, kinds: new Set([e.by === "human" ? "retry" : "rethink"]) };
      hint = null;
    }
  }
  const complete = consistent && mine.length > 0 && stack.length === saved.moves.length && stack.every((r, i) => sameMove(r.move, saved.moves[i]!.move));
  const moves = saved.moves.map((r, i) => {
    const assist = complete ? stack[i]!.assist : r.assist;
    const { assist: _old, ...rest } = r;
    return assist?.length ? { ...rest, assist } : rest;
  });
  return { moves, takenBack: consistent ? takenBack : [], assistance: complete ? assistance : { ...assistance, ...saved.assistance }, complete, events: mine.length };
}
/** What `migrateRatingModel` needs. */
export interface MigrationDeps {
  store: Store;
  engine: PolicyEngine;
  now(): number;
  log(msg: string): void;
  /** The mistake threshold for games whose own threshold isn't recorded. */
  threshold: number;
  /** A game in progress, left alone. */
  skip?: string;
}

/**
 * KataGo failed during the migration (a query rejected, the engine stopped, no human policy).
 * Nothing was written: the migration runs again later, from the same data.
 */
export class MigrationAborted extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationAborted";
  }
}

export interface GameReport {
  gameId: string;
  complete: boolean;
  events: number;
  humanMoves: number;
  takenBack: number;
  assisted: number;
  assistance: AssistCounts;
  /** Taken-back first attempts that were mistakes. */
  takenBackMistakes: number;
  rated: boolean;
  estimate: RankEstimate | null;
}

export interface MigrationReport {
  games: GameReport[];
  ratingBefore: number;
  ratingAfter: number;
  problemsAdded: string[];
  backupDir: string | null;
  /** One line for the server log. */
  summary: string;
  /** The chat line for the learner, or null when there was nothing to re-estimate. */
  message: string | null;
}

/** A taken-back mistake's heuristic category, with KataGo's ownership around it. KataGo's failures propagate. */
async function classifyFirstAttempt(saved: SavedGame, t: TakenBackMove, threshold: number, engine: PolicyEngine): Promise<MistakeCategory> {
  const settings = saved.settings;
  let line: Move[];
  try {
    line = movesFromLine(settings, t.before);
    if (!gameFromLine(settings, t.before).play(t.record.move).ok) return "other";
  } catch {
    return "other"; // a line that doesn't replay on this board
  }
  const opts = { includeOwnership: true, maxVisits: CLASSIFY_VISITS };
  const [before, after] = await Promise.all([engine.analyze(positionFor(settings, line), opts), engine.analyze(positionFor(settings, [...line, t.record.move]), opts)]);
  return classifyPlayed(gameFromLine(settings, t.before), t.record, threshold, before, after);
}

/** The summary's mistakes with the taken-back ones added (worst first), and its total loss and help. */
function summaryWithFirstAttempts(saved: SavedGame, summary: GameSummary, rebuilt: Reconstruction, threshold: number): GameSummary {
  const { size, humanColor } = saved.settings;
  const kept = summary.mistakes.filter((m) => m.takenBack === undefined);
  const firsts = firstAttemptMistakes(rebuilt.takenBack, size, threshold);
  return {
    ...summary,
    mistakes: worstFirst([...kept, ...firsts]),
    totalPointLoss: totalPointLoss(rebuilt.moves, humanColor, rebuilt.takenBack),
    assistance: rebuilt.assistance,
  };
}

/**
 * Re-estimates the rating from the saved games (rating model 2) and writes it: each finished game
 * is rebuilt from the event log (first attempts, help), its unassisted moves are rank-estimated,
 * and the rating history is replayed from 20k through `applyEstimate` in game order. Taken-back
 * mistakes join the mistake tallies, the games' summaries and stats, and become practice problems.
 *
 * All KataGo work (at background priority) comes first and writes nothing; if any of it fails, it
 * throws `MigrationAborted` with the data untouched (no backup, games, profile or problems written,
 * `ratingModel` unchanged). Then profile.json, problems.json and the game files it changes are
 * copied to backup-<time>/ and written, synchronously, so the controller's own writes can't
 * interleave. With fewer than MIN_MIGRATION_MOVES unassisted moves in all, the rating starts over
 * at 20k. Idempotent: rebuilding again gives the same games, and mistakes and problems are keyed
 * by move (`mistakeKey`).
 */
export async function migrateRatingModel(deps: MigrationDeps): Promise<MigrationReport> {
  const { store } = deps;
  // Every query the migration makes waits behind the live game's, and the first failure is kept:
  // generateProblems copes with a failed analysis on its own, but the migration must not.
  let failure: Error | null = null;
  const engine: PolicyEngine = {
    concurrency: deps.engine.concurrency,
    analyze: (position, opts) =>
      deps.engine.analyze(position, { ...opts, priority: BACKGROUND_PRIORITY }).catch((err: unknown) => {
        failure ??= err instanceof Error ? err : new Error(String(err));
        throw err;
      }),
  };
  const abortIfFailed = (what: string): void => {
    if (failure) throw new MigrationAborted(`KataGo failed during ${what}: ${failure.message}`, { cause: failure });
  };

  const original = store.loadProfile();
  const games = store
    .gameIds()
    .filter((id) => id !== deps.skip)
    .map((id) => store.loadGame(id))
    .filter((g): g is SavedGame => !!g && !!g.result && g.result.reason !== "abandon" && !!g.summary)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (games.length === 0) {
    store.saveProfile({ ...store.loadProfile(), ratingModel: 2 });
    return { games: [], ratingBefore: original.rating, ratingAfter: original.rating, problemsAdded: [], backupDir: null, summary: "rating model 2: no finished games to re-estimate", message: null };
  }
  const events = store.readEvents();

  // 1. KataGo work, nothing written: rebuild each game, categorize its taken-back mistakes, estimate its rank.
  const reports: GameReport[] = [];
  const rebuiltGames: { saved: SavedGame; rebuilt: Reconstruction; threshold: number; report: GameReport; summary: GameSummary }[] = [];
  for (const saved of games) {
    const rebuilt = reconstructGame(saved, events);
    const threshold = original.recentGames.find((g) => g.gameId === saved.id)?.threshold ?? deps.threshold;
    // Keep what an earlier (interrupted) run or the live game already knew about the first attempts.
    const known = saved.takenBack ?? [];
    rebuilt.takenBack.forEach((t, i) => {
      const old = known[i]?.moveNumber === t.moveNumber ? known[i] : undefined;
      if (old?.tag) t.tag = old.tag;
      if (old?.heuristic) t.heuristic = old.heuristic;
      if (!t.record.eval && old?.record.eval) t.record.eval = old.record.eval;
    });
    for (const t of rebuilt.takenBack) {
      if (t.heuristic || !t.record.eval || t.record.eval.pointLoss < threshold) continue;
      try {
        t.heuristic = await classifyFirstAttempt(saved, t, threshold, engine);
      } catch (err) {
        throw new MigrationAborted(`KataGo failed categorizing move ${t.moveNumber} of ${saved.id}: ${(err as Error).message}`, { cause: err });
      }
    }
    const rated = isRated({ result: saved.result!, moves: rebuilt.moves, settings: saved.settings });
    let estimate: RankEstimate | null = null;
    if (rated) {
      try {
        // Null only when the game has too few unassisted moves: a failure throws.
        estimate = await estimateRank(engine, rankSamples(saved.settings, rebuilt.moves, rebuilt.takenBack), rebuilt.assistance);
      } catch (err) {
        throw new MigrationAborted(`KataGo failed estimating the rank of ${saved.id}: ${(err as Error).message}`, { cause: err });
      }
    }
    const human = rebuilt.moves.filter((r) => r.move.color === saved.settings.humanColor);
    const report: GameReport = {
      gameId: saved.id,
      complete: rebuilt.complete,
      events: rebuilt.events,
      humanMoves: human.length,
      takenBack: rebuilt.takenBack.length,
      assisted: human.filter((r) => r.assist?.length).length,
      assistance: rebuilt.assistance,
      takenBackMistakes: rebuilt.takenBack.filter((t) => t.record.eval && t.record.eval.pointLoss >= threshold).length,
      rated,
      estimate,
    };
    reports.push(report);
    rebuiltGames.push({ saved, rebuilt, threshold, report, summary: summaryWithFirstAttempts(saved, saved.summary!, rebuilt, threshold) });
  }
  abortIfFailed("the rank estimates");

  // Taken-back mistakes become practice problems (one per position: most already are one), on a
  // scratch copy: they are added to the stored problems when everything is written.
  const scratch = store.loadProblems();
  const candidates: StoredProblem[] = [];
  for (const { saved, rebuilt, summary } of rebuiltGames) {
    const firsts = summary.mistakes.filter((m) => m.takenBack !== undefined);
    if (firsts.length === 0) continue;
    const only = { ...summary, mistakes: firsts };
    const added = await generateProblems(
      { gameId: saved.id, settings: saved.settings, moves: rebuilt.moves, summary: only, takenBack: rebuilt.takenBack },
      {
        analyze: (position, opts) => engine.analyze(position, opts),
        concurrency: engine.concurrency ?? 1,
        now: deps.now,
        log: deps.log,
        currentSummary: () => only,
        updateProblems: (change) => change(scratch),
      },
    );
    candidates.push(...added);
    abortIfFailed(`the practice problems from ${saved.id}`);
  }

  // 2. The rating, replayed from 20k through the games in order (pure).
  const replay: Profile = { ...original, rating: MIN_BOT_RATING, ratingHistory: [], ...botFor(MIN_BOT_RATING) };
  delete replay.estimating;
  const changes = new Map<string, ReturnType<typeof applyEstimate>>();
  for (const { saved, report } of rebuiltGames) {
    if (!report.rated) continue;
    const ts = original.ratingHistory.find((e) => e.gameId === saved.id)?.ts ?? saved.updatedAt;
    changes.set(
      saved.id,
      applyEstimate(replay, {
        gameId: saved.id,
        ts,
        settings: saved.settings,
        result: saved.result!,
        humanMoves: report.humanMoves,
        assistedMoves: report.assisted,
        estimate: report.estimate,
      }),
    );
  }
  const unassisted = reports.reduce((n, r) => n + (r.estimate?.moves ?? 0), 0);
  if (unassisted < MIN_MIGRATION_MOVES) {
    // Too little to go on (every estimate ran; the games just have too few moves without help): start over at the weakest bot.
    replay.rating = MIN_BOT_RATING;
    replay.ratingHistory = replay.ratingHistory.map((e) => ({ ...e, rating: MIN_BOT_RATING, delta: 0 }));
    Object.assign(replay, botFor(MIN_BOT_RATING));
    for (const [id, change] of changes) {
      changes.set(id, { ...change, before: MIN_BOT_RATING, after: MIN_BOT_RATING, nextBotRank: replay.botRank, nextHandicap: replay.handicap });
    }
  }

  // 3. Writes, with no await in between: back up, then the games, the profile and the problems.
  const backupDir = store.backup(["profile.json", "problems.json", ...games.map((g) => `games/${g.id}.json`)], deps.now());
  for (const entry of rebuiltGames) {
    const { saved, rebuilt, summary } = entry;
    const change = changes.get(saved.id);
    if (change) summary.rating = change;
    // The file as it is now: the tutor may have tagged a move while KataGo worked.
    const current = store.loadGame(saved.id) ?? saved;
    const updated: SavedGame = { ...current, moves: rebuilt.moves, takenBack: rebuilt.takenBack, assistance: rebuilt.assistance, summary };
    store.saveGame(updated, store.loadSgf(saved.id) ?? writeSgf(saved.settings, saved.moves, saved.result, {}));
  }

  // The profile as it is now (a game may have finished meanwhile): the rebuilt rating, taken-back
  // mistakes in the tallies and the game stats. Only the migrated games stop waiting for an estimate.
  const profile = store.loadProfile();
  profile.rating = replay.rating;
  profile.ratingHistory = replay.ratingHistory;
  profile.botRank = replay.botRank;
  profile.handicap = replay.handicap;
  profile.ratingModel = 2;
  for (const g of games) clearEstimating(profile, g.id);
  const present = new Set(profile.recentMistakes.map(mistakeKey));
  for (const { saved, rebuilt, threshold, summary } of rebuiltGames) {
    for (const m of summary.mistakes) {
      if (m.takenBack === undefined || !m.category || present.has(mistakeKey({ gameId: saved.id, ...m }))) continue;
      const t = rebuilt.takenBack[m.takenBack]!;
      profile.mistakeCounts[m.category] = (profile.mistakeCounts[m.category] ?? 0) + 1;
      profile.recentMistakes.push({ ts: t.ts, gameId: saved.id, moveNumber: m.moveNumber, category: m.category, pointLoss: m.pointLoss, takenBack: m.takenBack });
    }
    const stats = profile.recentGames.find((g) => g.gameId === saved.id);
    if (stats) {
      const evaluated = [...rebuilt.moves.filter((r) => r.move.color === saved.settings.humanColor), ...rebuilt.takenBack.map((t) => t.record)].filter((r) => r.eval);
      if (evaluated.length) {
        stats.humanMoves = evaluated.length;
        stats.avgPointLoss = Math.round((evaluated.reduce((s, r) => s + r.eval!.pointLoss, 0) / evaluated.length) * 100) / 100;
        stats.mistakes = summary.mistakes.filter((m) => m.pointLoss >= threshold).length;
      }
    }
  }
  profile.recentMistakes = profile.recentMistakes.sort((a, b) => b.ts - a.ts).slice(0, RECENT_MISTAKES_CAP);
  store.saveProfile(profile);

  // The problems as they are now (practice may have changed them), with fresh ids.
  const problems = store.loadProblems();
  const problemsAdded: string[] = [];
  for (const p of candidates) {
    const [added] = addProblems(problems, [{ ...p, id: nextProblemId(problems) }]);
    if (added) problemsAdded.push(added.id);
  }
  if (problemsAdded.length) store.saveProblems(problems);

  const rated = reports.filter((r) => r.rated);
  const help = reports.reduce((a, r) => ({ hints: a.hints + r.assistance.hints, takeBacks: a.takeBacks + r.assistance.takeBacks, rethinks: a.rethinks + r.assistance.rethinks }), noAssistance());
  const before = ratingToRank(original.rating);
  const after = ratingToRank(profile.rating);
  const perGame = reports.map((r) => `${r.gameId} ${r.estimate ? rankEstimateText(r.estimate) : r.rated ? "no estimate" : "unrated"}${r.complete ? "" : " (log incomplete)"}`).join("; ");
  const summary = `rating model 2: re-estimated ${rated.length} game(s): ${original.rating} (${before}) -> ${profile.rating} (${after}); ${perGame}; problems added ${problemsAdded.length}; backup ${backupDir}`;
  const message =
    rated.length === 0
      ? null
      : unassisted < MIN_MIGRATION_MOVES
        ? `Your rank is now estimated from the quality of your own moves. Your ${rated.length === 1 ? "game doesn't" : `${rated.length} games don't`} have enough moves played without help yet, so it starts at ${after} again.`
        : `Your rank was re-estimated from your ${rated.length === 1 ? "game" : `${rated.length} games`}: ${after} (was ${before}). It now comes from how your own moves compare with players of each rank: ${unassisted} moves you played on your own. Moves right after help (${assistText(help)}) don't count.`;
  return { games: reports, ratingBefore: original.rating, ratingAfter: profile.rating, problemsAdded, backupDir, summary, message };
}
