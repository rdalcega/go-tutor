# Go Tutor architecture

A single-user, local app. The learner plays Go in a browser tab against KataGo. KataGo
analyzes every move. A Claude Code session, attached through the `tutor` CLI, acts as the
teacher: it hears about teaching moments and answers in a chat panel and on the board.
Without a Claude session the app still works, with KataGo-only feedback.

```
 Browser (web/)  ──HTTP + SSE──▶  Server (src/server)  ──stdin/stdout JSON──▶  katago analysis
                                     │   ▲
                         data/*.json │   │ HTTP (POST /api/tutor, SSE /api/tutor/events)
                                     ▼   │
                              tutor CLI (src/cli) ◀── run by the Claude Code session
```

The contract for every boundary is `src/shared/types.ts`.

## Layout

| Path | Owns |
|---|---|
| `src/shared/types.ts` | All cross-boundary types. |
| `src/shared/coords.ts` | `toGtp(point, size)`, `fromGtp(gtp, size)` (columns `A`–`T` skipping `I`; row 1 at the bottom), `movePoint(move)`, `moveGtp(move, size)`, `samePoint`. |
| `src/shared/allowed.ts` | `allowedActions(state)`: the browser actions the server accepts in a given state (mode, status, result, moment, turn, engine, tutor, problem and its play-out, drawing on the board), used by the controller and the UI mock; `retryBlocked` (Try again) and `takeBackBlocked` (Take back) say why a take-back can't happen. |
| `src/shared/text.ts` | Wording shared by server, CLI and UI: `colorName`, `categoryLabel`, `round1`, `formatScore`, `TUTOR_LEVEL_TEXT` (each level's label, the learner's description and the tutor's), `tutorLevelChangedText` (the chat line for a level change), `JUDGE_MODE_TEXT` and `judgeModeChangedText` (the same for judge modes), `comeBackText` (when a problem is due again), `assistText` ("3 hints, 2 take-backs"), `estimateRankText` and `rankEstimateText` ("Rank estimate 18k from 34 unassisted moves (3 hints, 2 take-backs)"). |
| `src/shared/schedule.ts` | Leitner scheduling for practice problems (`BOX_INTERVALS`, `MAX_BOX`, `resultOf`, `nextBox`, `schedule`), used by the server's problems and the UI mock. |
| `src/shared/threshold.ts` | The mistake threshold by board size: `THRESHOLD_MULTIPLIERS` (9×9 ×1, 13×13 ×1.5, 19×19 ×2), `thresholdMultiplier(size)`, `thresholdFor(base, size)` (the profile's 9×9 threshold on a board), `sizeText`. Used by the controller, the profile's adaptation, the CLI and the UI so they agree. |
| `src/shared/rank.ts` | `rankToRating("20k") → 10`, `ratingToRank(10) → "20k"` on the scale 30k=0 … 1k=29, 1d=30 … 9d=38; `atLevelRankFor(rating)` (one rank above the displayed rank, 20k … 9d). |
| `src/shared/judge.ts` | `judgedLoss(record)`: the loss a move is judged by (against the reference move when played on `at_level`, else `pointLoss`), and `atLevelOf(record)`. Used by the controller, the CLI and the UI. |
| `src/engine/` | Pure Go rules: `GoGame` class (play/pass/undo, captures, suicide illegal, positional superko; `before(n)` copies the game before move n from its history, `fromBoard` sets up a position), `gameBefore(settings, moves, n)` (replays a saved move list), `movesFromLine`/`gameFromLine` (a GTP move line, colors alternating from the first mover, e.g. a taken-back move's position), `boardFromDiagram`, area scoring with komi, dead-stone input from KataGo ownership, `toAscii(board)`, SGF read/write. No I/O. |
| `src/server/katago.ts` | Long-lived `katago analysis` child process speaking the JSON analysis protocol; query queue with ids and priorities (`BACKGROUND_PRIORITY` −10, `GENERATION_PRIORITY` −20); `analyze(position, opts)` (an `AbortSignal` in `opts.signal` cancels a query: a waiting one leaves the queue, one KataGo is searching gets KataGo's `terminate` action; either rejects with an `AbortError`), `botMove(position, rank)`, `ownership`. |
| `src/server/game.ts` | `GameController`: owns the current game, turns, bot replies, per-move evals, teaching-moment detection, pause + fallback timer, chat log, the profile and problem writes, producing `GameView` (with the actions it accepts) and `TutorEvent`s. Takes an engine interface so tests can use a fake. |
| `src/server/practice.ts` | `PracticeSession`: the practice problem on the board (attempts, judging against KataGo, its overlay and view) while the game waits underneath, and its play-out once answered (`playoutMove` picks KataGo's move); the controller delegates to it in problem mode and writes the problem's progress. |
| `src/server/common.ts` | What the controller and the session share: `UserError`, the clock, and turning GTP into ghost stones and marks. |
| `src/server/bridge.ts` | Tutor bridge: event sequence numbers, `data/events.jsonl` append log, SSE fan-out to `tutor watch` connections, `tutorAttached` tracking, applying `TutorCommand`s to the controller. |
| `src/server/store.ts` | Persistence under `data/` (path overridable with `GO_TUTOR_DATA`): `games/<id>.sgf` + `games/<id>.json` (settings, moves with evals, result, summary), `games/index.json` (creation time and finished flag per game, so finding the last game reads one file; read and checked against the files once at startup, then kept in memory), `profile.json`, `problems.json`, `generation.json` (generated batches and the one in progress), and `backup(paths)` (copies data files into a new `backup-<time>/` folder before the migration rewrites them). The controller writes a game at the end of the tick that changed it (one action's burst of changes is one write), and at once for a new game, at game end and on shutdown (SIGINT, SIGTERM, SIGHUP, beforeExit). |
| `src/server/profile.ts` | Learner memory, pure functions over `Profile`: a finished game's tallies and stats (`applyGame`), the rating from its rank estimate (`applyEstimate`, `combinedEstimate`), heuristic mistake categories (`classifyMistake`, `classifyPlayed` for a move on its replayed position), the summary pieces the controller and the migration share (`mistakeEntry`, `firstAttemptMistakes`, `totalPointLoss`, `noAssistance`), `mistakeKey` (which mistake: game, move, first-attempt index), tutor tags (`applyTag`), the adaptive mistake threshold, and `recommendFocus`. See "Learner profile". |
| `src/server/estimate.ts` | The rank estimate from move quality: which human moves count (`rankSamples`), their human-SL probabilities at 13 rank profiles (`movePolicies`), the maximum-likelihood rank (`fitRank`, `peakRating`), `estimateRank`. See "Rank estimate". |
| `src/server/migrate.ts` | The one-time re-estimate for data from before rating model 2: `reconstructGame` (first attempts and help from `events.jsonl`, pure) and `migrateRatingModel`. See "Rating model migration". |
| `src/server/problems.ts` | Practice problems, pure functions over `StoredProblem`: problems from a finished game's mistakes, their sources (`gameSource`, `generatedSource`), position hashes, Leitner scheduling (`src/shared/schedule.ts`), the listing order and the `GET /api/problems` body. See "Practice problems". |
| `src/server/lessons.ts` | Runs and lessons, pure: the runs of a game's mistakes that missed the same point (`findRuns`, `gameRuns`, `runLead`), the lessons their problems form (`linkGameLessons`, `linkLesson`, `syncLesson`, `lessonInfo`), a result counted for the whole lesson with the two-misses rule (`recordLessonResult`, `sessionStart`), and which problem comes next (`pickNextProblem`, `pickVariant`). See "Lessons". |
| `src/server/migrate-lessons.ts` | The one-time startup migration that finds the runs in saved games, counts each once in the profile and links their problems into lessons (`Profile.lessons`). |
| `src/server/generate.ts` | Generated problems from KataGo's human-SL self-play: batch quotas and ranks, the candidate filters (`examineCandidate`), difficulty, the batch trigger, the startup removal of the old built-in problems (`removeLegacyBuiltins`), and `ProblemGenerator`, which the controller runs in the background. See "Generated problems". |
| `src/server/index.ts` | `node:http` server on port 4747 (`PORT` env): JSON API, SSE, serves `dist/` in production. |
| `src/cli/tutor.ts` | The tutor's command line. See "Tutor CLI". |
| `web/` | Vite + plain TypeScript UI: canvas board, controls, chat panel, eval strip. No framework. |
| `scripts/setup-katago.sh` | Verifies/installs KataGo, downloads the human-SL net into `katago/`, writes `katago/analysis.cfg`. |
| `test/` | Vitest tests. Unit tests never need KataGo; integration tests skip when `katago` is not on PATH. |

## KataGo

- Binary: `katago` on PATH (Homebrew). Main net: `$(brew --prefix katago)/share/katago/kata1-b18c384nbt-*.bin.gz`
  (override `KATAGO_MODEL`). Human net: `katago/b18c384nbt-humanv0.bin.gz` (override `KATAGO_HUMAN_MODEL`).
- Launch: `katago analysis -config katago/analysis.cfg -model <main> -human-model <human>`.
  The config is derived from the bundled `analysis_example.cfg` with modest settings for an M1
  (`numAnalysisThreads = 2`, `numSearchThreadsPerAnalysisThread = 8`, `maxVisits = 400`).
- Analysis: one query per position, always with `includeOwnership` (it adds only network output, not search); read
  `rootInfo.scoreLead`/`winrate` (from the perspective of `rootInfo.currentPlayer` — check
  `reportAnalysisWinratesAs` in the config and normalize) and `moveInfos` (`move`, `scoreLead`,
  `winrate`, `visits`, `pv`, `order`).
- Bot moves: query with `overrideSettings: { humanSLProfile: "rank_<N>k" | "rank_<N>d" }` and
  `includePolicy: true`, low `maxVisits` (e.g. 40); the response has `humanPolicy`; sample a legal
  move from it (temperature ~1, ignore moves below 1% mass). Pass only when the human policy's pass
  mass dominates or the board is settled.
- Startup takes several seconds (and a one-off tuning run the first time); the server must start
  serving immediately and report `engineBusy` until KataGo answers.

## Game flow

1. `new_game` → controller creates a game (defaults: 9×9, komi 7, human plays black, bot rank from profile,
   no handicap; while the learner rates below 20k, 9×9 as Black gets the profile's handicap stones). Emits `game_start`.
2. Human `play` → legality check in the rules engine → record → emit `move` → ask KataGo to analyze the
   position before and after (positions are cached, so "before" is usually ready).
3. Eval arrives → attach `MoveEval` to the record. If `judgedLoss(record) >= thresholdFor(profile.mistakeThreshold, size)`
   (default 4 on 9×9, 6 on 13×13, 8 on 19×19; `judgedLoss` is `pointLoss` unless the move was judged
   at level, see "Judge modes") it is a **teaching moment**: status `paused`, moment state `waiting`, emit `teaching_moment`.
   - If a tutor is attached: wait up to 30 s (`TUTOR_TIMEOUT_MS`) for any tutor command about the moment
     (`claim`, `say`, `rethink`, `show`, `mark`). Any of them sets state `tutor` and cancels the timer.
   - If no tutor is attached or the timer fires: state `fallback`, overlay draws KataGo's PV as a variation
     with `fromMove` set (the UI shows the board from before the mistake, numbered PV, the played point
     marked ✕, KataGo's move highlighted from the overlay's `best`), a system chat message states the point loss in plain words. Emit `fallback`.
   - The pause ends when the human presses Continue (`continue`) or Try again (`retry`), or plays again
     after a `rethink` (which undoes their move). The tutor's `resume` ends it only when nothing is drawn
     on the board; with a drawing up (the tutor's `show`/`mark`, or KataGo's fallback line) the moment
     gets `awaitingLearner: true` (state `tutor`, the timer cancelled), the drawing stays, and the UI
     says the tutor is done and the learner can press Continue when ready.
   - For a move played on the **Silent** tutor level (see "Tutor levels") none of this happens: the
     move is evaluated and recorded, and the bot replies.
4. When not paused, the bot replies (with a small delay so it feels natural). Emit `move` (by bot).
5. Game ends on two consecutive passes (score with KataGo ownership to remove dead stones) or resign
   (a resignation takes effect at once; the verdict on a move still being evaluated lands first,
   opening no moment, and the game finishes with it, or without it if a new game starts meanwhile).
   Build the `GameSummary` (mistakes categorized, taken-back first attempts included, the runs of
   mistakes that missed the same point (see "Lessons"), the help the learner had), update the profile's tallies and stats, save the game, emit `game_end` (a rated
   game's `summary.rating` is `pending`, and the game id joins the profile's `estimating` list).
   Then, in the background, each mistake becomes a practice problem (see "Practice problems"), and
   the rank estimates of the games in `estimating` run in order (see "Rank estimate"): each rating
   change goes into the profile, the game's `summary.rating` and a `rating` event, and bumps
   `profileVersion`. A game waits in `estimating` (on disk, so a restart resumes it) while KataGo
   isn't ready or fails its estimate, and while the rating migration hasn't run (it covers the
   game); the next engine-ready or game end runs it. Only a game with too few unassisted moves for
   an estimate is rated from its result alone.

**Take-backs.** Try again (the moment banner, `retry`) and Take back (the controls, `take_back`)
take back the learner's last move and the bot's reply if it came; the tutor's `rethink` does the
same for a moment's move. Try again needs a move of the learner's and stops once the open moment's
move is already taken back (so a slow double press can't undo more); Take back works at any tutor
level, on the learner's turn or in a pause (not while their move is evaluated or the bot thinks, and
not after two passes), and also past a moment the tutor took back. Every take-back emits `undo`
(`by: "human"` for both learner buttons, `"tutor"` for rethink). The taken-back human move is not
lost: it goes into `SavedGame.takenBack` (`TakenBackMove`: move number, the record with its eval and
level, who took it back, when, the moves before it as GTP so its position survives later
take-backs, its heuristic category and tag), and a tag the profile already counted moves with it.

**Help** (`MoveRecord.assist`, human moves): `"hint"` when the move was played after a hint for that
position was answered (KataGo's, or a tutor `say`/`show`/`mark` after a hint request on the
learner's turn), `"retry"`/`"rethink"` when it replaces a taken-back move, `"shown"` when the tutor
drew on that position on the learner's turn (or KataGo's hint circled a point), even if the learner
hid the drawing. Help is kept per position (move count) and cleared by the next move or take-back; it
is saved with the game (`SavedGame.help`, with `hintAsked` for a hint the tutor hasn't answered), so
a restart before the move still counts it as assisted.

**Restart.** `restoreLastGame` picks up the newest unfinished game with its chat, tags, first
attempts, help, open question and the drawing on the board. A moment the learner dismissed stays
dismissed. An open one comes back as it was saved, with its id (its `teaching_moment` is already in
the event log, where a fresh `watch` finds it): the tutor's stays the tutor's, as after a dropped
connection, and KataGo's fallback stays answered, both waiting for the learner's Continue; one still
waiting for a tutor falls back at once (nobody is attached at boot; a tutor who reconnects sees it
as fallen back and can still comment), as does KataGo's answer from a game saved before drawings
were (it is given again); one whose move the tutor took back (`rethink`) stays open, with
the tutor, for the learner's new move. A mistake whose eval arrived but never opened a moment opens
one now. A game resigned while its last move was being evaluated, and stopped before the verdict
landed (a result on file but no summary), finishes now, without it.
`SavedGame.assistance` / `GameSummary.assistance` count hint requests, the learner's take-backs and
the tutor's rethinks. Assisted moves don't count for the rank estimate.

A move's point loss is KataGo's root lead before it minus the root lead after it, except for a move
KataGo searched well (50+ visits) in the position before: that one loses its candidate's lead below
the best candidate of the same search, since two separate searches disagree by a point or more run
to run (so KataGo's own best move never shows a loss).

One cached query per position, with ownership, serves move evals, mistake categories, the bot's
pass check, hints and scoring (the cache keeps the 16 most recently used positions). When a human
move's eval reaches the mistake threshold the controller classifies it right away with the ownership
before and after it, and keeps the category in the saved game's `heuristics` (the ownership itself
isn't saved). A mistake without one (evaluated before a restart) is classified at game end without
ownership.

Bot moves are never evaluated as teaching moments. Only the human's moves are.

**Drawings** (`overlay`: the tutor's `show`/`mark`, KataGo's fallback line, a hint mark, a problem's
verdict) stay on the board until the learner's next move or action that changes the position (a
move or problem attempt, Continue, Try again, a new game), until the tutor's `clear`, or until the learner hides
them: the `clear_overlay` action (the Hide button next to the board caption, or Esc), offered in
`allowed` whenever a drawing is up. Hiding a drawing during a pause keeps the pause. The game's
drawing is saved with it (`SavedGame.overlay`), so a restart shows the board as it was.

**Tutor levels** (`Profile.tutorLevel`, in `GameView.tutorLevel`; default `coach`): the learner's
`set_tutor_level` action changes it at any time (the profile is saved, `tutor_level` is emitted with a
system chat line), and it applies from their next move: each human `MoveRecord` keeps the
`tutorLevel` it was played at (saved with the game, so a restart opens or skips a due moment by that
level, not the current one), and a moment keeps its move's level as `TeachingMoment.level`.
`game_start` carries the current level, `teaching_moment` the moment's.
- `coach`: everything above.
- `point_out`: as coach, but the tutor's `rethink` on a Point out moment is refused ("The learner chose Point out: explain,
  don't take moves back"). The learner's own Try again works.
- `silent`: a human move played on Silent never opens a teaching moment (no pause, no
  `teaching_moment`, no KataGo fallback line or system mistake message, with or without a tutor). Its
  eval, heuristic category, summary entry, profile tallies and practice problem are the same as on the
  other levels. While a game is in progress (no result, no open moment) the tutor's `show`, `mark`
  and `rethink` are refused, and `say` is accepted only once per learner question: after a
  `user_message` or `hint_request` that reached an attached tutor and has no tutor `say`, `show` or
  `mark` after it yet (a hint KataGo answered doesn't count; a new game, the game's end, and entering
  or leaving a problem drop an unanswered question; a restart keeps it, `SavedGame.questionOpen`).
  Hints work as usual. Practice
  problems, a moment opened before the switch, and the post-game review are not restricted.

**Judge modes** (`Profile.judgeMode`, in `GameView.judgeMode`; default `optimal`): how a human move is
scored for the learner (the last-move card, its sparkline, the moment banner, KataGo's fallback) and
whether it opens a teaching moment. The `set_judge_mode` action changes it like the tutor level
(profile saved, `judge_mode` emitted, a system chat line), and each human `MoveRecord` keeps the
`judge` it was played in.
- `optimal`: the score is `pointLoss`, against KataGo's best move.
- `at_level`: the score is against the **reference move**, the human-SL net's most likely move at the
  game's reference rank: one rank above the learner's displayed rank when the game started
  (`atLevelRankFor`, 20k … 9d; `SavedGame.atLevelRank`, `GameView.atLevelRank`, on `game_start`).
  Evaluating such a move also asks KataGo for that policy (one query, `maxVisits` 1,
  `humanSLProfile` set, so no search and the cached analyses stay as they are; the latest one is
  kept, so the tutor's `state` on the learner's turn and the judging of their move share it). Both moves are then
  valued by the main net: within the "before" search when both have `TRUSTED_CANDIDATE_VISITS`,
  otherwise from the root leads after each move (one more analysis, of the position after the
  reference move, run alongside the move's own and kept out of the analysis cache). `MoveEval.atLevel` holds the rank, the move, its line, and `loss` (negative when
  the learner's move is better: the card shows a gain; capped at `pointLoss`). `judgedLoss` clamps it
  at 0. A fallback for such a moment draws the reference move's line ("A 17k's line instead of …").
  If the reference can't be had, the move is judged against KataGo's best and a chat line says so.
Everything else uses `pointLoss` in both modes: the summary's mistakes, heuristic categories, the
review, tags, profile tallies, threshold adaptation and practice problems (their answers too).
Since the reference is never better than KataGo's best, a move that opens an at-level moment is
always a mistake in the summary as well.

`ask_tutor` (the Hint button next to the chat input, with any typed text as `text`, or the H key)
emits `hint_request` (with the current ASCII board) and adds the text to the chat. With no tutor
attached the server answers with KataGo's top move marked as a hint.

`chat` from the user emits `user_message`. On a practice problem it carries `problemId` (and no moment
id), since the message is about the problem on the board, not the game waiting underneath, and
`playout: true` while the learner plays the problem out (the tutor may answer it with one `say`).
With no tutor attached, the server adds a system reply saying the tutor isn't connected.

## Tutor bridge

- `GET /api/tutor/events?since=<seq>&epoch=<id>` is an SSE stream of `TutorEvent`s. While at least one such
  connection is open, `tutorAttached` is true. Events are also appended to `data/events.jsonl` (rotated
  to `events.1.jsonl` past 8 MB; a replay older than the in-memory ring reads the log from its end
  back to `since`). The first frame is `event: hello` with `{ epoch, since }`: `epoch`
  identifies the server boot; a cursor from another epoch is clamped to this boot's first seq (seqs
  that never reached the log can be reused after a restart), and `since` is where the replay starts.
  Replayed teaching moments carry the moment's current state (the game's, also while a practice
  problem is on the board). A stream without `since` gets the open teaching moment and the problem on
  the board, if any (their events from memory, or from the log for a moment restored after a restart),
  and, when it opens within 10 minutes of the last tutor stream closing (the Monitor tool restarts
  `watch` every 30 minutes), every event that stream wasn't sent. A `game_end` whose rank estimate is
  still running is logged at once but sent to the tutor streams with its `rating` event, in one write
  (or alone after 15 s, or before any other event); a stream opened meanwhile gets a cursor before it.
  The tutor's `watch` marks its stream `rejoin=1`: only such streams use or leave the backlog above.
  On such a stream, events that need no answer of their own (`game_start`, `problem_start`, a
  finished batch, `fallback`) are held and written with the next event that does, so they don't
  wake the tutor alone (a problem start over an open moment is sent at once); held frames don't
  count as sent, so a fresh `watch` gets them, and while a GAME_END is held they wait with it. While
  one is attached the controller knows (`setTutorWatching`): a teaching moment then opens with the
  longer wait, `TUTOR_GRACE_MS` (75 s) instead of `TUTOR_TIMEOUT_MS` (30 s), and a moment already
  waiting when it attaches gets it the first time, at least 30 s after that (`extendMoment`). The
  tutor answers a moment in one chained call that starts with `claim <id>`.
- `/api/*` rejects requests with a foreign `Origin` (anything but this server and the Vite dev server
  on port 5173) with 403, and POSTs without `content-type: application/json` with 415. The server
  listens on 127.0.0.1 only.
- `POST /api/tutor` takes a `TutorCommand` JSON body and returns `{ ok: true, view: GameView }` or
  `{ ok: false, error }` with a message a person can act on.
- `GET /api/state` returns the `GameView`. Besides the position, it lists `allowed`: the browser
  actions `POST /api/action` accepts right now (the same checks it makes; the rules are the pure
  `allowedActions` in `src/shared/allowed.ts`, shared with the UI's `?mock` server), which the UI uses for its
  buttons, board input and keys; and `profileVersion`, bumped by every profile change (a game or
  problem ends, a rank estimate arrives, a tag), so the UI knows when to fetch the profile again. Move, teaching-moment and
  hint events carry the board `size`, so `tutor watch` names points in GTP without a lookup. For an
  older logged event without `size`, `watch` uses the size from that game's `game_start` if it saw
  one, else prints the move as `(coords unavailable)`; it never fails on an event it can't read.
  `GET /api/state?tutor=1` (what the tutor CLI fetches, `state` and the state under `watch`'s
  events) adds `toPlayAnalysis` on the learner's turn in a game: KataGo's lead, best move, PV and
  top 5 candidates for the position to play, from the cached analysis that `prefetch` started after
  the bot's move, and on at_level the reference move (asked for then, and kept for judging the
  learner's move), so the tutor's hint can aim at the right area. It waits up to 2 s for it (under `watch`'s 3 s), then gives `{ pending: true }`. The
  learner's view (plain `GET /api/state`, the SSE frames) never carries it.
  `GET /api/game/:id` (or `last`) returns a saved game
  (`games/<id>.json`: settings, moves with evals and PVs, result, summary with categories and rating
  change, chat, tags, heuristics). `GET /api/profile` returns `ProfileResponse`: `{ profile, focus }`.
  `GET /api/problems` returns `ProblemsResponse` (both use the controller's profile in memory): every problem (`ProblemListItem`: category, board
  size, source or generated origin, box, due, results, accepted answers) in the order `next_problem`
  picks them, counts (total, due, from games, generated, per box, due per category), the focus and
  the generation status. `GET /api/generation` returns `GenerationStatus` (also in every
  `GameView.generation`): the batch in progress (per size found/target, games and KataGo minutes),
  the newest finished batch with its mastery count, and whether KataGo is working on it now.

## Learner profile

`data/profile.json`, updated by `src/server/profile.ts` when a game finishes (not when abandoned),
when its rank estimate is in, and when the tutor tags a mistake.

- **Rating** (rank scale, 20k = 10; `ratingModel: 2`). Mostly the quality of the learner's moves:
  each rated game (played to a result, 10+ human moves; resignations count) gets a rank estimate
  (see "Rank estimate"), and `combinedEstimate` averages the games' estimates weighted by
  `0.8^age × unassisted moves` (age 0 = the newest estimated game). The result adds a light Elo
  nudge: rating = `(1 − w) × combined + w × (before + Elo change)`, with `w = 0.2 × (1 − share of the
  learner's moves with help)`. The Elo change: expected score `1 / (1 + 10^((bot - rating) / 3))` (one rank ≈ 68%),
  where `bot` is the bot's rank minus handicap stones given to the learner (1.5 ranks per stone on 9×9,
  1.25 on 13×13, 1 on 19×19; rough); change = `2 × step × (score − expected)`, with step 1.5 for the
  first five rated games, then 1.25, 1, 0.75 and 0.5 from then on. Before any game has an estimate
  the Elo change alone moves the rating. A floor estimate ("20k or weaker") is an upper bound, not
  a value: in `combinedEstimate` it counts as `min(10, the Elo rating)`, so below 20k the results
  decide and the handicap stones still apply. `applyGame` (at game end) adds the game to the
  profile's `estimating` list; `applyEstimate` (when the estimate is in) takes it off, appends to
  `ratingHistory` (rating after, delta, bot rank, handicap, `estimate`: rank, floor, unassisted
  moves, hints, take-backs, rethinks) and sets the next bot; it never sets `ratingModel` (only the
  migration does). The step counts only entries with a `delta` (older profiles
  logged every game without one, and those never moved the rating). Neither applies a game twice
  (the profile is saved just before the finished game, so a crash between the two writes can bring
  the game back).
- **Next bot**: `round(rating)` as a rank, clamped to KataGo's human-SL range 20k … 9d. Below 20k the
  bot stays at 20k and `profile.handicap` is 2–4 stones when that is the nearer match for the
  learner's strength. A new 9×9 game as Black without an explicit bot rank or handicap uses them, with
  komi 0.5, and the new-game chat line says why.
- **Threshold by board size**: `profile.mistakeThreshold` is the 9×9 value; every use scales it with
  `thresholdFor(base, size)` (×1.5 on 13×13, ×2 on 19×19): teaching moments, the summary's mistakes
  (first attempts included) and so the problems made from them, the heuristic's "twice / 1.5× the
  threshold", the review's `!` marks and the UI's loss colors. `GameSummary.threshold` records the
  game's own (scaled) threshold, so a review uses what the game was played with; games saved before
  this have none and used the profile's threshold unscaled on every size (`recentGames[].threshold`,
  which keeps the profile's 9×9 value; `playedThreshold` applies this rule). Every `GameView` carries
  `mistakeThreshold`: the current game's, a finished game's own, and otherwise (idle, a problem) the
  current or next game's; a finished game's view also carries its `summary`, whose mistakes the
  result dialog lists.
- **Mistake categories**: each mistake in `GameSummary` (point loss ≥ the game's threshold) gets a category and a
  `categorySource`. The tutor's `tag` wins; otherwise the heuristic, checked in order: capturing race
  (adjacent opposing groups of 2+ stones with ≤ 3 liberties each, the played or best move on one of
  their liberties), life and death (a 2+ stone group's average ownership flips sign by ≥ 1), tactics
  (the move captured or self-ataried, or the best move or the opponent's best reply captures),
  opening (move ≤ 15% of the points), endgame (move ≥ 50% of the points), shape (an empty triangle or
  clump at the played point, with the best move within 3 lines or a loss under twice the threshold),
  direction (loss ≥ 1.5× threshold with the best move 4+ lines away), else other. Heuristic categories
  are counted in `mistakeCounts`/`recentMistakes` (cap 50) at game end; tags are counted when made
  and replace whatever the move was counted as. A run (see "Lessons") counts once, as its lead
  (`countedMistakes`): every member takes the lead's category, and a tag on any member tags them all
  (and their problems) while the profile changes once, on the lead. A tag also marks the category as practiced.
  Taken-back first attempts count like any move: their mistakes are in the summary (with
  `takenBack`, the index in `SavedGame.takenBack`), the tallies (`recentMistakes[].takenBack`) and
  the tutor tags them with `takenBack: n`, the try's number among those taken back at that move
  number (review's "first try #n"; `true` for the only one, an error listing them when there are
  several). One key names a mistake everywhere (`mistakeKey`: game, move number, and `#t<index>`
  for a first attempt): tallies, tags, problem sources and the migration.
- **Threshold**: after a game with too many mistakes (teaching moments) for its board, +0.5 (max 6):
  more than 6 on 9×9, scaled by the multiplier (`maxMoments`: 9 on 13×13, 12 on 19×19), not by the
  game's length, which would let a 19×19 game pause about 27 times before reacting. After three games at the
  current threshold whose average loss per human move, each divided by its board's multiplier (so on
  the 9×9 scale), is under 1.5, −0.5 (min 2). Both move the one 9×9 value, so all sizes move together.
  Changes go to `thresholdHistory`; `recentGames` (cap 20) keeps the per-game stats (first attempts included).

## Rank estimate

`src/server/estimate.ts`, run by the controller in the background after a rated game (one at a
time, queued with the migration). The samples are the learner's moves without help (`assist`
empty), the final ones and the taken-back first attempts (each in its own position), leaving out
passes and the opening (moves 1–4 on 9×9, 1–8 on 13×13, 1–16 on 19×19: every rank opens alike on a
small board, and one odd opening move swung a 5k bot's game from 5k to 1d in the validation runs).
With fewer than 5 samples there is no estimate. For each sample and each of 13 human-SL profiles
(20k, 18k, 15k, 12k, 10k, 8k, 5k, 3k, 1k, 1d, 3d, 5d, 9d) one query with
`overrideSettings.humanSLProfile`, `includePolicy`, `maxVisits: 1` and `BACKGROUND_PRIORITY` (−10,
below the game's queries; the deeper analyses for problems from a finished game and the migration
use it too; generated problems' self-play is lower still, `GENERATION_PRIORITY`), at
most twice KataGo's concurrency in flight (about 4 ms each; a 9×9 game is a few seconds). The first
failed query fails the estimate and stops the other workers. The log-likelihood per profile is the sum of `log(max(0.001, humanPolicy[move]))`;
the estimate is the best profile moved toward its better neighbor by a parabola through the three
(unevenly spaced on the rank scale), clamped to them; at the 20k end it is 10 with `floor: true`
("20k or weaker", the model goes no lower). Validated against real KataGo
(`test/server/rank-estimate.integration.test.ts`): human-SL bots at known ranks playing 9×9 games
against a 12k bot read, per game, 18k → 20k…14k, 12k → 16k…10k, 5k → 6k…4k, 1d → 2k…5d (one game
is noisy; the weak end leans toward the floor: 18k games pooled read 20k).

## Rating model migration

Profiles without `ratingModel: 2` are re-estimated once, when KataGo is first ready
(`GameController.migrateRatings`, from `index.ts`; afterwards it only runs the estimates still in
`estimating`). Games finished before it ran wait in `estimating` and are part of it. All its KataGo
work (at `BACKGROUND_PRIORITY`) comes before any write; if any query fails (an engine error or
crash, no human policy) it throws `MigrationAborted` having written nothing (no backup, games,
profile or problems; `ratingModel` unchanged), and the controller logs it and tries again after 1,
4 and 16 minutes or at the next engine-ready, at most 4 times per server run. `migrateRatingModel`:
- reads every finished (not abandoned) game and `events.jsonl` (both rotations). `reconstructGame`
  replays the game's events: `move` events rebuild the move stack, `teaching_moment` events carry the
  evals of moves later taken back, `undo` events (by human or tutor) pop them into first attempts
  (with the moves before them) and mark the next human move `retry`/`rethink`, and a `hint_request`
  marks the next move `hint` when the saved chat has a tutor message or KataGo's hint between the
  request and that move. The rebuild's help flags count only when its moves replay to exactly the
  saved game; otherwise the saved moves keep their own. First attempts come from the log when it
  replays the whole game (it can hold ones from before the file kept them), else from the file; what
  the file knows of each (its eval, category and tag) is kept.
- categorizes each taken-back mistake (`classifyPlayed`, as the controller does, with ownership
  from 100-visit analyses), rank-estimates each rated game, works out the practice problems for the
  taken-back mistakes on a scratch copy, and replays the rating from 20k through `applyEstimate` in
  game order. With fewer than 10 unassisted moves in all (every estimate ran; the games just have
  too few moves without help), the rating starts over at 20k (botRank 20k).
- then, synchronously: backs up `profile.json`, `problems.json` and the game files to
  `backup-<time>/`, writes the games (first attempts, help, summaries with the taken-back mistakes,
  built with the controller's helpers, and the new rating change), the profile as it is on disk now
  (rating, history, next bot, `ratingModel: 2`; only the migrated games leave `estimating`, so a
  game that finished meanwhile keeps waiting; taken-back mistakes added to the tallies once, by
  `mistakeKey`; `recentGames` stats recomputed with them) and the new problems with fresh ids
  (deduplicated by position and source move).
- logs one line and adds a system chat line ("Your rank was re-estimated from your 2 games: 19k (was
  17k) …"). Running it again gives the same result.
- **Focus** (`recommendFocus`): recent mistakes weighted 0.75^age per game (newest game = 1), plus a
  coverage boost of 0.1 per game since a category was last practiced (max 0.5, never practiced = 0.5).
  `other` is never recommended. Suggests `problems` for a local category (life and death, capturing
  race, tactics, shape) whose weight is ≥ 1.5, else `game`. The reason says the category "keeps
  costing points" only when it cost points in the last 3 games.
- **Problems**: a problem that ends (solved, or out of attempts) marks its category as practiced; a
  solve adds one to `problemsSolved`.

## Lessons

When a big point stays open while the learner plays elsewhere, each move elsewhere is a new mistake
with the same answer. At game end `gameRuns` finds these runs among the summary's mistakes (in move
order, taken-back first tries included): a mistake joins a run when it shares an accepted answer
with the run's last mistake and nothing was played on or next to that point (diagonals included)
between their positions; the run keeps the answers all its mistakes share. `GameSummary.runs` holds
each run of two or more (`answer`, `mistakes`, and `lead`: the tutor-tagged member, else the worst),
and `review`/`game_end` name it once ("A2 stayed the biggest point from move 57 to 69 (5 mistakes,
one lesson)") with its moves marked `(run A2)`.

A run is one lesson. The profile counts it once (above), and its practice problems become variants
(`StoredProblem.lesson`: the first variant's id and the answer; `linkGameLessons` when the problems
are made). The variants share `box`, `due`, `lastResult`, `missedAt` and the category: a result on
any of them is the lesson's (`recordLessonResult` writes it to all). `lessonInfo` (variant n of m,
the answer, the moves) goes on `ProblemView.lesson`, `problem_start.lesson` and `ProblemListItem.lesson`;
the problem card says "Variant 2 of 5" (and names the point only once the problem is answered).

A practice session is practice without a gap of 2 hours (`sessionStart`, from the stored
`lastSeen` and `missedAt`). A lesson missed a second time in one session is due no sooner than a
day later, whatever its box.

At startup, after `removeLegacyBuiltins`, `migrateLessons` runs once (`Profile.lessons`): it backs up
`profile.json`, `problems.json` and the game files it changes to `backup-<time>/`, gives finished
games their `summary.runs` (each run one category: the most recent tutor tag in it, else the
lead's), counts each run once in `mistakeCounts`, `recentMistakes` and `recentGames`, and links each
run's problems into a lesson (the lowest box, the earliest due); problems whose game is gone are
grouped from the problems themselves (`findRuns` over their boards and answers). The profile is
written first, so a stop partway can't take the tallies off twice.

## Practice problems

`data/problems.json` (`{ version: 1, problems: StoredProblem[] }`) holds every problem with its
spaced-repetition state: the learner's own (kind `game`, ids `p1`, `p2`, …) and generated ones
(kind `generated`, ids `gen1`, `gen2`, …; see "Generated problems"). A problem's `source` says which:
`{ gameId, moveNumber, played, takenBack? }` for the learner's game, `{ kind: "generated", batchId,
weakerRank, strongerRank, difficultyRank, difficultyRating, moveNumber, played, swapped }` for a
generated one (`gameSource` / `generatedSource` tell them apart). `recent` keeps the last 5 stones
played before the position (passes left out, oldest first, in the problem's colors: swapped with the
board for a swapped generated one); problems saved before it was kept lack it, and one from the
learner's game gets it from the saved game at its first start and keeps it (`recentFromGame`; empty
when the record is gone or no longer leads to its position). The view's `ProblemView.recentMoves` (`recentMovesView`) holds those whose
stone is still on the board, numbered back from the position (`ago` 1 = the last move; a point played
twice keeps the later one), and the board labels them "−1" … "−5" (smaller and lighter than a
variation's numbers, hidden under a drawn stone or mark); `tutor state` lists them on one line.

- **From mistakes**: when a game finishes, each mistake in its summary (point loss ≥ the threshold the
  game was played with, scaled to its board) becomes a problem: the position before the move as setup stones (no move
  history, so ko is not carried over), the learner to play, a prompt by category (`promptFor`), the
  accepted answers (KataGo's candidates from the move's eval within `ANSWER_MARGIN` = 1 point of its
  best, never a pass or the move played; besides the best, only candidates with 50+ visits), source game and move, category (the tutor's tag, else the
  heuristic, read again when the problem is saved; a later tag updates the problem) and difficulty
  (the point loss). Candidates with fewer than 2 moves or 200 visits in total are re-analyzed at 1000
  visits first (as many at once as KataGo runs queries), and so is a position where a ko ban applied (some empty point illegal only by positional superko, not just the immediate retake; the problem drops the history, so the
  recapture is legal there and the game's answers may not hold); if that analysis fails, a ko
  position gets no problem. No problem when KataGo's best is a pass. One problem per position (`positionHash` of board and side to move) and per source
  move (`mistakeKey`: game, move number, and for a taken-back first attempt its index, `source.takenBack`;
  such a problem is set up from the first attempt's own position). Ids are `p1`, `p2`, …
- **No built-ins**: the 12 hand-made starter problems (`b-…`, kind `builtin`) were replaced by
  generated ones. At startup `removeLegacyBuiltins` (from `index.ts`, before anything else reads the
  data) backs up `problems.json` to `backup-<time>/` and removes them, keeping the learner's problems
  and their schedules; with none left it does nothing, so it runs once.
- **Spaced repetition** (Leitner, boxes 1–5): new problems are in box 1 and due at once. Solved first
  try: up a box; solved on the second try: same box; failed (out of attempts, or left with Next
  problem, Back to playing or a new game after a wrong attempt): box 1. Left before any attempt: no
  change. Due again after the box's interval: 10 min, 1 day, 3 days, 7 days, 21 days. Once a
  problem on the board is over, `ProblemView.nextDue` holds its new due time, and the problem card
  says when it comes back ("You'll see this one again in about 10 minutes", "…tomorrow", "…in 3 days").
- **Next problem** (`pickNextProblem`, lessons.ts): lessons are picked, not problems (a problem not
  in a lesson is a lesson of one). A due lesson, preferring the recommended focus category (the
  learner's own before generated ones), then the learner's own problems, then generated ones; the
  longest overdue first, so a problem just missed doesn't jump the queue. The controller keeps the
  practice set (`practiceSet`: the problems since problem mode was entered; leaving it starts a new
  set), and while anything else is due the picker avoids the lesson and the game of the problem just
  shown and keeps the focus category to at most half of the set. When nothing is due, the lesson due
  soonest (an early review). The lesson shows its variant seen longest ago (`pickVariant`; never
  shown first, in move order). With no problems at all, Practice says why: the
  first batch is being generated (with its progress), or there are none yet.
- **Problem mode**: `next_problem` (browser) or `start_problem` (tutor) puts a problem on the board:
  `GameView.mode` is `"problem"`, `gameId` null, `board` the problem position, `settings.humanColor`
  the side to play, `status` `"playing"` until the problem is over and `"finished"` after, and
  `problem` a `ProblemView`. Emits `problem_start` (with the accepted answers, for the tutor). Any game
  waits underneath (the bot doesn't move); `leave_problem` returns to it, `new_game` ends problem mode.
  The learner plays one stone per attempt, 2 attempts. A known answer is correct; any other move is
  analyzed (600 visits, `problemVisits`) and is correct when its loss (as for game moves, above;
  unrounded) is at most 1 point. It becomes an answer only when KataGo searched it with 50+ visits in
  the problem position (otherwise its loss compares two separate searches). Correct: the overlay shows the move, and
  the opponent's best reply and the next move when KataGo has one (on a settled board the reply is
  often a pass, and then only the move is drawn). Wrong with an attempt left: a ✕ on the move and its point loss. Wrong on the last attempt: KataGo's
  best move and PV, with the move marked ✕. Every attempt emits `problem_attempt` (category, attempt
  number, first try, point loss, whether the answer is now shown, KataGo's best and PV). An attempt
  KataGo can't check doesn't count. In problem mode `show` and `mark` draw on the problem position
  (`show` starts with the learner's color), `say` works, and game-only actions (pass, resign, hint,
  Try again, Take back, rethink) are refused with a message. The game waiting underneath stays quiet: a move
  evaluated during practice opens its teaching moment, and a tutor timeout's fallback is shown, only
  when the learner goes back to the game. A tutor who attaches again while that fallback waits gets a
  fresh 30 s to take the moment instead.
- Problems of every board size work the same way: the view's `settings.size` is the problem's, and
  `problem_start` carries `size` (and `generated`: batch, difficulty rank, self-play ranks).
- **Reviewing a game's mistakes**: `review_game` (browser, with the finished game's id) or
  `start_problem` with `gameId` (tutor, `problem --game <id|last>`; "last" is the newest finished
  game) runs that game's lessons in move order (a taken-back first try before the move that
  stayed), one problem each (`pickVariant`), due or not. A finished game's view has `reviewProblems` (its lesson count,
  which the controller keeps per game from `problems.json`), and `review_game` is allowed when it is
  above 0. During a review, `next_problem` goes on to the review's next problem; after the last it
  leaves problem mode and says how it went ("Review done: you solved 2 of 3. …"); Next is refused
  while KataGo checks an attempt, and a problem that can't be set up is skipped. `leave_problem`, a
  new game or any other problem start ends the review. Each problem's `ProblemView.review` and
  `problem_start.review` (`{ gameId, index, total }`, 1-based) say where it stands. Results are
  scheduled like any other attempt.
- **Playing a problem out**: once a problem is answered (solved or out of attempts, and not while an
  attempt is being checked), `playout_start` lets the learner keep playing from it against KataGo to
  see how it unfolds. Not the default: the problem card offers it only then.
  - State (`PracticeSession`, never saved): one `line` of GTP moves from the problem position (the
    learner first), a `cursor` (moves of the line on the board), a `GoGame` at the cursor (built from
    the problem position and stepped with `play`/`undo`, so ko and passes count from the problem), a
    `gen` counter and `thinking`. It starts at the problem position with the answer's drawn line
    ahead (the learner's correct move and KataGo's follow-up, or KataGo's answer); the answer's
    drawing goes and comes back with `playout_exit` (Done).
  - `playout_back` / `playout_forward` step one move; Back also works while KataGo thinks (its answer
    is dropped) and after two passes. Forward replays the next move of the line; at the end of the
    line it asks KataGo for the side to play, so on the learner's turn KataGo moves for them. The
    learner's `play` or `pass` (their turn only, not while KataGo thinks, not after two passes) drops
    the moves that were ahead, only once the move is legal. No branches are kept.
  - KataGo's side answers by itself (`autoAnswer`) whenever a move leaves it to play: a Forward, the
    learner's move, or KataGo's move for them, unless two passes ended it. It replays the line's next
    move when the line goes on (so the play-out's 2nd move follows the 1st), else asks KataGo; with
    KataGo not ready, Forward asks later. Back never does: stepping back onto KataGo's turn (back over
    its move only) is the learner looking at that position, and Forward replays the move from there.
  - KataGo's move: a plain `analyze` of the play-out position (main net, no `humanSLProfile`, 600
    visits), never `botMove`, whatever the learner's level; `playoutMove` takes its best candidate that
    is legal in our rules, or a pass. The attempts' cached analyses are reused when they match; others
    are not cached. Every way a request ends checks the session, the play-out and `gen`, so a step,
    play, exit or problem change meanwhile drops the answer, a failure included; a failure otherwise
    says so in the chat, and Forward tries again.
  - Nothing is judged or recorded: the moves carry no eval, and the play-out emits no event, writes
    no problem, profile or rating. The view shows the play-out's board, side to move, `moves` (plain
    records) and captures, with `ProblemView.playout` (`line`, `cursor`, `thinking`, `over`, and
    `replyOwed` while the tutor owes the learner a reply).
  - The tutor stays out (`PracticeSession.admitTutor`, before any tutor command): `show` and `mark`
    are skipped, not refused (the command succeeds without drawing and its output says "not drawn",
    so a `show … && say …` chain still sends the say), and a `say` about the problem goes only while
    the tutor owes a reply, once: the result it hadn't answered when the learner pressed Play it out,
    or the learner's latest chat about the problem (sent with the tutor attached or not). A say, show
    or mark on the problem before the play-out, or a say during it, settles the reply; a
    `say --moment` about a game moment waiting underneath is the game's and settles nothing. That
    one rule (`replyOwed`) is what the stream reads: a fresh `watch` gets the problem's
    `problem_start` replayed, and `watch` attaches its state, only while a reply is owed (the state's
    play-out line says so); otherwise it prints "nothing to answer" under it. Abandoned KataGo
    requests are cancelled (`AbortSignal`), and playing the next move of the line just steps forward
    (without KataGo, when the line goes on past it: `allowed` then keeps `play`). `retry` and
    `take_back` point to Back; resign and hints are refused as in problems.

## Generated problems

`src/server/generate.ts`. KataGo plays itself with its human-SL net; the weaker side's big, clear,
local mistakes become one-move problems: the board just before the mistake, the move it should have
played. Judged like every problem (above): accepted answers are KataGo's moves within 1 point of its
best that it searched with 50+ visits; two attempts; KataGo's continuation on a solve, the
refutation after the second miss.

- **Batches** of 20: 7/7/6 on 9×9, 13×13 and 19×19, the 6 rotating 19×19, 13×13, 9×9 from batch to
  batch (`batchQuotas`). Komi 7 on every size. The first batch is 20k vs 15k. The next one starts
  when at least 15 of the newest batch's problems (still stored) are in Leitner box 3 or higher
  (`nextBatchTrigger`; checked at startup and after every problem result), with the weaker side at
  the learner's rank (`round(Profile.rating)`, clamped to 20k–9d) and the other side 5 ranks
  stronger (clamped). `tutor generate --now` (`{ type: "generate" }`) starts the next batch at once
  unless one is in progress. Problems join practice as they are found, not at the end of the batch.
- **Self-play**: one game at a time, on the size with the largest share of its quota still to find;
  the weaker side alternates Black and White from game to game on each size. One query per position
  (`SIZE_SETTINGS[size].screenVisits` visits, 200, with ownership and the human-SL policy of the
  side to move at its rank) gives both the eval of the move that led there and the next move,
  sampled by the bots' own `chooseBotMove`. A game ends at two passes or `maxMoves` (120 on 9×9,
  150 on 13×13 and 19×19; candidates come only from those moves).
- **Candidate filters** (`examineCandidate`), for each move of the weaker side from move 5 on:
  1. Big: the screening loss (root lead before minus after, as for the learner's moves) is at
     least `minLoss` (4 on 9×9, 6 on 13×13, 8 on 19×19).
  2. No ko: no empty point is illegal only by ko (`hasKoBan`), since the problem drops the history.
  3. New: its position hash (Black to play) isn't a stored problem's or a reserve candidate's.
  4. Black to play: a White mistake has every stone's color swapped. That changes who the komi
     helps, so everything below is measured on the problem position itself (Black to play, no
     history): a `CONFIRM_VISITS` (1600) analysis of it, and an 800-visit one after the mistake.
  5. Confirmed: the mistake still loses `minLoss`; KataGo's best isn't a pass.
  6. Clear: 1–3 accepted answers (`MAX_ANSWERS`), and the best well-searched move that isn't an
     answer (a pass counts) loses at least `minWrongGap` (3 on 9×9, 4 on 13×13, 5 on 19×19).
  7. Local: KataGo's best is within 2 lines (both directions) of one of the two moves before the
     mistake, or on or next to a stone of a group, or an empty point, whose screening ownership
     flips because of the mistake (`flippedPoints`).
  8. Not a repeat: no answer is an answer of a problem already taken (accepted or reserved) from
     the same self-play game. A 20k side often misses the same vital point several moves running,
     which made near-identical problems.
  Category and prompt come from the learner's mistake heuristic (`classifyPlayed` on the problem
  position, with the deeper analyses' ownership).
- **Difficulty**: the answers' combined human-SL probability in the problem position at each of the
  rank estimate's 13 profiles (one 1-visit query each); the difficulty is where it first reaches
  50%, interpolated between profiles on the rank scale (20k when the weakest profile already finds
  it, 9d when none does). Stored as `difficultyRating` and `difficultyRank`. A batch prefers
  problems from the learner's rank to 4 ranks stronger (`difficultyBand`, from the rating when the
  batch starts): one inside it is accepted at once; one outside waits in its size's reserve, and
  once more than 2 wait there the one closest to the band is accepted. So when a size's mistakes are
  mostly harder (common: what a 20k player misses, the 20k policy rarely plays), the batch still
  fills with the closest ones, at the cost of at most 2 unused problems per size.
- **Running in the server**: the controller owns a `ProblemGenerator` (`startGeneration()` from
  `index.ts` at startup; it starts the first batch when there is none). It runs while KataGo is
  ready and the learner isn't using it: nothing they wait on in flight (move eval, bot move,
  scoring, hint, problem check) and 10 s (`LEARNER_ACTIVE_MS`) since the learner's or the tutor's
  last action that needs KataGo (a move, a hint, a take-back, Continue, a new game, a problem,
  `rethink`, `resume`; a chat line, a level or judge change, hiding a drawing, a `say` or a `tag`
  doesn't). Each of those also cancels the generator's query in flight (`AbortSignal`, KataGo's
  `terminate`; a terminated query's slot frees after 10 s even if KataGo never answers it), so the
  learner's work never waits behind a 1600-visit search; the cancelled step runs again later, and a
  step stores nothing until all its queries are in. Its queries also use `GENERATION_PRIORITY`, below everything else. A failed
  step (KataGo restarting) is retried after 5 s, doubling to 5 min.
- **Progress** persists in `data/generation.json` (`GenerationFile`: the batches with their quotas,
  ranks, band, problem ids, created/finished times and per-size stats: found, games, moves, KataGo
  ms, screened, candidates, rejects by reason; and the batch in progress: the self-play game's moves
  so far and the reserve), written after every self-play move, so a restart resumes the game. A
  batch that starts emits `generation` (`started`) and a chat line; one that finishes emits
  `generation` (`finished`) and says how many problems are ready.
- **Measured** on an M1 (KataGo b18 nets; one generator query at a time, since two at once gave no
  more throughput): a 200-visit query takes about 0.75 s on 9×9 and 13×13 and 1.5 s on 19×19, a
  1600-visit one 3.5–7 s, a 1-visit policy query 30–60 ms. The first batch (20k vs 15k) took 39.5
  minutes of KataGo time: 9×9 6.1 min (4 games, 22 candidates examined), 13×13 19.7 min (6 games,
  70), 19×19 13.7 min (4 games of 150 moves, 46). Most rejects were "unclear" (the best wrong move
  1–2.5 points behind) and "too many answers" (a settled area where many moves are equal). 13×13
  games ran into the 150-move cap; past move 90 few candidates qualify, and the moves after 150 are
  the last dame of a 169-point board, so the cap stays. `tutor generate --status` shows each
  batch's minutes per size.

## Tutor CLI (`npm run -s tutor -- <command>`)

Designed to be run by a Claude Code session. Every command prints compact, readable text (not JSON
unless `--json`).

- `watch` — long-running. Connects to the event stream and prints one line per event the tutor acts
  on; what arrives in one chunk goes out in one stdout write, which Claude Code's Monitor tool turns
  into one notification (one Claude turn, the main cost of a session). Left out unless `--all`: moves,
  level and judge changes, batch starts, and take-backs except those undoing the position of an open
  moment or hint (`undo.during`). A waiting teaching moment, a hint request, a problem start or a
  learner's message while its game is in play (not one about a problem) comes with the `state`
  output under it, and a `game_end` with the `review` output, when the server
  answers within 3 s and the state is still about that event (else the line says to run it).
  A PROBLEM_START the server held back whose problem has left the board by the time it goes out is
  dropped. The attached state is brief (no chat tail or boilerplate lines; the last 12 moves and the
  earlier mistakes; one state fetch per write, each printed once; a question on a board that hasn't
  changed since the last state printed gets a one-line note instead) and the review leaves out the move list.
  `--json` prints every event raw. Reconnects with `since=` on drop. `npm run sim:tokens`
  (`scripts/token-sim.ts`) runs a scripted session through the real bridge and `watch` and prices the
  Claude calls it would cause.
- `state` — the current position as ASCII plus move list with evals, the mistake threshold on this
  board, moment, and chat tail. In a game every command's status line has `threshold=<pts>` too.
- `say <text>`, `rethink <text>`, `show <moves...> [--label L] [--start B|W]`, `mark <pts...> [--kind circle] [--text T]`,
  `clear`, `resume` (with a drawing up it prints a second line, "still paused: …", since the pause
  then waits for the learner's Continue; `--json` adds `stillPaused` to the view, and `state` shows the
  moment "waiting for the learner to press Continue"), `claim <momentId>`, `new-game [--size 9] [--rank 20k] [--color B]`,
  `problem [id]` (start a practice problem, the next due one without an id), `tag <gameId> <move#> <category> [note] [--taken-back [n]]`
  (`--taken-back n`: the taken-back try #n at that move, as review numbers them; bare `--taken-back`
  when there is only one).
- `watch` prints `GAME_END …` with the help the learner had and "rank estimate running (a RATING line
  follows)" for a rated game, then `RATING <gameId> rank estimate 18k from 25 unassisted moves (1 hint);
  rating 10 -> 11.9 (+1.9, rank 18k); next bot 18k` (usually in the same write, see the bridge).
- `summary` — learner profile: rank estimate with the trend over the last 5 rated games, the last
  game's move-quality estimate (rank, unassisted moves, help), each recent rated game's estimate, bot rank (and
  handicap), the tutor level and what it means for the tutor, the threshold on each board size ("4 pts on
  9×9 (6 on 13×13, 8 on 19×19)") and its last change, mistake counts by category with the last 3 games and a
  rising/falling trend, recent mistakes, the recommended focus and its reason, and practice problems
  (counts from games and generated, problem generation: the batch in progress or the last batch's
  mastery count, due now by category, per box, and the next few due). Used at session start.
- `problem --game <gameId|last>` — review a finished game's mistakes (see "Reviewing a game's
  mistakes"); `PROBLEM_START` and `state`'s problem line then say `review g12 2/4`.
- `problems` — every practice problem, due first in about the order `problem` picks lessons (each variant marked `[lesson p23 2/5: A2, moves 57-69]`), with source (or "generated
  13x13, difficulty 14k, batch2"), box, due time, results and the accepted answers.
- `generate [--status]` — problem generation: the batch in progress (per size found/target), the
  last batch and its mastery count, and KataGo minutes per size. `generate --now` starts the next
  batch first (refused while one is in progress).
- `watch` prints `BATCH <id> started (<trigger>): 20 problems from <weaker> vs <stronger> self-play,
  difficulty band …` and `BATCH <id> finished: 20 new problems (7 on 9x9, …)`.
- `watch` prints chat sent during a problem as `USER "<text>" (problem <id>)`.
- `watch` prints the level on `GAME_START … level=<level>`, a `point_out` moment as `MOMENT … — level
  point_out: explain mistakes, don't take moves back … — reply with: claim <id>, then say/show/mark/resume`,
  a change (with `--all`) as `LEVEL <level> — <what it means for the tutor> (from the learner's next
  move)`, and a game's chat as `USER "…" game=<id> level=<level>` (`user_message.tutorLevel`).
  `state` and every command's status line (`level=<level>`) show it too.
- `watch` prints the judge mode on `GAME_START … judge=<mode>` (with ` ref=<rank>` on `at_level`), a
  change as `JUDGE judge=<mode> … (from the learner's next move)`, an at-level moment as `MOMENT … lost
  N pts (judged at level: vs the 17k move D4, pv …; vs KataGo's best D5 it lost M)`. `state`'s
  last-move line ends with `, at level -N vs 17k D4` for a move judged at level (`+N` for a gain, `0`
  for the reference move itself). `summary` and `state` have a `judge <mode>` line, and the status
  line has `judge=at_level ref=<rank>` in that mode.
- `watch` prints `PROBLEM_START <id> <category> <color> to play (<source>, box N) answers … — "<prompt>"`
  and `PROBLEM <id> attempt N <move> correct, first try | wrong, lost X (…; another attempt left | out of
  attempts, answer shown) — best …, pv …` with a hint of what to do next.
- `review <gameId|last>` — compact post-game review: result, rank estimate, rating change and next
  bot, the help (counts, and which moves had help), one line per mistake (move, played, best, loss,
  category and whether it is the heuristic's, KataGo's PV; a taken-back first attempt says "first try #n,
  taken back by the tutor/learner"), win-rate swings of 15+ points (the learner's moves and the bot's),
  the ASCII board before each of the 3 worst mistakes (a first attempt's from its own position), and
  the compact move list (`*` = played with help).

ASCII board format (used by `toAscii` and in events): column letters on top and bottom, row numbers on
both sides, `X` black, `O` white, `.` empty, `+` star points, the last move wrapped in parentheses.

## UI

One screen: board on the left (canvas, scales to fit, wood background, star points, coordinates), side
panel on the right with: game controls (New game, Pass, Take back, Practice, Resign), a status line (whose turn, captures,
bot rank, tutor connected or not), an eval strip (point loss of the last human move, colored green
below 1 point, amber below the mistake threshold, red at or above it; both cutoffs scale with the board,
so green is below 1.5 on 13×13 and 2 on 19×19), the teaching-moment
banner (Continue / Try again buttons, countdown while waiting for the tutor), a Progress card (rank,
the last game's estimate ("18k · 34 moves", the full sentence in its tooltip, "estimating…" while it
runs), next bot with any handicap, games, "Pauses at" (the mistake threshold on the current board,
every size in its tooltip), top 2 mistake categories, "Problems" (from the view's `generation`, so
it moves as problems are found: "Generating 7/20" while a batch is made, else the last batch's
"9/15 mastered"; the details in its tooltip), rating sparkline; fetched from
`GET /api/profile` on load and whenever the view's `profileVersion` changes), and the chat panel,
whose form has the Hint button between the input and Send (the typed text, if any, goes with the
hint as the question; H still asks for one). Take back follows `allowed` (`take_back`). The result
dialog shows "Estimating your rank from your moves…" until the estimate is in, then the game's
rating change with its rank estimate ("Rank estimate 18k from 34 unassisted moves (3 hints, 2
take-backs)"). The new-game form's bot defaults to "Auto" (the profile's rank and handicap). Mobile
width stacks the panel under the board. Ghost stones and marks from `overlay` are drawn on the board;
KataGo's highlighted move too (`overlay.best`): the UI draws only what the overlay holds, so hiding
it hides everything. While one is up, a "✕ Hide" button next to the board caption (and Esc, unless
focus is in a form control, which keeps its own Esc) sends `clear_overlay`.
A pass places no stone, so the UI derives it from the view's last move (`lastPass` in
`web/src/geometry.ts`): when the bot passes, a banner across the board says "White passed" for a few
seconds (or "White passed too: the game is over" when it answers the learner's pass), and the status
line (an `aria-live` region, which screen readers hear) keeps saying it until the next move ("White
passed. Your move (Black): pass too to end the game, or play on.", then "…Counting the score…" and
"…Game over." once both passed). The `?mock` bot passes on its third move to show it. A problem's
play-out gets the same (its `moves` are the play-out's, KataGo being the bot). The banner shows once
per pass in each game or problem: going to a problem and back doesn't show the game's again.
The status, controls, last-move and progress cards are collapsible: their header is a `<button
aria-expanded>` that folds the card to its header line (the turn, the last move's loss, the rank, or
the tutor level stay visible there), remembered per card in localStorage (`web/src/collapse.ts`; any
storage failure just means cards start open). The teaching-moment banner and the problem card are not
collapsible, so a decision is never hidden. The chat card fills the rest of the panel's height (its
input always visible), so folding cards gives it room. The controls card has a segmented control
(radio buttons) for the tutor level, "Silent", "Point out", "Coach", with the selected level's
description below it (and each one's in its tooltip), and a second one, "Judge my moves", for the
judge mode, "Optimal" or "At level" (the description names the game's reference rank). Judged at
level, the last-move card shows the loss against the reference move ("−2.1 pts", "Move 14 · C3 ·
vs 17k D4"), or a gain in green ("+1.5 pts") when the move beat it, and the moment banner's title
names the reference move ("lost 4.4 points vs a 17k's D4"). The moment banner says "Your tutor is done —
take your time, then press Continue." while the moment is `awaitingLearner`.
Practice (or the tutor's `problem`) switches to problem mode (with no problems yet, a toast says the
first ones are being generated, with the count; the button's tooltip shows it too): a problem card
replaces the eval strip with the category and source ("from your game, move 14", or for a generated
problem its board and difficulty, "13×13 · about 14k"), the prompt, attempts left, the verdict (correct, or the point loss of
the attempt and, once out of attempts, the answer; once the problem is over, when it comes back), and
Next problem / Back to playing buttons; a variant of a lesson adds a muted line ("Variant 2 of 5 ·
Moves 57 to 69 all missed the same point", naming the point once answered). A finished game with practice problems shows "Review mistakes
(3)" in the result dialog and in the controls; during the review the card's heading is
"Review 2/3 · Shape · move 20" and Next reads "Next mistake", then "Finish review" on the last. The
board takes clicks and shows the hover stone as in games; Pass, Take back, Hint and Resign are disabled.
Once the problem is answered the card offers "Play it out": a play-out row ("Move 3 of 5 · nothing
here is judged") with ◀ Back, Forward ▶ (its tooltip says when KataGo moves for the learner) and
Done replaces the verdict, the Left and Right arrow keys step, Pass (P) works on the learner's turn,
and the play-out's stones are numbered from 1 (the last move has the marker).
Live updates arrive over `GET /api/events` (SSE of `GameView`; each connection starts with the current
view, and `GET /api/state` is fetched only if the stream never opens). Controls follow the view's
`allowed` actions. The canvas draws the scene into an offscreen layer once per change; the hover
stone is drawn over a copy of it.
