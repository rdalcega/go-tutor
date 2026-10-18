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
