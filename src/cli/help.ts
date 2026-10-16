// Help text. The reader is a Claude Code session acting as the Go teacher.

export const USAGE = `usage: npm run -s tutor -- <command> [args] [--json]
commands: watch, state, say, rethink, show, mark, clear, resume, claim, new-game, problem, tag, summary, review, help
run "npm run -s tutor -- help" for details and examples`;

export const HELP = `Go Tutor CLI: you (Claude) are the teacher. The learner plays Go in a browser against KataGo;
KataGo analyzes every human move and the server pauses the game at teaching moments.

Run as: npm run -s tutor -- <command> [args]     (server: $TUTOR_SERVER, default http://localhost:4747)
Coordinates are GTP: column letters A-T without I, row 1 at the bottom (e.g. D4). Colors: B or W.
Exit codes: 0 ok, 1 server error (message on stderr), 2 usage error. Add --json to any command for raw JSON.

SESSION FLOW
  1. summary                 learner's rank, weak categories, open problems: decide what to do
  2. watch                   start under the Monitor tool; prints one line per event, forever
  3. on MOMENT:  claim <id> within the deadline, run state, then teach with say/show/mark/rethink,
                 and finish with resume (or let the learner press Continue). If you don't claim in time
                 a FALLBACK line appears: KataGo's answer is already shown; you can still add a say.
  4. on HINT:    run state, then say/show/mark. Don't give the answer outright unless asked.
  5. on USER:    answer with say (pass --moment <id> when the line names one).
  6. on GAME_END: review <gameId>, tag the mistakes, discuss, maybe new-game.

COMMANDS
  watch [--since N]
      Follow the event stream. stdout carries exactly one line per event; diagnostics go to stderr.
      Reconnects by itself (resuming after the last seq) with backoff, and follows a restarted server's
      replay. --since N replays events after seq N. A replayed MOMENT shows its current state instead of
      a countdown, e.g. "(replayed; now fallback)" or "(replayed; already resolved)".
      Lines:
        GAME_START g12 9x9 komi 7 human=B bot=20k
        MOVE 15 W D6 (bot)
        MOMENT m3 game=g12 move 14 B C3 lost 6.2 pts (best D5, pv D5 E4 C6) — reply with: claim m3, ...
        HINT game=g12 B to play — user asks: "where now?" — run: state, then say/show/mark
        USER "why was that bad?" (moment m3) game=g12
        FALLBACK m3 (tutor too slow; KataGo answer shown)
        UNDO game=g12 by human: back to move 13, B to play   (the position you were discussing is gone)
        GAME_END g12 W+3.5 — 3 mistakes, worst move 14 (6.2), total loss 15 over 61 moves — run: review g12
        PROBLEM p4 attempt C7 wrong
      Example: npm run -s tutor -- watch

  state
      The current board as ASCII (X black, O white, + star point, (X) last move), the move list with the
      human's point loss per move (! = mistake), KataGo's best move and candidates for the last move,
      the teaching moment, the overlay currently drawn, and the last chat lines.
      Example: npm run -s tutor -- state

  claim <momentId>
      Take ownership of a teaching moment; cancels the KataGo fallback timer. Do this first.
      Example: npm run -s tutor -- claim m3

  say <text> [--moment <id>]
      Post a chat message to the learner. Quote the text.
      Example: npm run -s tutor -- say "C3 is slow: it doesn't threaten anything. Where is the weak group?" --moment m3

  rethink <text> [--moment <id>]
      Take back the open teaching moment's move and ask the learner to try again; the game stays
      paused until they play. Only works once per moment, while its move is still the last one.
      Example: npm run -s tutor -- rethink "Your group at E5 has one eye. Find a move that saves it."

  show <moves...> [--label <text>] [--start B|W]
      Draw a variation as numbered ghost stones. Moves alternate colors starting with --start
      (default: the color that made the moment's move). "pass" is allowed.
      Which position it is drawn on: during a teaching moment whose move is still on the board, a
      line starting with the mover's color (the default) replaces that move, so the board shows the
      position BEFORE it (with KataGo's fallback line drawn the same way); a line with --start set
      to the other color continues from the current position, after the move. After a rethink, or
      outside a moment, every line starts from the current position.
      Example: npm run -s tutor -- show D5 E4 C6 --label "Better: D5"     (better move instead of C3)
      Example: npm run -s tutor -- show D4 E3 --start W --label "Why C3 fails"  (punishing the move)

  mark <points...> [--kind circle|triangle|square|x] [--text <label>]
      Mark points on the board (default kind circle).
      Example: npm run -s tutor -- mark E5 F5 --kind triangle --text "weak"

  clear
      Remove variations and marks. Example: npm run -s tutor -- clear

  resume
      End the pause so play continues. Example: npm run -s tutor -- resume

  new-game [--size 9|13|19] [--rank 20k] [--color B|W] [--komi 7] [--handicap N]
      Start a new game. Unset options use defaults (9x9, komi 7, human black, bot rank from profile).
      Bot ranks run from 20k to 9d (KataGo's human-style profiles).
      Example: npm run -s tutor -- new-game --size 9 --rank 18k

  problem [id]
      Start a practice problem (the next open one when no id is given).
      Example: npm run -s tutor -- problem p4

  tag <gameId> <move#> <category> [note]
      Record why a mistake happened; feeds the learner profile. Categories: life_and_death,
      capturing_race, opening, direction, shape, endgame, tactics, other.
      Example: npm run -s tutor -- tag g12 14 direction "played toward thickness"

  summary
      Learner profile: rank estimate, bot rank, mistake counts by category, recent mistakes, open problems.
      Example: npm run -s tutor -- summary

  review [gameId|last]
      A saved game's moves with point loss, best moves for mistakes, and the mistake summary (default last).
      Example: npm run -s tutor -- review last

  help
      This text.

Every command that changes something prints "ok" and a one-line status, e.g.
  ok game=g12 mode=game status=paused toPlay=B moves=14 moment m3 move 14 lost 6.2 state=tutor`;
