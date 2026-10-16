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
| `src/shared/coords.ts` | `toGtp(point, size)`, `fromGtp(gtp, size)`, (columns `A`–`T` skipping `I`; row 1 at the bottom). |
| `src/shared/rank.ts` | `rankToRating("20k") → 10`, `ratingToRank(10) → "20k"` on the scale 30k=0 … 1k=29, 1d=30 … 9d=38. |
| `src/engine/` | Pure Go rules: `GoGame` class (play/pass/undo, captures, suicide illegal, positional superko), area scoring with komi, dead-stone input from KataGo ownership, `toAscii(board)`, SGF read/write. No I/O. |
| `src/server/katago.ts` | Long-lived `katago analysis` child process speaking the JSON analysis protocol; query queue with ids; `analyze(position, opts)`, `botMove(position, rank)`, `ownership`. |
| `src/server/game.ts` | `GameController`: owns the current game, turns, bot replies, per-move evals, teaching-moment detection, pause + fallback timer, chat log, producing `GameView` and `TutorEvent`s. Takes an engine interface so tests can use a fake. |
| `src/server/bridge.ts` | Tutor bridge: event sequence numbers, `data/events.jsonl` append log, SSE fan-out to `tutor watch` connections, `tutorAttached` tracking, applying `TutorCommand`s to the controller. |
| `src/server/store.ts` | Persistence under `data/` (path overridable with `GO_TUTOR_DATA`): `games/<id>.sgf` + `games/<id>.json` (settings, moves with evals, result, summary), `games/index.json` (creation time and finished flag per game, so finding the last game reads one file), `profile.json`, `problems.json`. The controller coalesces game saves to one write per tick and flushes on shutdown and at game end. |
| `src/server/profile.ts` | Learner memory, pure functions over `Profile`: rank adaptation (`applyGame`), heuristic mistake categories (`classifyMistake`), tutor tags (`applyTag`), the adaptive mistake threshold, and `recommendFocus`. See "Learner profile". |
| `src/server/problems.ts` | Practice problems, pure functions over `StoredProblem`: problems from a finished game's mistakes, the built-in merge, position hashes, Leitner scheduling, which problem comes next, the `GET /api/problems` body. See "Practice problems". |
| `src/server/builtin-problems.ts` | The built-in starter set: a dozen classic 9×9 problems as readable board diagrams with their answers (verified against real KataGo in `test/server/katago.integration.test.ts`). |
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
- Analysis: one query per position, with `includeOwnership` only where ownership is used; read
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
3. Eval arrives → attach `MoveEval` to the record. If `pointLoss >= profile.mistakeThreshold` (default 4)
   it is a **teaching moment**: status `paused`, moment state `waiting`, emit `teaching_moment`.
   - If a tutor is attached: wait up to 30 s (`TUTOR_TIMEOUT_MS`) for any tutor command about the moment
     (`claim`, `say`, `rethink`, `show`, `mark`). Any of them sets state `tutor` and cancels the timer.
   - If no tutor is attached or the timer fires: state `fallback`, overlay draws KataGo's PV as a variation
     with `fromMove` set (the UI shows the board from before the mistake, numbered PV, the played point
     marked ✕), a system chat message states the point loss in plain words. Emit `fallback`.
   - The pause ends when the human presses Continue (`continue`), the tutor sends `resume`, or the human
     plays again after a `rethink` (which undoes their move).
4. When not paused, the bot replies (with a small delay so it feels natural). Emit `move` (by bot).
5. Game ends on two consecutive passes (score with KataGo ownership to remove dead stones) or resign.
   Build the `GameSummary` (mistakes categorized), update the profile (its `RatingChange` goes into
   `summary.rating`), save the game, emit `game_end`. Then, in the background, each mistake becomes a
   practice problem (see "Practice problems").

