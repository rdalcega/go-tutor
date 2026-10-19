// Lessons migration: one lesson per missed point, for the data saved before runs existed. A run of
// a game's mistakes that all missed the same point (src/server/lessons.ts) was counted once per
// mistake, could carry several categories, and made one independent practice problem per mistake.
// `migrateLessonsData` (pure) gives each finished game its `summary.runs`, gives each run one
// category, counts each run once in the profile and links its problems into one lesson;
// `migrateLessons` loads and saves it through the Store at startup (synchronous, no KataGo), after
// backing up what it changes. It runs once (`Profile.lessons`).

import { writeSgf } from "../engine/index.ts";
import type { MistakeCategory, MistakeRef, MistakeRun, Profile, SavedGame } from "../shared/types.ts";
import { byMoveOrder, compareRefs, findRuns, gameRuns, linkLesson, sameRef } from "./lessons.ts";
import { gameSource, problemBoard, recategorize, type StoredProblem } from "./problems.ts";
import { mistakeKey } from "./profile.ts";
import type { Store } from "./store.ts";

type SummaryMistake = NonNullable<SavedGame["summary"]>["mistakes"][number];

/** What the migration did, for its log line and the tests. */
export interface LessonsReport {
  /** Finished games given `summary.runs` (at least one run), and the runs and mistakes in them. */
  games: number;
  runs: number;
  runMistakes: number;
  /** Mistake tallies taken off the profile's `mistakeCounts` (each run now counts once). */
  uncounted: number;
  /** Lessons made in problems.json and the problems linked into them; `fallback`: of those lessons, the ones found from the problems alone (their game is gone). */
  lessons: number;
  linked: number;
  fallback: number;
}

export interface LessonsData {
  profile: Profile;
  /** Every saved game (finished or not); games without a summary are left alone. */
  games: SavedGame[];
  problems: StoredProblem[];
}

/** The tutor's tag on a summary mistake, from the game's tags (or its taken-back first try). */
function tagOf(game: SavedGame, m: MistakeRef): { category: MistakeCategory; note?: string } | undefined {
  if (m.takenBack !== undefined) return game.takenBack?.[m.takenBack]?.tag;
  return game.tags?.[m.moveNumber];
}

/**
 * A run's one category: the tutor's most recent tag among its mistakes, else the lead's category.
 * Games don't keep when a tag was made; the profile's `recentMistakes` does (applyTag puts the
 * tagged mistake there with the tag's time), so tags are ordered by that time, and those it no
 * longer holds by move order (the last tagged one wins, as runLead picks the lead).
 */
export function runCategory(game: SavedGame, run: MistakeRun, members: readonly SummaryMistake[], recent: Profile["recentMistakes"]): MistakeCategory | undefined {
  const tagged = members
    .map((m) => ({ m, category: tagOf(game, m)?.category ?? (m.categorySource === "tutor" ? m.category : undefined) }))
    .filter((t): t is { m: SummaryMistake; category: MistakeCategory } => !!t.category);
  if (tagged.length) {
    const tsOf = (m: SummaryMistake) => recent.find((r) => mistakeKey(r) === mistakeKey({ gameId: game.id, ...m }))?.ts ?? -Infinity;
    // Members are in move order; a later one wins a tie (or when no time is known).
    return tagged.reduce((a, b) => (tsOf(b.m) >= tsOf(a.m) ? b : a)).category;
  }
  return members.find((m) => sameRef(m, run.lead))?.category ?? members.find((m) => m.category)?.category;
}

/** The summary entries of a run's mistakes, in move order (one that can't be found is left out). */
function membersOf(game: SavedGame, run: MistakeRun): SummaryMistake[] {
  return run.mistakes.flatMap((r) => game.summary!.mistakes.filter((m) => sameRef(m, r))).sort(compareRefs);
}

/**
 * Counts each run once in the profile (mutates): every categorized member came off `mistakeCounts`
 * under the category it was counted with (`before`), and the run goes back on once, under
 * `category`. In `recentMistakes` the run's entries become one, the lead's, with the run's category,
 * at the newest member's place; `recentGames` counts the run's mistakes once. Returns the tallies
 * taken off.
 *
 * Every mistake of a finished game's summary was counted once at the end of the game (applyGame:
 * the heuristic ones; applyTag: the tagged ones, under their latest tag; the rating migration: the
 * taken-back ones), so the summary says what to take off even for mistakes older than the
 * `recentMistakes` window. Tallies never go below 0.
 */
