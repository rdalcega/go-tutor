// How a learner's move is judged for the score they see and for teaching moments (JudgeMode in
// types.ts). Shared by the server, the tutor CLI and the browser.

import type { AtLevelEval, MoveRecord } from "./types.ts";

/** The move's at-level eval, when it was played on "at_level" and that eval arrived. */
export function atLevelOf(record: Pick<MoveRecord, "eval" | "judge">): AtLevelEval | undefined {
  return record.judge === "at_level" ? record.eval?.atLevel : undefined;
}

/**
 * The points the move is judged to have lost, clamped at >= 0: against the reference move when it
 * was played on "at_level" (`atLevelOf`), else against KataGo's best (`pointLoss`). Undefined
 * without an eval.
 */
export function judgedLoss(record: Pick<MoveRecord, "eval" | "judge">): number | undefined {
  const at = atLevelOf(record);
  return at ? Math.max(0, at.loss) : record.eval?.pointLoss;
}