A move's point loss is KataGo's root lead before it minus the root lead after it, except for a move
KataGo searched well (50+ visits) in the position before: that one loses its candidate's lead below
the best candidate of the same search, since two separate searches disagree by a point or more run
to run (so KataGo's own best move never shows a loss).

One cached query per position serves move evals, the bot's pass check, hints and scoring. Only
scoring and classifying a mistake ask for ownership; a cached analysis without ownership doesn't
satisfy them, and the one with ownership replaces it. When a human move's eval reaches the mistake
threshold the controller classifies it right away without ownership, then, in the background (the
teaching moment doesn't wait), again with the ownership before and after it, and keeps the category
in the saved game's `heuristics` (the ownership itself isn't saved). A mistake without one (evaluated
before a restart) is classified at game end without ownership.

Bot moves are never evaluated as teaching moments. Only the human's moves are.

`ask_tutor` emits `hint_request` (with the current ASCII board). With no tutor attached the server
answers with KataGo's top move marked as a hint.

`chat` from the user emits `user_message`. On a practice problem it carries `problemId` (and no moment
id), since the message is about the problem on the board, not the game waiting underneath. With no
tutor attached, the server adds a system reply saying the tutor isn't connected.

## Tutor bridge

- `GET /api/tutor/events?since=<seq>&epoch=<id>` is an SSE stream of `TutorEvent`s. While at least one such
  connection is open, `tutorAttached` is true. Events are also appended to `data/events.jsonl` (rotated
  to `events.1.jsonl` past 8 MB). The first frame is `event: hello` with `{ epoch, since }`: `epoch`
  identifies the server boot; a cursor from another epoch is clamped to this boot's first seq (seqs
  that never reached the log can be reused after a restart), and `since` is where the replay starts.
  Replayed teaching moments carry the moment's current state (the game's, also while a practice
  problem is on the board). A stream without `since` gets the open teaching moment and the problem on
  the board, if any.
- `/api/*` rejects requests with a foreign `Origin` (anything but this server and the Vite dev server
  on port 5173) with 403, and POSTs without `content-type: application/json` with 415. The server
  listens on 127.0.0.1 only.
- `POST /api/tutor` takes a `TutorCommand` JSON body and returns `{ ok: true, view: GameView }` or
  `{ ok: false, error }` with a message a person can act on.
- `GET /api/state` returns the `GameView`. `GET /api/game/:id` (or `last`) returns a saved game
  (`games/<id>.json`: settings, moves with evals and PVs, result, summary with categories and rating
  change, chat, tags, heuristics). `GET /api/profile` returns `ProfileResponse`: `{ profile, focus }`.
  `GET /api/problems` returns `ProblemsResponse`: every problem (`ProblemListItem`: category, source,
  box, due, results, accepted answers) in the order `next_problem` picks them, counts (total, due, from
  games, built-in, per box, due per category) and the focus.

## Learner profile

`data/profile.json`, updated by `src/server/profile.ts` when a game finishes (not when abandoned) and
when the tutor tags a mistake.

- **Rating** (rank scale, 20k = 10). Expected score `1 / (1 + 10^((bot - rating) / 3))` (one rank ≈ 68%),
  where `bot` is the bot's rank minus handicap stones given to the learner (1.5 ranks per stone on 9×9,
  1.25 on 13×13, 1 on 19×19; rough). Change = `2 × step × (score − expected)`, with step 1.5 for the
  first five rated games, then 1.25, 1, 0.75 and 0.5 from then on, so an even win early moves 1.5
  ranks. Resignations count; games under 10 human moves don't change the rating. Each rated game
  appends to `ratingHistory` (rating after, delta, bot rank, handicap); the step counts only entries
  with a `delta` (older profiles logged every game without one, and those never moved the rating).
  A game already in `ratingHistory` or `recentGames` is never applied twice (the profile is saved
  just before the finished game, so a crash between the two writes can bring the game back).
- **Next bot**: `round(rating)` as a rank, clamped to KataGo's human-SL range 20k … 9d. Below 20k the
  bot stays at 20k and `profile.handicap` is 2–4 stones when that is the nearer match for the
  learner's strength. A new 9×9 game as Black without an explicit bot rank or handicap uses them, with
  komi 0.5, and the new-game chat line says why.
