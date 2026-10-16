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
| `src/server/profile.ts` | Rank adaptation, mistake tallies, heuristic mistake categories. (Milestone 4) |
| `src/server/problems.ts` | Practice problems built from past mistakes. (Milestone 5) |
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
- Analysis: one query per position with `includeOwnership` when needed; read
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
   no handicap). Emits `game_start`.
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
   Emit `game_end` with a `GameSummary`, save the game, update the profile.

Bot moves are never evaluated as teaching moments. Only the human's moves are.

`ask_tutor` emits `hint_request` (with the current ASCII board). With no tutor attached the server
answers with KataGo's top move marked as a hint.

`chat` from the user emits `user_message`. With no tutor attached, the server adds a system reply saying the
tutor isn't connected.

## Tutor bridge

- `GET /api/tutor/events?since=<seq>&epoch=<id>` is an SSE stream of `TutorEvent`s. While at least one such
  connection is open, `tutorAttached` is true. Events are also appended to `data/events.jsonl` (rotated
  to `events.1.jsonl` past 8 MB). The first frame is `event: hello` with `{ epoch, since }`: `epoch`
  identifies the server boot; a cursor from another epoch is clamped to this boot's first seq (seqs
  that never reached the log can be reused after a restart), and `since` is where the replay starts.
  Replayed teaching moments carry the moment's current state.
- `/api/*` rejects requests with a foreign `Origin` (anything but this server and the Vite dev server
  on port 5173) with 403, and POSTs without `content-type: application/json` with 415. The server
  listens on 127.0.0.1 only.
- `POST /api/tutor` takes a `TutorCommand` JSON body and returns `{ ok: true, view: GameView }` or
  `{ ok: false, error }` with a message a person can act on.
- `GET /api/state` returns the `GameView`. `GET /api/game/:id` returns a saved game. `GET /api/profile`.

## Tutor CLI (`npm run -s tutor -- <command>`)

Designed to be run by a Claude Code session. Every command prints compact, readable text (not JSON
unless `--json`).

- `watch` — long-running. Connects to the event stream and prints **one line per event** (that is what Claude Code's
  Monitor tool turns into notifications). Teaching moments and hint requests print a single line with
  the essentials: moment id, move, point loss, best move, PV. Reconnects with `since=` on drop.
- `state` — the current position as ASCII plus move list with evals, moment, and chat tail.
- `say <text>`, `rethink <text>`, `show <moves...> [--label L] [--start B|W]`, `mark <pts...> [--kind circle] [--text T]`,
  `clear`, `resume`, `claim <momentId>`, `new-game [--size 9] [--rank 20k] [--color B]`, `problem [id]`,
  `tag <gameId> <move#> <category> [note]`.
- `summary` — learner profile: rank estimate, bot rank, mistake counts by category, recent mistakes,
  open problems. Used at session start to decide what to do.
- `review <gameId|last>` — the saved game's moves with evals and mistakes, for a post-game review.

ASCII board format (used by `toAscii` and in events): column letters on top and bottom, row numbers on
both sides, `X` black, `O` white, `.` empty, `+` star points, the last move wrapped in parentheses.

## UI

One screen: board on the left (canvas, scales to fit, wood background, star points, coordinates), side
panel on the right with: game controls (New game, Pass, Resign, Hint), a status line (whose turn, captures,
bot rank, tutor connected or not), an eval strip (point loss of the last human move), the teaching-moment
banner (Continue / Try again buttons, countdown while waiting for the tutor), and the chat panel. Mobile
width stacks the panel under the board. Ghost stones and marks from `overlay` are drawn on the board.
Live updates arrive over `GET /api/events` (SSE of `GameView`).
