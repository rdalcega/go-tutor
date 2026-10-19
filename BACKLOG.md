# Backlog

Features to add or change. Newest at the bottom; move an item to "Done" with its commit when it lands.

## To do


## Done

- **Review a game's mistakes as practice.** At the end of a game, add a button option for review
  that runs a short practice session only on the mistakes made in that game. (a8022b5)
- **Label the last moves in practice problems.** When a problem loads, clearly label the last 5
  moves on the board so it's easier to see what has been happening. Number them backwards: -1 is
  the last move, -2 the one before it, and so on. (a641476)
- **Show clearly when the opponent passes.** When the bot passes, nothing signals it clearly, so
  the learner can miss it. Add something that makes an opponent's pass obvious. (e2ed7ac)
- **Play a practice problem out.** After answering a problem, let the learner keep playing from it
  to see how it unfolds and why the correct move is good. Not the default: the problem screen gets
  an option to play the problem out, offered only once the problem has been answered. In that mode
  moves are not analyzed: the learner's moves are never judged and their mistakes are not recorded
  (no moments, no mistakes, no problems, no effect on the rank), and the tutor doesn't comment.
  The opponent is always KataGo at full strength, whatever the learner's level. The learner can
  step forward and back through the moves; stepping forward when it's their turn has KataGo play
  on their behalf. They can also play any move they like and see how KataGo answers. After stepping
  back and playing a different move, the moves that were ahead are thrown away (no branches).
  (5350972)
- **Play-out: the opponent always answers automatically.** In a problem's play-out, whenever it's
  the opponent's turn, KataGo should play its move by itself. Today the opponent's first move (the
  2nd move of the play-out) waits until the learner presses forward, and so do opponent moves the
  learner stepped back over when they come back to a position where it's the opponent's turn
  again. Exception: if the learner has only stepped back over the opponent's move (without also
  stepping back over their own move or playing a new one), don't replay it: they stepped back to
  look at that position. (dc4cdc1)
- **Give the tutor KataGo's view on a hint.** When the learner asks for a hint and a tutor is
  connected, the tutor gets only the board and the move list: KataGo's candidates in `state` are
  for the last move, which is the bot's and has no eval. So the tutor's nudge rests on its own
  reading of the position and can point at the wrong area. The position is already analyzed after
  each bot move (`prefetch`, cached), so the HINT line (or `state` on the learner's turn) should
  show KataGo's best move, its PV and the top candidates for the position to play. The tutor still
  nudges rather than giving the answer. (0242b67)
- **One lesson per missed point: group a run of mistakes into variants.** When a big point stays
  open while the learner plays elsewhere, each move elsewhere is a new mistake with the same
  answer, so one oversight becomes several near-identical problems. In the data on 2026-10-19, 33
  of 66 game problems were in 14 such runs (game 20261018-125442: moves 57, 59, 63, 65 and 69 all
  answer A2), and practice served p23, p24 and p25 back to back. When a game's mistakes share an
  accepted answer and the area around it hasn't changed between them, link them as variants of
  one lesson: one schedule (a solve or a miss counts for the lesson), one category (the tutor's
  tag applies to all of them; today the A2 run is tagged both life_and_death and
  capturing_race), shown once per practice set and once in Review mistakes. Each later review
  shows a different variant, so the learner practises the idea, not one memorised board. The
  review and the tutor's view should name the run ("A2 stayed the biggest point from move 57 to
  69"): not seeing what's urgent elsewhere is a lesson in its own right. Group the existing
  problems too. (1407605)
- **More variety within a practice session.** Besides the runs above: a missed problem comes back
  every 10 minutes and goes ahead of everything else (p8 was shown 6 times on the evening of
  2026-10-18); focus problems always come first, so a set is mostly one category (capturing_race
  is 22 of 66); and Review mistakes plays every one of a game's problems (17 for game
  20261018-144000). Don't show two problems from the same game or lesson back to back when
  there's something else, cap the focus category at about half of a set, and after two misses in
  a session push a problem to a later session. Keep Review mistakes in move order, one per lesson.
  (1407605)