- **Mistake categories**: each mistake in `GameSummary` (point loss ≥ threshold) gets a category and a
  `categorySource`. The tutor's `tag` wins; otherwise the heuristic, checked in order: capturing race
  (adjacent opposing groups of 2+ stones with ≤ 3 liberties each, the played or best move on one of
  their liberties), life and death (a 2+ stone group's average ownership flips sign by ≥ 1), tactics
  (the move captured or self-ataried, or the best move or the opponent's best reply captures),
  opening (move ≤ 15% of the points), endgame (move ≥ 50% of the points), shape (an empty triangle or
  clump at the played point, with the best move within 3 lines or a loss under twice the threshold),
  direction (loss ≥ 1.5× threshold with the best move 4+ lines away), else other. Heuristic categories
  are counted in `mistakeCounts`/`recentMistakes` (cap 50) at game end; tags are counted when made
  and replace whatever the move was counted as. A tag also marks the category as practiced.
- **Threshold**: after a 9×9 game with more than 6 mistakes, +0.5 (max 6). After three games at the
  current threshold whose average loss per human move is under 1.5, −0.5 (min 2). Changes go to
  `thresholdHistory`; `recentGames` (cap 20) keeps the per-game stats.
- **Focus** (`recommendFocus`): recent mistakes weighted 0.75^age per game (newest game = 1), plus a
  coverage boost of 0.1 per game since a category was last practiced (max 0.5, never practiced = 0.5).
  `other` is never recommended. Suggests `problems` for a local category (life and death, capturing
  race, tactics, shape) whose weight is ≥ 1.5, else `game`. The reason says the category "keeps
  costing points" only when it cost points in the last 3 games.
- **Problems**: a problem that ends (solved, or out of attempts) marks its category as practiced; a
  solve adds one to `problemsSolved`.

## Practice problems

`data/problems.json` (`{ version: 1, problems: StoredProblem[] }`, read through `Store.loadProblems`,
which merges in the built-in set) holds every problem with its spaced-repetition state.

- **From mistakes**: when a game finishes, each mistake in its summary (point loss ≥ the threshold the
  game was played with) becomes a problem: the position before the move as setup stones (no move
  history, so ko is not carried over), the learner to play, a prompt by category (`promptFor`), the
  accepted answers (KataGo's candidates from the move's eval within `ANSWER_MARGIN` = 1 point of its
  best, never a pass or the move played; besides the best, only candidates with 50+ visits), source game and move, category (the tutor's tag, else the
  heuristic, read again when the problem is saved; a later tag updates the problem) and difficulty
  (the point loss). Candidates with fewer than 2 moves or 200 visits in total are re-analyzed at 1000
  visits first (as many at once as KataGo runs queries), and so is a position where a ko ban applied (the problem drops the history, so the
  recapture is legal there and the game's answers may not hold); if that analysis fails, a ko
  position gets no problem. No problem when KataGo's best is a pass. One problem per position (`positionHash` of board and side to move) and per source
  move. Ids are `p1`, `p2`, …
- **Built-ins** (`b-…`): 12 classic 9×9 positions (life and death, snapbacks, a ladder, a net, a
  connection, capturing races) with the rest of the board settled so the local answer decides the
  game. Their definitions come from the source file on every load; only progress and answers found
  later are stored. The integration test checks each against real KataGo: KataGo's best is an answer,
  every answer is within 1 point, passing costs ≥ 3 points and the best wrong move ≥ 2.
- **Spaced repetition** (Leitner, boxes 1–5): new problems are in box 1 and due at once. Solved first
  try: up a box; solved on the second try: same box; failed (out of attempts, or left with Next
  problem, Back to playing or a new game after a wrong attempt): box 1. Left before any attempt: no
  change. Due again after the box's interval: 10 min, 1 day, 3 days, 7 days, 21 days.
- **Next problem** (`pickNextProblem`): a due problem, preferring the recommended focus category (the
  learner's own before built-ins), then the learner's own problems, then built-ins; lower boxes and
  older due times first; never the problem just shown while there is another. When nothing is due,
  the one due soonest (an early review).
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
  Try again, rethink) are refused with a message. The game waiting underneath stays quiet: a move
  evaluated during practice opens its teaching moment, and a tutor timeout's fallback is shown, only
  when the learner goes back to the game. A tutor who attaches again while that fallback waits gets a
  fresh 30 s to take the moment instead.

## Tutor CLI (`npm run -s tutor -- <command>`)

Designed to be run by a Claude Code session. Every command prints compact, readable text (not JSON
unless `--json`).

- `watch` — long-running. Connects to the event stream and prints **one line per event** (that is what Claude Code's
  Monitor tool turns into notifications). Teaching moments and hint requests print a single line with
  the essentials: moment id, move, point loss, best move, PV. Reconnects with `since=` on drop.
- `state` — the current position as ASCII plus move list with evals, moment, and chat tail.
- `say <text>`, `rethink <text>`, `show <moves...> [--label L] [--start B|W]`, `mark <pts...> [--kind circle] [--text T]`,
  `clear`, `resume`, `claim <momentId>`, `new-game [--size 9] [--rank 20k] [--color B]`,
  `problem [id]` (start a practice problem, the next due one without an id), `tag <gameId> <move#> <category> [note]`.
- `summary` — learner profile: rank estimate with the trend over the last 5 rated games, bot rank (and
  handicap), threshold and its last change, mistake counts by category with the last 3 games and a
  rising/falling trend, recent mistakes, the recommended focus and its reason, and practice problems
  (counts from games and built-in, due now by category, per box, and the next few due). Used at
  session start.
- `problems` — every practice problem in the order `problem` picks them, with source, box, due time,
  results and the accepted answers.
- `watch` prints chat sent during a problem as `USER "<text>" (problem <id>)`.
- `watch` prints `PROBLEM_START <id> <category> <color> to play (<source>, box N) answers … — "<prompt>"`
  and `PROBLEM <id> attempt N <move> correct, first try | wrong, lost X (…; another attempt left | out of
  attempts, answer shown) — best …, pv …` with a hint of what to do next.
- `review <gameId|last>` — compact post-game review: result, rating change and next bot, one line per
  mistake (move, played, best, loss, category and whether it is the heuristic's, KataGo's PV), win-rate
  swings of 15+ points (the learner's moves and the bot's), the ASCII board before each of the 3 worst
  mistakes, and the compact move list.

ASCII board format (used by `toAscii` and in events): column letters on top and bottom, row numbers on
both sides, `X` black, `O` white, `.` empty, `+` star points, the last move wrapped in parentheses.

## UI

One screen: board on the left (canvas, scales to fit, wood background, star points, coordinates), side
panel on the right with: game controls (New game, Pass, Hint, Practice, Resign), a status line (whose turn, captures,
bot rank, tutor connected or not), an eval strip (point loss of the last human move), the teaching-moment
banner (Continue / Try again buttons, countdown while waiting for the tutor), a Progress card (rank
estimate, next bot with any handicap, games, top 2 mistake categories, rating sparkline; fetched from
`GET /api/profile` on load and after each game end), and the chat panel. The result dialog shows the
game's rating change. The new-game form's bot defaults to "Auto" (the profile's rank and handicap). Mobile
width stacks the panel under the board. Ghost stones and marks from `overlay` are drawn on the board.
Practice (or the tutor's `problem`) switches to problem mode: a problem card replaces the eval strip
with the category and source, the prompt, attempts left, the verdict (correct, or the point loss of
the attempt and, once out of attempts, the answer), and Next problem / Back to playing buttons. The
board takes clicks and shows the hover stone as in games; Pass, Hint and Resign are disabled.
Live updates arrive over `GET /api/events` (SSE of `GameView`).