function countRunOnce(profile: Profile, game: SavedGame, run: MistakeRun, before: readonly SummaryMistake[], category: MistakeCategory | undefined): number {
  let uncounted = 0;
  for (const m of before) {
    if (!m.category) continue;
    profile.mistakeCounts[m.category] = Math.max(0, (profile.mistakeCounts[m.category] ?? 0) - 1);
    uncounted++;
  }
  if (uncounted && category) {
    profile.mistakeCounts[category] = (profile.mistakeCounts[category] ?? 0) + 1;
    uncounted--;
  }

  const keys = new Set(before.map((m) => mistakeKey({ gameId: game.id, ...m })));
  const at = profile.recentMistakes.findIndex((r) => keys.has(mistakeKey(r)));
  if (at >= 0 && category) {
    const lead = before.find((m) => sameRef(m, run.lead)) ?? before[0]!;
    const note = tagOf(game, lead)?.note;
    const ts = Math.max(...profile.recentMistakes.filter((r) => keys.has(mistakeKey(r))).map((r) => r.ts));
    const entry: Profile["recentMistakes"][number] = {
      ts,
      gameId: game.id,
      moveNumber: lead.moveNumber,
      category,
      pointLoss: lead.pointLoss,
      ...(note && { note }),
      ...(lead.takenBack !== undefined && { takenBack: lead.takenBack }),
    };
    profile.recentMistakes = profile.recentMistakes.flatMap((r, i) => (i === at ? [entry] : keys.has(mistakeKey(r)) ? [] : [r]));
  } else if (at >= 0) {
    profile.recentMistakes = profile.recentMistakes.filter((r) => !keys.has(mistakeKey(r)));
  }

  const recentGame = profile.recentGames.find((g) => g.gameId === game.id);
  if (recentGame) recentGame.mistakes = Math.max(0, recentGame.mistakes - (run.mistakes.length - 1));
  return uncounted;
}

/** The problem made from a game's mistake `m`, if any. */
function problemOf(problems: readonly StoredProblem[], gameId: string, m: MistakeRef): StoredProblem | undefined {
  return problems.find((p) => {
    const s = gameSource(p);
    return s?.gameId === gameId && s.moveNumber === m.moveNumber && s.takenBack === m.takenBack;
  });
}

/**
 * Lessons among the problems of games that are gone (or have no summary): findRuns over the
 * problems themselves, in move order (each problem's position and accepted answers). The lesson
 * takes its worst mistake's category (the problem's `difficulty` is the points that mistake lost).
 * Mutates `problems`; returns the lessons made.
 */
function linkOrphans(problems: readonly StoredProblem[], gameIds: ReadonlySet<string>): StoredProblem[][] {
  const byGame = new Map<string, StoredProblem[]>();
  for (const p of problems) {
    const gameId = gameSource(p)?.gameId;
    if (!gameId || gameIds.has(gameId) || p.lesson) continue;
    byGame.set(gameId, [...(byGame.get(gameId) ?? []), p]);
  }
  const made: StoredProblem[][] = [];
  for (const list of byGame.values()) {
    list.sort(byMoveOrder);
    for (const { answer, members } of findRuns(list.map((p) => ({ board: problemBoard(p), answers: p.answers })))) {
      const variants = members.map((i) => list[i]!);
      const worst = variants.reduce((a, b) => ((b.difficulty ?? 0) > (a.difficulty ?? 0) ? b : a));
      linkLesson(variants, answer, worst.category);
      made.push(variants);
    }
  }
  return made;
}

/**
 * The migration itself (mutates `data`). For each finished game with a summary:
 * 1. its runs: the saved `summary.runs`, else `gameRuns` (and saved there when there are any);
 * 2. each run's one category (runCategory) goes on every member's summary entry and on the tags of
 *    the members the tutor tagged. Untagged members keep categorySource "heuristic": the tutor
 *    didn't discuss them, and runLead picks the lead from the tagged ones;
 * 3. the profile counts each run once (countRunOnce);
 * 4. its problems become one lesson (linkLesson: the most urgent schedule, the run's category);
 *    a member's problem that stays alone (the others made none) still takes the run's category.
 * Problems of games that are gone are grouped from the problems alone (linkOrphans). Problems
 * already in a lesson are left alone. Returns the games it changed and what it did; it sets
 * `profile.lessons`.
 */
