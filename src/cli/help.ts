// Help text. The reader is a Claude Code session acting as the Go teacher.

import { MISTAKE_CATEGORIES } from "../shared/types.ts";

export const USAGE = `usage: npm run -s tutor -- <command> [args] [--json]
commands: watch, state, say, rethink, show, mark, clear, resume, claim, new-game, problem, problems, tag, summary, review, help
run "npm run -s tutor -- help" for details and examples`;

export const HELP = `Go Tutor CLI: you (Claude) are the teacher. The learner plays Go in a browser against KataGo;
KataGo analyzes every human move and the server pauses the game at teaching moments.

Run as: npm run -s tutor -- <command> [args]     (server: $TUTOR_SERVER, default http://localhost:4747)
Coordinates are GTP: column letters A-T without I, row 1 at the bottom (e.g. D4). Colors: B or W.
Exit codes: 0 ok, 1 server error (message on stderr), 2 usage error. Add --json to any command for raw JSON.

SESSION FLOW
  1. summary                 learner's rank, weak categories, recommended focus: decide what to do
  2. watch                   start under the Monitor tool; prints one line per event, forever
  3. on MOMENT:  claim <id> within the deadline, run state, then teach with say/show/mark/rethink,
                 and finish with resume (or let the learner press Continue). If you don't claim in time
                 a FALLBACK line appears: KataGo's answer is already shown; you can still add a say.
  4. on HINT:    run state, then say/show/mark. Don't give the answer outright unless asked.
  5. on USER:    answer with say (pass --moment <id> when the line names one).
  6. on GAME_END: review last, discuss the top 1-2 mistakes, tag categories, maybe new-game.
  7. on PROBLEM_START / PROBLEM: the learner is on a practice problem. Let them try; after a wrong
                 first attempt ask what they see (say); after the answer is shown, explain it with show.

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
        GAME_END g12 W+3.5 — 3 mistakes, worst move 14 (6.2), total loss 15 over 61 moves, rating 10 -> 10.8 — run: review g12
        PROBLEM_START p4 life_and_death B to play (from g12 move 14, box 1) answers D5 — "Black to play. ..." — run: state; ...
        PROBLEM p4 attempt 1 C7 wrong, lost 5.2 (life_and_death; another attempt left) — ask what they see, ...
        PROBLEM p4 attempt 2 D5 correct (life_and_death) — best D5, pv D5 E4 C6 — say why it works
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
      Start a new game. Unset options use defaults (9x9, komi 7, human black, bot rank from the profile;
      while the learner rates below 20k, a 9x9 game as Black also gets the profile's handicap stones
      and komi 0.5 unless --rank or --handicap is given).
      Bot ranks run from 20k to 9d (KataGo's human-style profiles).
      Example: npm run -s tutor -- new-game --size 9 --rank 18k

  problem [id]
      Put a practice problem on the learner's board (problem mode; any game waits underneath). With
      no id, the next due one: the recommended focus category first, then problems from the learner's
      own mistakes, then the built-in classics. The learner gets 2 attempts; KataGo judges each move
      (within 1 point of its best counts as correct) and shows its line when the problem is over.
      In problem mode, show and mark draw on the problem position (show starts with the learner's
      color); the learner presses Next problem or Back to playing, or you run new-game.
      Example: npm run -s tutor -- problem p4

  problems
      Every practice problem in the order "problem" picks them: id, category, source game and move
      (or built-in), Leitner box (1-5; first-try solves move up, failures go back to 1), when it is
      due, results so far, and the accepted answers.
      Example: npm run -s tutor -- problems

  tag <gameId> <move#> <category> [note]
      Record why a mistake happened; feeds the learner profile. Categories:
      ${MISTAKE_CATEGORIES.join(", ")}.
      Example: npm run -s tutor -- tag g12 14 direction "played toward thickness"

  summary
      Learner profile: rank estimate and rating trend, the bot's rank (and handicap stones while the
      learner is below 20k), the mistake threshold, mistake counts by category with the last 3 games,
      recent mistakes, the recommended focus with its reason, and practice problems (how many, how
      many are due, by category, and the next few due).
      Example: npm run -s tutor -- summary

  review [gameId|last]
      Compact post-game review (default last): result and rating change, each mistake (move, played,
      best, loss, category, KataGo's PV), the win-rate swings, the board before each of the 3 worst
      mistakes, and the move list. Categories marked "heuristic" are the server's guess; tag to correct.
      Example: npm run -s tutor -- review last

  help
      This text.

Every command that changes something prints "ok" and a one-line status, e.g.
  ok game=g12 mode=game status=paused toPlay=B moves=14 moment m3 move 14 lost 6.2 state=tutor`;
