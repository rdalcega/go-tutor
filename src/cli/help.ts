// Help text. The reader is a Claude Code session acting as the Go teacher.

import { MISTAKE_CATEGORIES } from "../shared/types.ts";

export const USAGE = `usage: npm run -s tutor -- <command> [args] [--json]
commands: watch, state, say, rethink, show, mark, clear, resume, claim, new-game, problem, problems, generate, tag, summary, review, help
run "npm run -s tutor -- help" for details and examples`;

export const HELP = `Go Tutor CLI: you (Claude) are the teacher. The learner plays Go in a browser against KataGo;
KataGo analyzes every human move and the server pauses the game at teaching moments: moves that
lose at least the mistake threshold. The profile keeps it for 9×9 (4 points to start, adapting
between 2 and 6); bigger boards scale it (×1.5 on 13×13, ×2 on 19×19: 4 / 6 / 8 at the start).

Run as: npm run -s tutor -- <command> [args]     (server: $TUTOR_SERVER, default http://localhost:4747)
Coordinates are GTP: column letters A-T without I, row 1 at the bottom (e.g. D4). Colors: B or W.
Exit codes: 0 ok, 1 server error (message on stderr), 2 usage error. Add --json to any command for raw JSON.

SESSION FLOW
  1. summary [--wait]        learner's rank, weak categories, recommended focus: decide what to do
                             (--wait: right after npm start, waits for the server instead of failing)
  2. watch                   start under the Monitor tool; prints each event you act on, forever.
                 MOMENT, HINT, PROBLEM_START and a USER line during a game come with the state
                 under them, GAME_END with the review: don't run state or review again.
                 Chain one answer's commands with &&.
  3. on MOMENT:  read the state below the line, then answer in one call that starts with the
                 claim: claim <id> && show ... && say ... && resume (the claim fails if the moment is
                 gone, which stops the chain). Once watch has delivered it you have 75 s.
                 A drawing you made stays up after resume: the game stays
                 paused until the learner presses Continue when ready. If you don't answer in time
                 a FALLBACK line comes with your next event: KataGo's answer is already shown.
  4. on HINT:    read the state below the line, then say/show/mark. Don't give the answer outright unless asked. (The
                 learner presses Hint next to the chat input; anything they typed comes as the question.
                 Your answer marks their next move as helped, so it doesn't count for the rank estimate.)
  5. on USER:    answer with say (pass --moment <id> when the line names one).
  6. on GAME_END: read the review below the line, discuss the top 1-2 mistakes, tag categories, then
                 offer a review of the game's mistakes as problems (problem --game <id>) or new-game.
                 The server waits up to 15 s for the rank estimate, so the RATING line usually comes
                 with GAME_END; a slower one follows on its own.
  7. on PROBLEM_START / PROBLEM: the learner is on a practice problem. Let them try; after a wrong
                 first attempt ask what they see (say); after the answer is shown, explain it with show.
                 "review g12 2/4" on the line: the 2nd of 4 problems in a review of game g12's mistakes;
                 the learner's Next goes on through it, and after the last it ends.
                 Once answered, the learner may play the problem out against KataGo (unjudged, not in
                 the stream): show/mark are refused, and one say answers their chat (or the result
                 you hadn't answered yet when they started).
  8. on BATCH:   a batch of generated practice problems finished (see GENERATED PROBLEMS); mention
                 it when it fits, not in the middle of a game on Silent.
  GAME_START, PROBLEM_START, BATCH finished and FALLBACK need no answer of their own: watch prints
  them at the top of the next event you answer (a PROBLEM_START with the learner's first attempt).
  Not in the stream (watch --all prints them): moves, tutor level and judge changes (USER lines in
  a game carry level=..., and state shows both), batch starts, and take-backs (UNDO), except the
  learner's take-back of a MOMENT's or HINT's position and their move made before your hint answer
  ("MOVE ... — played before your hint answer: that position is gone").

GENERATED PROBLEMS
  Besides the problems from the learner's own mistakes, the server generates problems in the
  background: KataGo plays itself with its human-style net (the weaker side at the learner's rank,
  the other 5 ranks stronger), and the weaker side's big, clear, local mistakes become one-move
  problems, always Black to play (colors swapped when the mistake was White's), on 9x9, 13x13 and
  19x19. Each has a difficulty: the rank at which KataGo's human-style policy finds an answer half
  the time ("difficulty 14k"; often stronger than the learner, since these are moves a weaker player
  misses). They come in batches of 20 (7/7/6 by size) and join practice as they're found; the first
  batch is 20k vs 15k, and the next starts when the learner has mastered 15 of the newest batch
  (Leitner box 3+: solved on the first try twice). Generation pauses while the learner plays.
  generate shows progress; generate --now starts the next batch early.

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

JUDGING (the learner picks it in the UI; summary and state show a "judge <mode>" line, GAME_START judge=<mode>)
  optimal    a move's score is what it loses against KataGo's best move (the default).
  at_level   a move's score is what it loses against the reference move: the human-style model's
             most likely move one rank above the learner (ref=17k, fixed for the game), both valued
             by KataGo. Only that score opens teaching moments, so they are rarer; the MOMENT line
             names the reference move and its line, and KataGo's fallback shows that line.
  Either way, the review, mistakes, tags and practice problems use the loss against KataGo's best.

RANK ESTIMATE AND HELP
  The rating comes from the learner's own moves: after each game of 10+ moves, KataGo's human-style
  model scores every move played without help at ranks 20k ... 9d, and the best-fitting rank is the
  game's estimate (below 20k it says "20k or weaker"). Recent games' estimates, weighted by moves,
  set the rating; wins and losses only nudge it. A move counts as helped (left out) when it came
  after an answered hint, replaced a taken-back move (Try again, Take back, your rethink), or was
  played after you drew on that position (show, mark). Taken-back first attempts are kept: their
  mistakes appear in review (marked "first try #n, taken back"), in summary and as practice problems.

COMMANDS
  watch [--since N] [--all]
      Follow the event stream. stdout carries the events you act on; what arrives together goes out
      in one write (one notification). A waiting MOMENT, a HINT or a PROBLEM_START comes with the
      state printed under it, a GAME_END with the review (the server sends it with its RATING line
      when the rank estimate takes under 15 s). Diagnostics go to stderr. A watch started without
      --since within 10 minutes of the last one closing first gets what that one missed.
      --all prints every event as one bare line (moves, UNDO, LEVEL, JUDGE, BATCH started too);
      --json prints every event as raw JSON.
      Reconnects by itself (resuming after the last seq) with backoff, and follows a restarted server's
      replay. --since N replays events after seq N. A replayed MOMENT shows its current state instead of
      a countdown, e.g. "(replayed; now fallback)" or "(replayed; already resolved)".
      Lines:
        GAME_START g12 9x9 komi 7 human=B bot=20k level=coach judge=optimal
        MOVE 15 W D6 (bot)   (--all only)
        MOMENT m3 game=g12 move 14 B C3 lost 6.2 pts (best D5, pv D5 E4 C6) — answer in one call: claim m3 && show/say/rethink (&& resume); fallback in 75s — state below
        MOMENT m4 ... — level point_out: explain mistakes, don't take moves back ... — answer in one call: ...
        MOMENT m5 game=g12 move 20 B G2 lost 4.4 pts (judged at level: vs the 17k move F3, pv F3 G4; vs KataGo's best E3 it lost 7.1) — ...
        LEVEL silent — no teaching moments; ... (from the learner's next move)   (--all only)
        JUDGE judge=at_level ref=17k — moves are scored, and moments opened, against ... (from the learner's next move)   (--all only)
        HINT game=g12 B to play — user asks: "where now?" — state below; answer with say/show/mark
        USER "why was that bad?" (moment m3) game=g12 level=coach — state below   (state while the game is in play)
        FALLBACK m3 (tutor too slow; KataGo answer shown)
        UNDO game=g12 by human: back to move 13, B to play   (with a MOMENT or HINT open, or --all)
        GAME_END g12 W+3.5 — 3 mistakes (1 taken back), worst move 14 (6.2), total loss 15 over 61 moves, help: 1 hint, rank estimate running (a RATING line follows) — review below
        RATING g12 rank estimate 18k from 25 unassisted moves (1 hint); rating 10 -> 11.9 (+1.9, rank 18k); next bot 18k
        PROBLEM_START p4 life_and_death B to play (from g12 move 14, box 1) answers D5 — "Black to play. ..." — state below; ...
        PROBLEM_START p5 shape B to play (from g12 move 20, box 1, review g12 2/3) answers E4 — ...
        PROBLEM_START gen7 tactics B to play (generated 13x13, difficulty 14k, batch1, box 1) answers K4 — ...
        PROBLEM p4 attempt 1 C7 wrong, lost 5.2 (life_and_death; another attempt left) — ask what they see, ...
        PROBLEM p4 attempt 2 D5 correct (life_and_death) — best D5, pv D5 E4 C6 — say why it works
        BATCH batch2 started (mastery): 20 problems from 17k vs 12k self-play, difficulty band 17k–13k; ...   (--all only)
        BATCH batch2 finished: 20 new problems (7 on 9x9, 6 on 13x13, 7 on 19x19), difficulty band 17k–13k — ...
      Example: npm run -s tutor -- watch

  state
      The current board as ASCII (X black, O white, + star point, (X) last move), the move list with the
      human's point loss per move (! = mistake), KataGo's best move and candidates for the last move,
      the tutor level, the mistake threshold on this board, the teaching moment, the overlay currently
      drawn, and the last chat lines.
      Example: npm run -s tutor -- state

  claim <momentId>
      Take ownership of a teaching moment; cancels the KataGo fallback timer. Start your answer's
      chained call with it (claim m3 && show ... && say ... && resume): it fails when the moment is
      no longer current, so the rest doesn't run on the wrong board.
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

  problem [id] [--game <gameId|last>]
      Put a practice problem on the learner's board (problem mode; any game waits underneath). With
      no id, the next due one: the recommended focus category first, then problems from the learner's
      own mistakes, then generated ones. The learner gets 2 attempts; KataGo judges each move
      (within 1 point of its best counts as correct) and shows its line when the problem is over.
      In problem mode, show and mark draw on the problem position (show starts with the learner's
      color); the learner presses Next problem or Back to playing, or you run new-game.
      --game: review a finished game's mistakes instead (the learner's Review mistakes button): its
      problems in move order, each once, due or not; Next goes through them, and after the last (or
      Back to playing) the review ends. Results are scheduled like any attempt.
      Example: npm run -s tutor -- problem p4
      Example: npm run -s tutor -- problem --game last

  problems
      Every practice problem in the order "problem" picks them: id, category, source game and move
      (or "generated 13x13, difficulty 14k, batch1"), Leitner box (1-5; first-try solves move up,
      failures go back to 1), when it is due, results so far, and the accepted answers.
      Example: npm run -s tutor -- problems

  generate [--status | --now]
      Problem generation: the batch in progress (found/target per board size, whether it is running
      or paused while the learner plays), the last finished batch and how many of its problems are
      mastered (15 start the next batch), and KataGo minutes per size. --now starts the next batch
      first, even if the trigger hasn't fired (refused while one is running): at the learner's rank,
      except the very first batch, which is always 20k vs 15k.
      Example: npm run -s tutor -- generate --status

  tag <gameId> <move#> <category> [note] [--taken-back [n]]
      Record why a mistake happened; feeds the learner profile. Categories:
      ${MISTAKE_CATEGORIES.join(", ")}.
      --taken-back n tags a try at that move that was taken back, not the move that stayed on the
      board: n is the number review prints ("first try #2, taken back"). Plain --taken-back works
      when only one try was taken back there; with several it lists them.
      Example: npm run -s tutor -- tag g12 14 direction "played toward thickness"
      Example: npm run -s tutor -- tag g12 9 tactics --taken-back 2

  summary [--wait]
      With --wait it first waits (up to 100 s) for a server that is still starting. Learner profile: rank estimate and rating trend, the last game's move-quality estimate (from how
      many unassisted moves, and the help left out), the bot's rank (and handicap stones while the
      learner is below 20k), the tutor level, the mistake threshold on each board size and its last
      change, mistake counts by category with the last 3 games,
      recent mistakes (taken-back first tries marked), the recommended focus with its reason, and
      practice problems (how many, from games and generated, problem generation's progress, how many
      are due, by category, and the next few due).
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
  ok game=g12 mode=game status=paused level=coach threshold=4 toPlay=B moves=14 moment m3 move 14 lost 6.2 state=tutor
(threshold = the mistake threshold in points on this game's board).`;