export function migrateLessonsData(data: LessonsData): { changedGames: SavedGame[]; problemsChanged: boolean; report: LessonsReport } {
  const { profile, problems } = data;
  const report: LessonsReport = { games: 0, runs: 0, runMistakes: 0, uncounted: 0, lessons: 0, linked: 0, fallback: 0 };
  const changedGames: SavedGame[] = [];
  let problemsChanged = false;
  const summarized = new Set<string>();
  for (const game of data.games) {
    const summary = game.summary;
    if (!summary || !game.result || game.result.reason === "abandon") continue;
    summarized.add(game.id);
    // A game saved with runs ended after lessons existed: it was counted once and its problems linked then.
    if (summary.runs) continue;
    const runs = gameRuns(game, summary.mistakes);
    if (!runs.length) continue;
    summary.runs = runs;
    let changed = true;
    report.games++;
    for (const run of runs) {
      const members = membersOf(game, run);
      if (!members.length) continue;
      report.runs++;
      report.runMistakes += members.length;
      const before = members.map((m) => ({ ...m }));
      const category = runCategory(game, run, members, profile.recentMistakes);
      if (category) {
        for (const m of members) {
          if (m.category !== category) {
            m.category = category;
            changed = true;
          }
          const tag = tagOf(game, m);
          if (tag && tag.category !== category) {
            tag.category = category;
            changed = true;
          }
        }
      }
      report.uncounted += countRunOnce(profile, game, run, before, category);

      // A problem whose answers (from a deeper analysis) no longer include the run's point isn't a variant.
      const variants = run.mistakes.flatMap((r) => problemOf(problems, game.id, r) ?? []).filter((p) => !p.lesson && p.answers.includes(run.answer));
      if (variants.length >= 2) {
        linkLesson(variants, run.answer, category);
        report.lessons++;
        report.linked += variants.length;
        problemsChanged = true;
      } else if (category) {
        for (const p of variants) {
          if (p.category === category) continue;
          recategorize(p, category);
          problemsChanged = true;
        }
      }
    }
    if (changed) changedGames.push(game);
  }
  const orphans = linkOrphans(problems, summarized);
  if (orphans.length) problemsChanged = true;
  report.fallback = orphans.length;
  report.lessons += orphans.length;
  report.linked += orphans.reduce((n, l) => n + l.length, 0);
  profile.lessons = 1;
  return { changedGames, problemsChanged, report };
}

/** What the migration needs of the Store. */
export type LessonsStore = Pick<Store, "loadProfile" | "saveProfile" | "gameIds" | "loadGame" | "loadSgf" | "saveGame" | "loadProblems" | "saveProblems" | "backup">;

/**
 * Runs the lessons migration on the data folder, once (`Profile.lessons`). The profile, problems.json
 * and the games it changes are backed up first (none when only the flag is new: a fresh data folder).
 * It waits for the rating migration (rating model 2: the controller runs it again once that is
 * done). If a write fails partway, everything it wrote is put back as it was, so the next start runs
 * it again from scratch rather than taking the tallies off twice. Returns the report, or null when it
 * had already run or must wait.
 */
export function migrateLessons(store: LessonsStore, now: number): { report: LessonsReport; backupDir: string | null } | null {
  const profile = store.loadProfile();
  // After the rating migration (rating model 2), which rebuilds taken-back mistakes and the recent games' counts.
  if (profile.lessons === 1 || profile.ratingModel !== 2) return null;
  const games = store.gameIds().flatMap((id) => store.loadGame(id) ?? []);
  const problems = store.loadProblems();
  const original = structuredClone({ profile, games, problems });
  const { changedGames, problemsChanged, report } = migrateLessonsData({ profile, games, problems });
  const work = report.runs > 0 || report.lessons > 0 || changedGames.length > 0 || problemsChanged;
  const backupDir = work ? store.backup(["profile.json", "problems.json", ...changedGames.map((g) => `games/${g.id}.json`)], now) : null;
  const saveGame = (game: SavedGame) => store.saveGame(game, store.loadSgf(game.id) ?? writeSgf(game.settings, game.moves, game.result, {}));
  try {
    store.saveProfile(profile);
    for (const game of changedGames) saveGame(game);
    if (problemsChanged) store.saveProblems(problems);
  } catch (err) {
    // A write failed partway: put back what was there, so the next start runs it again from scratch.
    store.saveProfile(original.profile);
    for (const game of original.games.filter((g) => changedGames.some((c) => c.id === g.id))) saveGame(game);
    if (problemsChanged) store.saveProblems(original.problems);
    throw err;
  }
  return { report, backupDir };
}

/** The log line for a migration that did something, or null. */
export function lessonsLogLine(result: ReturnType<typeof migrateLessons>): string | null {
  if (!result?.backupDir) return null;
  const r = result.report;
  return (
    `lessons: ${r.runs} runs of the same missed point (${r.runMistakes} mistakes in ${r.games} games) now count once ` +
    `(${r.uncounted} tallies taken off); ${r.linked} practice problems linked into ${r.lessons} lessons (backup in ${result.backupDir})`
  );
}
