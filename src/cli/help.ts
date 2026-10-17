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
                 and finish with resume. A drawing you made stays up after resume: the game stays
                 paused until the learner presses Continue when ready. If you don't claim in time
                 a FALLBACK line appears: KataGo's answer is already shown; you can still add a say.
  4. on HINT:    run state, then say/show/mark. Don't give the answer outright unless asked. (The
                 learner presses Hint next to the chat input; anything they typed comes as the question.
                 Your answer marks their next move as helped, so it doesn't count for the rank estimate.)
  5. on USER:    answer with say (pass --moment <id> when the line names one).
  6. on GAME_END: review last, discuss the top 1-2 mistakes, tag categories, maybe new-game. The rank
                 estimate runs after the game; a RATING line brings the rating change a few seconds later.
  7. on PROBLEM_START / PROBLEM: the learner is on a practice problem. Let them try; after a wrong
                 first attempt ask what they see (say); after the answer is shown, explain it with show.
  8. on LEVEL:   the learner changed how much you step in (see TUTOR LEVELS); follow it from now on.

TUTOR LEVELS (the learner picks one in the UI; summary, state and GAME_START show it)
  coach      full coaching: teaching moments, say/show/mark, and rethink to take the move back.
  point_out  teaching moments as usual, but rethink is refused: explain with say/show/mark, then
             resume. The learner may still press Try again themselves.
  silent     no teaching moments and no KataGo fallback during the game. say/show/mark/rethink are
             refused while the game runs, except one say answering a USER or HINT line. Teach in the
             review after GAME_END (everything works again then), and in practice problems.
  Mistakes are evaluated and recorded the same way at every level (summary, review, problems).
  The learner can Take back their last move at any level (on their turn or in a pause); it prints
  an UNDO line like Try again.

RANK ESTIMATE AND HELP
  The rating comes from the learner's own moves: after each game of 10+ moves, KataGo's human-style
  model scores every move played without help at ranks 20k ... 9d, and the best-fitting rank is the
  game's estimate (below 20k it says "20k or weaker"). Recent games' estimates, weighted by moves,
  set the rating; wins and losses only nudge it. A move counts as helped (left out) when it came
  after an answered hint, replaced a taken-back move (Try again, Take back, your rethink), or was
  played after you drew on that position (show, mark). Taken-back first attempts are kept: their
  mistakes appear in review (marked "first try #n, taken back"), in summary and as practice problems.

COMMANDS
  watch [--since N]
      Follow the event stream. stdout carries exactly one line per event; diagnostics go to stderr.
      Reconnects by itself (resuming after the last seq) with backoff, and follows a restarted server's
      replay. --since N replays events after seq N. A replayed MOMENT shows its current state instead of
      a countdown, e.g. "(replayed; now fallback)" or "(replayed; already resolved)".
      Lines:
        GAME_START g12 9x9 komi 7 human=B bot=20k level=coach
        MOVE 15 W D6 (bot)
        MOMENT m3 game=g12 move 14 B C3 lost 6.2 pts (best D5, pv D5 E4 C6) — reply with: claim m3, ...
        MOMENT m4 ... — level point_out: explain mistakes, don't take moves back ... — reply with: ...
        LEVEL silent — no teaching moments; ... (from the learner's next move)
        HINT game=g12 B to play — user asks: "where now?" — run: state, then say/show/mark
        USER "why was that bad?" (moment m3) game=g12
        FALLBACK m3 (tutor too slow; KataGo answer shown)
        UNDO game=g12 by human: back to move 13, B to play   (Try again or Take back; the position you were discussing is gone)
        GAME_END g12 W+3.5 — 3 mistakes (1 taken back), worst move 14 (6.2), total loss 15 over 61 moves, help: 1 hint, rank estimate running (a RATING line follows) — run: review g12
        RATING g12 rank estimate 18k from 25 unassisted moves (1 hint); rating 10 -> 11.9 (+1.9, rank 18k); next bot 18k
        PROBLEM_START p4 life_and_death B to play (from g12 move 14, box 1) answers D5 — "Black to play. ..." — run: state; ...
        PROBLEM p4 attempt 1 C7 wrong, lost 5.2 (life_and_death; another attempt left) — ask what they see, ...
        PROBLEM p4 attempt 2 D5 correct (life_and_death) — best D5, pv D5 E4 C6 — say why it works
      Example: npm run -s tutor -- watch

  state
      The current board as ASCII (X black, O white, + star point, (X) last move), the move list with the
      human's point loss per move (! = mistake), KataGo's best move and candidates for the last move,
      the tutor level, the teaching moment, the overlay currently drawn, and the last chat lines.
      Example: npm run -s tutor -- state

  claim <momentId>
      Take ownership of a teaching moment; cancels the KataGo fallback timer. Do this first.
      Example: npm run -s tutor -- claim m3

  say <text> [--moment <id>]
      Post a chat message to the learner. Quote the text. On Silent, during a game, only one say
      answering the learner's latest USER or HINT line is accepted.
      Example: npm run -s tutor -- say "C3 is slow: it doesn't threaten anything. Where is the weak group?" --moment m3

  rethink <text> [--moment <id>]
      Take back the open teaching moment's move and ask the learner to try again; the game stays
      paused until they play. Only works once per moment, while its move is still the last one.
      Refused on the Point out and Silent levels.
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

      Drawings stay until the learner's next move (or Continue during a pause), until they press
      Hide (or Esc), or until you run clear.

  clear
      Remove variations and marks. Example: npm run -s tutor -- clear

  resume
      Say you're done with the teaching moment. Without a drawing on the board, play continues at
      once. With one (yours, or KataGo's fallback line), the game stays paused so the learner can
      study it: the UI tells them you're done, and they press Continue when ready (the output says
      "still paused", --json has "stillPaused": true, and state shows the moment "waiting for the
      learner to press Continue"). Example: npm run -s tutor -- resume

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

  tag <gameId> <move#> <category> [note] [--taken-back [n]]
      Record why a mistake happened; feeds the learner profile. Categories:
      ${MISTAKE_CATEGORIES.join(", ")}.
      --taken-back n tags a try at that move that was taken back, not the move that stayed on the
      board: n is the number review prints ("first try #2, taken back"). Plain --taken-back works
      when only one try was taken back there; with several it lists them.
      Example: npm run -s tutor -- tag g12 14 direction "played toward thickness"
      Example: npm run -s tutor -- tag g12 9 tactics --taken-back 2

  summary
      Learner profile: rank estimate and rating trend, the last game's move-quality estimate (from how
      many unassisted moves, and the help left out), the bot's rank (and handicap stones while the
      learner is below 20k), the tutor level, the mistake threshold, mistake counts by category with the last 3 games,
      recent mistakes (taken-back first tries marked), the recommended focus with its reason, and
      practice problems (how many, how many are due, by category, and the next few due).
      Example: npm run -s tutor -- summary

  review [gameId|last]
      Compact post-game review (default last): result, rank estimate and rating change, the help the
      learner had (hints, take-backs, rethinks, and which moves had help), each mistake (move, played,
      best, loss, category, KataGo's PV; taken-back first tries included and marked), the win-rate
      swings, the board before each of the 3 worst mistakes, and the move list (* = played with help).
      Categories marked "heuristic" are the server's guess; tag to correct.
      Example: npm run -s tutor -- review last

  help
      This text.

Every command that changes something prints "ok" and a one-line status, e.g.
  ok game=g12 mode=game status=paused level=coach toPlay=B moves=14 moment m3 move 14 lost 6.2 state=tutor`;
