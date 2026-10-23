// Shared contract between the rules engine, the server, the browser UI and the tutor CLI.
// Change this file deliberately: every part of the app builds against it.

/** Board stone colors. "B" moves first. */
export type Color = "B" | "W";

/** A point on the board, 0-based. x is the column (left→right), y is the row (top→bottom). */
export interface Point {
  x: number;
  y: number;
}

/** A move is a point or a pass. */
export type Move = { color: Color; point: Point } | { color: Color; pass: true };

/** Row-major board contents: board[y][x]. */
export type Cell = Color | null;
export type Board = Cell[][];

/** KataGo-style coordinate, e.g. "D4" (columns skip "I", row 1 is the bottom). "pass" for a pass. */
export type Gtp = string;

export interface MoveRecord {
  /** 1-based move number. */
  number: number;
  move: Move;
  /** Stones captured by this move. */
  captures: Point[];
  /** Filled in once KataGo has analyzed the position after this move. */
  eval?: MoveEval;
  /**
   * The learner's tutor level when they played this move (human moves only; absent in games saved
   * before levels existed, which meant coach). It decides whether the move can open a teaching moment.
   */
  tutorLevel?: TutorLevel;
  /**
   * How the learner chose to have this move judged when they played it (human moves only; absent =
   * "optimal"). It decides the score the learner sees and whether the move opens a teaching moment.
   */
  judge?: JudgeMode;
  /**
   * Help the learner had for this move (human moves only; absent = none). Assisted moves don't count
   * for the rank estimate.
   */
  assist?: AssistKind[];
}

/**
 * Kinds of help for one human move: "hint" = played after a hint for that position was answered
 * (by the tutor or KataGo); "retry" = replaces a move the learner took back (Try again, Take back);
 * "rethink" = replaces a move the tutor took back; "shown" = played after the tutor drew on that
 * position (show or mark) or a hint circled a point there, even if the learner hid the drawing;
 * "asked" = played after the tutor answered the learner's chat question (asked in that position, or
 * on the bot's turn just before it).
 */
export const ASSIST_KINDS = ["hint", "asked", "retry", "rethink", "shown"] as const;
export type AssistKind = (typeof ASSIST_KINDS)[number];

/** A human move that was taken back, kept in the game record with its eval (its first attempt). */
export interface TakenBackMove {
  /** The move's number; its replacement, if one was played, has the same number. */
  moveNumber: number;
  /** The move as played, with its eval (when it arrived before the take-back), level and help. */
  record: MoveRecord;
  /** "human" = the learner's Try again or Take back; "tutor" = the tutor's rethink. */
  by: "human" | "tutor";
  ts: number;
  /** The moves before it in GTP, colors alternating from the game's first mover: its position, which later take-backs can change. */
  before: Gtp[];
  /** Heuristic category, when it was a mistake. */
  heuristic?: MistakeCategory;
  /** The tutor's tag. */
  tag?: { category: MistakeCategory; note?: string };
}

/** Help the learner had in one game: hint requests, chat questions the tutor answered, their own take-backs, and the tutor's rethinks. */
export interface AssistCounts {
  hints: number;
  /** Absent in games saved before answered questions counted as help. */
  questions?: number;
  takeBacks: number;
  rethinks: number;
}

/** A game's rank estimate from the likelihood of the learner's unassisted moves under KataGo's human-SL model. */
export interface RankEstimate extends AssistCounts {
  /** On the rank scale (20k = 10), interpolated between the human-SL profiles, never below 10. */
  rating: number;
  /** The fit is at the weakest profile: "20k or weaker" (the model goes no lower). */
  floor: boolean;
  /** Unassisted human moves it was measured on (taken-back first attempts included). */
  moves: number;
}

/** KataGo's verdict on one played move, always from the mover's perspective. */
export interface MoveEval {
  /** Expected score lead for the mover before the move (if best play followed). */
  leadBefore: number;
  /** Expected score lead for the mover after the move actually played. */
  leadAfter: number;
  /** leadBefore - leadAfter, clamped at >= 0. Points this move cost. */
  pointLoss: number;
  /** Mover's win rate (0..1) before and after. */
  winrateBefore: number;
  winrateAfter: number;
  /** KataGo's preferred move in the position before, and its principal variation. */
  bestMove: Gtp;
  bestPv: Gtp[];
  /** Up to 5 candidate moves KataGo considered in the position before. */
  candidates: { move: Gtp; lead: number; winrate: number; visits: number; pv: Gtp[] }[];
  /** The move judged "at level": against the human-SL net's top move one rank above the learner. */
  atLevel?: AtLevelEval;
}

/**
 * A move compared with the reference move: the human-SL net's most likely move at `rank` (one rank
 * above the learner, fixed for the game), both valued by KataGo's main net.
 */
export interface AtLevelEval {
  /** The reference rank, e.g. "17k". */
  rank: string;
  /** The reference move and KataGo's line after it (starting with the move). */
  move: Gtp;
  pv: Gtp[];
  /**
   * Points the played move is worse than the reference move: negative when it is better (a gain).
   * Never above `MoveEval.pointLoss` (the reference is no better than KataGo's best).
   */
  loss: number;
}

export type GameStatus = "playing" | "paused" | "finished";

/** The board sizes the app plays on, smallest first. */
export const BOARD_SIZES = [9, 13, 19] as const;
export type BoardSize = (typeof BOARD_SIZES)[number];

export function isBoardSize(n: number): n is BoardSize {
  return (BOARD_SIZES as readonly number[]).includes(n);
}

export interface GameSettings {
  size: BoardSize;
  komi: number;
  /** Which color the human plays. */
  humanColor: Color;
  /** KataGo human-SL profile rank for the bot, e.g. "20k", "5k", "1d". */
  botRank: string;
  /** Handicap stones for black (0 = none). */
  handicap: number;
}

export interface GameResult {
  winner: Color | null;
  /** Black score minus white score (area scoring, komi included). */
  margin: number;
  reason: "score" | "resign" | "abandon";
}

/** What the tutor (or the KataGo fallback) is currently showing about a teaching moment. */
export interface TeachingMoment {
  id: string;
  /** Move number of the human move that triggered it. */
  moveNumber: number;
  /** The loss that opened it: `judgedLoss` of the move (against the reference move when judged at level). */
  pointLoss: number;
  /** "waiting" = paused, waiting for the tutor; "tutor" = tutor has engaged; "fallback" = tutor timed out or absent, KataGo answer shown. */
  state: "waiting" | "tutor" | "fallback" | "resolved";
  /** Absolute ms epoch when the fallback kicks in, while state === "waiting". */
  deadline?: number;
  /**
   * The tutor sent `resume` while a drawing was on the board: the game stays paused with the
   * drawing until the learner presses Continue (or Try again). Only with state "tutor".
   */
  awaitingLearner?: boolean;
  /** The tutor level the moment's move was played at (absent before levels existed: coach). */
  level?: TutorLevel;
}

/** Overlays the board UI draws on top of the stones. */
export interface Overlay {
  /**
   * Ghost stones for a variation, numbered in order. With `fromMove`, the line starts from the
   * position before move `fromMove` (e.g. KataGo's better move instead of a mistake), and the UI
   * draws it on that earlier board instead of the current one. Without it, it starts from now.
   */
  variation?: { label?: string; moves: { color: Color; point: Point }[]; fromMove?: number };
  /** Marked points (e.g. "the better move", "this group is weak"). */
  marks?: { point: Point; kind: MarkKind | "label"; text?: string }[];
  /** KataGo's preferred move, highlighted (part of its fallback answer to a teaching moment). */
  best?: Point;
}

/**
 * How much the tutor steps in during games (the learner's choice, kept in the profile):
 * "silent" = no pauses or comments during a game (hints and questions still answered, review after);
 * "point_out" = pauses at mistakes and explains, but never takes a move back;
 * "coach" = everything, including taking a move back for another try.
 */
export const TUTOR_LEVELS = ["silent", "point_out", "coach"] as const;
export type TutorLevel = (typeof TUTOR_LEVELS)[number];

/**
 * How a learner's move is judged for the score they see and for teaching moments (the learner's
 * choice, kept in the profile): "optimal" = against KataGo's best move; "at_level" = against the
 * move a player one rank above them would most likely play (`AtLevelEval`). Mistakes for the review,
 * practice problems and the profile are always judged against KataGo's best.
 */
export const JUDGE_MODES = ["optimal", "at_level"] as const;
export type JudgeMode = (typeof JUDGE_MODES)[number];

/** Marks the tutor can draw with `mark` (the UI also draws "label" marks). */
export const MARK_KINDS = ["circle", "triangle", "square", "x"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

export interface ChatMessage {
  id: string;
  ts: number;
  from: "tutor" | "user" | "system";
  text: string;
  /** Optional link to the teaching moment it belongs to. */
  momentId?: string;
}

/** The full state the browser renders. Served by GET /api/state and pushed over SSE. */
export interface GameView {
  gameId: string | null;
  mode: "idle" | "game" | "problem";
  settings: GameSettings | null;
  status: GameStatus;
  board: Board;
  toPlay: Color;
  moves: MoveRecord[];
  captures: { B: number; W: number };
  result: GameResult | null;
  moment: TeachingMoment | null;
  overlay: Overlay | null;
  chat: ChatMessage[];
  /** True while a tutor session holds an open `tutor watch` connection. */
  tutorAttached: boolean;
  /** How much the tutor steps in during games (the profile's setting). */
  tutorLevel: TutorLevel;
  /** How the learner's moves are judged (the profile's setting). */
  judgeMode: JudgeMode;
  /** The game's reference rank for "at_level" judging (one rank above the learner when it started). */
  atLevelRank?: string;
  /** True while KataGo is thinking (bot move or analysis). */
  engineBusy: boolean;
  /** Present in problem mode. */
  problem?: ProblemView | null;
  /** Bumped whenever the learner profile changes (a game or problem ends, a tag): refetch GET /api/profile. */
  profileVersion: number;
  /** The browser actions the server accepts right now (the same checks POST /api/action enforces). */
  allowed: ClientAction["type"][];
  /**
   * The mistake threshold in points for this view: a game's (`thresholdFor` of the profile's 9×9
   * threshold on its board), a finished game's own (`playedThreshold`), and in idle or problem mode
   * the current game's or else the next 9×9 game's.
   */
  mistakeThreshold: number;
  /** A finished game's summary (its mistakes worst first, as the server counted them); absent otherwise. */
  summary?: GameSummary;
  /** A finished game's practice problems (made from its mistakes in the background), which `review_game` goes through; absent otherwise. */
  reviewProblems?: number;
  /** Problem generation: the batch in progress and the newest finished one. */
  generation?: GenerationStatus;
  /**
   * Practice is closed until then (ms epoch): the learner missed PRACTICE_MISS_LIMIT problems in it.
   * Absent while practice is open. Reviews of a game's mistakes aren't affected.
   */
  practiceClosedUntil?: number;
  /**
   * Tutor only (GET /api/state?tutor=1, what `tutor state` and `watch` fetch; never in the
   * learner's view): KataGo's analysis of the position the learner is to play in a game.
   */
  toPlayAnalysis?: ToPlayAnalysis;
}

/**
 * How long the tutor's `state` waits for the analysis of the position the learner is to play
 * (prefetched after the bot's move, so usually ready); `watch` allows a second more for the state under an event.
 */
export const TO_PLAY_WAIT_MS = 2_000;

/**
 * KataGo's view of the position the learner is to play (the cached analysis prefetched after the
 * bot's move), from the learner's perspective; `pending` when it was still running after a short wait.
 */
export type ToPlayAnalysis =
  | { pending: true }
  | {
      pending?: undefined;
      lead: number;
      winrate: number;
      bestMove: Gtp;
      bestPv: Gtp[];
      /** Up to 5 candidates, best first, as in `MoveEval.candidates`. */
      candidates: MoveEval["candidates"];
      /** On at_level judging: the human-SL net's most likely move one rank above the learner. */
      reference?: { rank: string; move: Gtp };
    };

/** POST /api/action and POST /api/tutor. */
export interface ActionResponse {
  ok: boolean;
  view?: GameView;
  error?: string;
}

export interface ProblemView {
  id: string;
  prompt: string;
  /** Source game and move, when built from the user's own mistake. */
  source?: { gameId: string; moveNumber: number };
  /** Where a generated problem comes from (kind "generated"). */
  generated?: GeneratedProblemInfo;
  attempts: number;
  solved: boolean;
  kind: ProblemKind;
  category: MistakeCategory;
  /** The learner's color in this problem (the side to move). */
  toPlay: Color;
  /** Attempts allowed before the answer is shown. */
  maxAttempts: number;
  /** True once the problem is over: solved, or out of attempts (the answer is then on the board). */
  revealed: boolean;
  /** Spaced-repetition box (1–5) the problem was in when it started. */
  box: number;
  /** The latest attempt as KataGo judged it. */
  lastAttempt?: ProblemAttempt;
  /** KataGo's best move and its line, once the problem is over. */
  answer?: { move: Gtp; pv: Gtp[] };
  /** When the problem is due again (ms epoch), once its result is recorded (spaced repetition). */
  nextDue?: number;
  /**
   * The last moves before the position (up to RECENT_MOVES, passes left out) whose stones are still
   * on the board, oldest first: `ago` 1 is the last move. Absent when the problem doesn't know them.
   */
  recentMoves?: RecentMove[];
  /** Part of a review of one game's mistakes: this is problem `index` (1-based) of `total`. */
  review?: ProblemReview;
  /** One variant of a lesson: a run of mistakes that missed the same point. */
  lesson?: LessonInfo;
  /** The learner is playing the answered problem out against KataGo (absent otherwise). */
  playout?: PlayoutView;
}

/**
 * Playing an answered problem out against full-strength KataGo: nothing is judged or recorded. The
 * view's board, side to move and `moves` are the play-out's position at `cursor`.
 */
export interface PlayoutView {
  /** The whole line from the problem position, the learner first, moves ahead of the cursor included. */
  line: Gtp[];
  /** How many moves of `line` are on the board (0: the problem position). */
  cursor: number;
  /** KataGo is choosing a move. */
  thinking: boolean;
  /** Both sides passed at the cursor: only stepping back is left. */
  over: boolean;
  /** The tutor still owes the learner a reply (to the result, or to their chat): one say. */
  replyOwed?: boolean;
}

/** How many of the moves before a problem's position it labels on the board (-1 … -5). */
export const RECENT_MOVES = 5;

/** A stone of one of the last moves before a problem's position: `ago` 1 is the last move, 2 the one before, … */
export interface RecentMove {
  color: Color;
  point: Point;
  ago: number;
}

/**
 * A practice problem that is one variant of a lesson: a run of mistakes in one game that all
 * missed `answer` (MistakeRun). The variants share one schedule and one category.
 */
export interface LessonInfo {
  /** The lesson's id: its first variant's problem id. */
  id: string;
  /** This problem's place among the variants (1-based, move order) and how many there are. */
  variant: number;
  variants: number;
  gameId: string;
  /** The point that stayed open (left out of the problem's view until it is answered), and the moves of the first and last mistake of the run. */
  answer?: Gtp;
  fromMove: number;
  toMove: number;
}

/** Where a problem stands in a review of one game's mistakes (its problems in move order, each once). */
export interface ProblemReview {
  gameId: string;
  /** 1-based. */
  index: number;
  total: number;
}

export interface ProblemAttempt {
  move: Gtp;
  correct: boolean;
  /** Points the move loses against KataGo's best, when KataGo checked it (null when it was a known answer and KataGo wasn't asked). */
  pointLoss: number | null;
}

// ---------------------------------------------------------------------------
// Browser → server (HTTP JSON)
// ---------------------------------------------------------------------------

export type ClientAction =
  | { type: "new_game"; settings?: Partial<GameSettings> }
  | { type: "play"; point: Point }
  | { type: "pass" }
  | { type: "resign" }
  | { type: "continue" } // dismiss a paused teaching moment and keep playing
  | { type: "retry" } // the moment banner's Try again: take back the last human move (and bot reply)
  | { type: "take_back" } // the controls' Take back: the same, any time on the learner's turn or in a pause
  | { type: "chat"; text: string }
  | { type: "ask_tutor"; text?: string } // explicit "hint please" button
  | { type: "next_problem" } // enter problem mode, or go on to the next problem
  | { type: "leave_problem" } // back to the game (or the idle board); ends a review
  | { type: "review_game"; gameId: string } // a review of a finished game's mistakes: its problems in move order, each once
  | { type: "clear_overlay" } // hide the drawing on the board (the tutor's, KataGo's or a hint)
  | { type: "set_tutor_level"; level: TutorLevel } // applies from the learner's next move
  | { type: "set_judge_mode"; mode: JudgeMode } // applies from the learner's next move
  | { type: "playout_start" } // after answering a problem: play it out against full-strength KataGo, unjudged
  | { type: "playout_back" } // step one move back through the play-out
  | { type: "playout_forward" } // step one move forward; at the end of the line KataGo plays the side to move
  | { type: "playout_exit" }; // back to the answered problem

// ---------------------------------------------------------------------------
// Tutor → server (the `tutor` CLI posts these to POST /api/tutor)
// ---------------------------------------------------------------------------

export type TutorCommand =
  | { type: "say"; text: string; momentId?: string }
  /** Undo the human's last move and ask them to think again. Keeps the game paused until they play. */
  | { type: "rethink"; text: string; momentId?: string }
  /** Draw a variation as numbered ghost stones. Moves alternate starting with `start` (default: the mover of the moment). */
  | { type: "show"; moves: Gtp[]; start?: Color; label?: string }
  | { type: "mark"; points: Gtp[]; kind?: MarkKind; text?: string }
  | { type: "clear" }
  /**
   * End the pause and let play continue. With a drawing on the board the pause stays, waiting for
   * the learner's Continue (the moment gets `awaitingLearner`), so the drawing isn't wiped at once.
   */
  | { type: "resume" }
  /** Tutor took ownership of the current moment; cancels the fallback timer. */
  | { type: "claim"; momentId: string }
  | { type: "new_game"; settings?: Partial<GameSettings> }
  /** A problem by id, the next due one, or with `gameId` (or "last") a review of that game's mistakes. */
  | { type: "start_problem"; problemId?: string; gameId?: string }
  /** Start the next batch of generated problems now, even if the mastery trigger hasn't fired. */
  | { type: "generate" }
  /**
   * `takenBack`: a taken-back first attempt at that move number, not the move that stayed on the
   * board: a number is the try's number there (review's "first try #2"), `true` the only one.
   */
  | { type: "tag"; gameId: string; moveNumber: number; category: MistakeCategory; note?: string; takenBack?: boolean | number };

// ---------------------------------------------------------------------------
// Server → tutor event stream (GET /api/tutor/events, SSE; one JSON object per event)
// ---------------------------------------------------------------------------

export type TutorEvent =
  | { seq: number; ts: number; type: "game_start"; gameId: string; settings: GameSettings; tutorLevel?: TutorLevel; judgeMode?: JudgeMode; atLevelRank?: string }
  | {
      seq: number;
      ts: number;
      type: "move";
      gameId: string;
      size: number;
      record: MoveRecord;
      by: "human" | "bot";
      /** The learner played before the tutor answered their hint request: the position the tutor may be answering about is gone. */
      hintPending?: true;
    }
  | {
      seq: number;
      ts: number;
      type: "teaching_moment";
      gameId: string;
      /** Board size, for naming the record's point in GTP. */
      size: number;
      /** "waiting" when live. A replay (reconnect, fresh watch) carries the moment's state at replay time. */
      moment: TeachingMoment;
      record: MoveRecord;
      /** ASCII rendering of the position BEFORE the human's move, for the tutor to read. */
      boardBefore: string;
      /** ASCII rendering AFTER the move. */
      boardAfter: string;
      /** The learner's tutor level (absent in events logged before levels existed, which meant coach). */
      tutorLevel?: TutorLevel;
    }
  /** The learner changed the tutor level; it applies from their next move. */
  | { seq: number; ts: number; type: "tutor_level"; level: TutorLevel; gameId: string | null }
  /** The learner changed how their moves are judged; it applies from their next move. */
  | { seq: number; ts: number; type: "judge_mode"; mode: JudgeMode; gameId: string | null; atLevelRank?: string }
  /** `problemId` is set when the learner wrote while a practice problem was on the board (the message is about it). */
  | {
      seq: number;
      ts: number;
      type: "user_message";
      text: string;
      momentId?: string;
      gameId: string | null;
      problemId?: string;
      /** Sent while the learner plays the problem out against KataGo (unjudged; the tutor only answers the message). */
      playout?: boolean;
      /** The learner's tutor level, on a message about a game (absent on a problem, and in events logged before it was sent). */
      tutorLevel?: TutorLevel;
    }
  | {
      seq: number;
      ts: number;
      type: "hint_request";
      text?: string;
      gameId: string;
      size: number;
      board: string;
      toPlay: Color;
      /** The learner's tutor level (absent in events logged before it was sent). */
      tutorLevel?: TutorLevel;
    }
  | { seq: number; ts: number; type: "fallback"; momentId: string }
  /** Moves were taken back (browser Try again, or the tutor's rethink). `moves` is how many remain. */
  | {
      seq: number;
      ts: number;
      type: "undo";
      gameId: string;
      moves: number;
      toPlay: Color;
      by: "human" | "tutor";
      /** The take-back undid the position of an open teaching moment, or of a hint request the tutor may be answering. */
      during?: "moment" | "hint";
    }
  /** `summary.rating` is `pending` while the rank estimate runs; a `rating` event follows. */
  | { seq: number; ts: number; type: "game_end"; gameId: string; result: GameResult; summary: GameSummary }
  /** The finished game's rank estimate is in and the rating updated. */
  | { seq: number; ts: number; type: "rating"; gameId: string; rating: RatingChange }
  /** A batch of generated problems started or finished. */
  | { seq: number; ts: number; type: "generation"; status: "started" | "finished"; batch: GenerationBatchStatus }
  /** A practice problem is on the board. `answers` are the accepted moves (for the tutor; the learner doesn't see them). */
  | {
      seq: number;
      ts: number;
      type: "problem_start";
      problemId: string;
      kind: ProblemKind;
      category: MistakeCategory;
      toPlay: Color;
      prompt: string;
      answers: Gtp[];
      box: number;
      source?: { gameId: string; moveNumber: number };
      /** Board size (absent in events logged before generated problems, which were all 9×9). */
      size?: number;
      generated?: GeneratedProblemInfo;
      /** Part of a review of one game's mistakes. */
      review?: ProblemReview;
      /** One variant of a lesson: a run of mistakes that missed the same point. */
      lesson?: LessonInfo;
      /** ASCII rendering of the problem position. */
      board: string;
    }
  | {
      seq: number;
      ts: number;
      type: "problem_attempt";
      problemId: string;
      move: Gtp;
      correct: boolean;
      category: MistakeCategory;
      /** 1-based attempt number within this showing of the problem. */
      attempt: number;
      /** Solved on the first attempt. */
      firstTry: boolean;
      pointLoss: number | null;
      /** The problem is over (solved or out of attempts) and KataGo's answer is on the board. */
      revealed: boolean;
      bestMove: Gtp;
      bestPv: Gtp[];
      /** This result left practice closed until then (ms epoch): the learner has missed enough problems for now. */
      practiceClosedUntil?: number;
    };

export interface GameSummary {
  moves: number;
  /**
   * The mistake threshold the game was played with, in points on its board (the profile's 9×9
   * threshold scaled by `thresholdFor`). Absent on games saved before thresholds scaled by size.
   */
  threshold?: number;
  /** Human moves with pointLoss >= `threshold`, worst first, taken-back first attempts included. */
  mistakes: {
    moveNumber: number;
    move: Gtp;
    pointLoss: number;
    bestMove: Gtp;
    category?: MistakeCategory;
    /** Who chose the category: the tutor's `tag` (always wins) or the server's heuristic at game end. */
    categorySource?: "tutor" | "heuristic";
    /** A taken-back move: its index in `SavedGame.takenBack`. */
    takenBack?: number;
  }[];
  /**
   * Runs of mistakes with the same answer (src/server/lessons.ts): one point stayed the biggest while
   * the learner played elsewhere. Each run is one lesson. Absent on games saved before runs.
   */
  runs?: MistakeRun[];
  /** Points lost by every evaluated human move, taken-back ones included. */
  totalPointLoss: number;
  /** Help the learner had in the game. */
  assistance?: AssistCounts;
  /** How the game moved the learner's rating. Present once the game finished (not abandoned). */
  rating?: RatingChange;
}

/** A mistake of a game, as runs name it: its move number and, for a taken-back first try, its index in `takenBack`. */
export interface MistakeRef {
  moveNumber: number;
  takenBack?: number;
}

/**
 * Mistakes of one game that all missed the same point (src/server/lessons.ts): each shares the
 * answer `answer`, and nothing was played on or next to it between them. One oversight, so one
 * lesson: it counts once in the profile, takes one category, and its practice problems are variants.
 */
export interface MistakeRun {
  /** The point that stayed open: an accepted answer of every mistake in the run. */
  answer: Gtp;
  /** The run's mistakes in move order (a taken-back first try before the move that stayed). */
  mistakes: MistakeRef[];
  /** The one that counts in the profile's tallies: a tutor-tagged one, else the worst. */
  lead: MistakeRef;
}

/** The effect of one finished game on the profile's rating and on the next game's bot. */
export interface RatingChange {
  before: number;
  after: number;
  /** False when the game was too short to count (under 10 human moves). */
  rated: boolean;
  /** The rank estimate is still running (game_end); `after` is then `before`. */
  pending?: boolean;
  /** The game's rank estimate from its moves; absent with too few unassisted moves or without KataGo. */
  estimate?: RankEstimate;
  /** Bot rank and handicap stones (for the learner) that the next game defaults to. */
  nextBotRank: string;
  nextHandicap: number;
}

/** games/<id>.json, as GET /api/game/:id returns it. */
export interface SavedGame {
  id: string;
  settings: GameSettings;
  createdAt: number;
  updatedAt: number;
  moves: MoveRecord[];
  result: GameResult | null;
  summary: GameSummary | null;
  /** Chat messages from this game. */
  chat: ChatMessage[];
  /** Mistake tags by move number, set with `tutor tag`. */
  tags: Record<number, { category: MistakeCategory; note?: string }>;
  /** Heuristic categories by move number, worked out when a mistake's eval arrives. Tags win over these. */
  heuristics?: Record<number, MistakeCategory>;
  /** The teaching moment as of the last save, so a restart can tell an open one from a dismissed one. */
  moment?: TeachingMoment | null;
  /** The drawing on the board as of the last save (the tutor's, KataGo's line, a hint mark), so a restart keeps it. */
  overlay?: Overlay | null;
  /** Human moves that were taken back, in the order they were (absent in games saved before they were kept). */
  takenBack?: TakenBackMove[];
  /** Help the learner had so far. */
  assistance?: AssistCounts;
  /**
   * Help the learner has for the move they play next, at move count `at`, so a restart still counts
   * that move as assisted; `hintAsked`: they asked the attached tutor for a hint there and have no
   * answer yet (the answer adds "hint"); `questionAsked`: they asked a chat question there (or on
   * the bot's turn before it) and have no answer yet (the answer adds "asked").
   */
  help?: { at: number; kinds: AssistKind[]; hintAsked?: true; questionAsked?: true };
  /** The learner's latest question or hint request reached the tutor and has no answer yet (on Silent, the tutor may answer it with one say). */
  questionOpen?: true;
  /** The reference rank for "at_level" judging, fixed when the game started (absent before judge modes existed). */
  atLevelRank?: string;
}

// ---------------------------------------------------------------------------
// Learner profile (data/profile.json)
// ---------------------------------------------------------------------------

/** Mistake categories, in the order the tutor CLI's help lists them. */
export const MISTAKE_CATEGORIES = ["life_and_death", "capturing_race", "opening", "direction", "shape", "endgame", "tactics", "other"] as const;
export type MistakeCategory = (typeof MISTAKE_CATEGORIES)[number];

export interface Profile {
  /** Rank the bot plays at next game (human-SL profile string, e.g. "18k"). */
  botRank: string;
  /** Estimated human rank on the RANK_SCALE below (fractional; 10.5 ≈ 19-20k). */
  rating: number;
  /**
   * Handicap stones the learner takes (as Black, on 9×9) by default: 0, or 2–4 while the rating is
   * below the weakest bot (20k), as a strength reducer for the bot.
   */
  handicap: number;
  /**
   * One entry per rated game, oldest first. `rating` is after the game, `delta` the change it made,
   * `estimate` the game's rank estimate from its moves (rating model 2).
   */
  ratingHistory: { ts: number; gameId: string; rating: number; botRank: string; won: boolean; handicap?: number; delta?: number; estimate?: RankEstimate }[];
  /** 2 = the rating comes from rank estimates of the learner's moves (absent: the old win/loss Elo; re-estimated at startup). */
  ratingModel?: 2;
  /**
   * 1 = the tallies count each run of mistakes that missed the same point once, and the saved games
   * and problems from before runs were grouped into lessons (src/server/migrate-lessons.ts, at startup).
   */
  lessons?: 1;
  /**
   * Finished rated games whose rank estimate hasn't been applied yet, in the order they finished
   * (it waits for KataGo, and for the migration while `ratingModel` isn't 2). Absent when none.
   */
  estimating?: string[];
  /**
   * Mistake threshold in points for pausing a game, on 9×9 (default 4; adapts between 2 and 6).
   * Other sizes scale it (src/shared/threshold.ts: ×1.5 on 13×13, ×2 on 19×19).
   */
  mistakeThreshold: number;
  /** Changes of mistakeThreshold, oldest first. */
  thresholdHistory: { ts: number; gameId: string; from: number; to: number; reason: string }[];
  /** Running tally of mistakes by category (the tutor's tag, else the heuristic category). */
  mistakeCounts: Record<MistakeCategory, number>;
  /** Most recent categorized mistakes, newest first, capped at 50. */
  recentMistakes: { ts: number; gameId: string; moveNumber: number; category: MistakeCategory; pointLoss: number; note?: string; takenBack?: number }[];
  /**
   * Finished games, oldest first, capped at 20: evaluated human moves, average point loss per
   * move, mistakes (point loss >= the threshold the game was played with), and `threshold`, the
   * profile's 9×9 threshold during the game (the game's own is `thresholdFor(threshold, size)`;
   * games before thresholds scaled by size used `threshold` itself on every size).
   */
  recentGames: { ts: number; gameId: string; size: GameSettings["size"]; humanMoves: number; avgPointLoss: number; mistakes: number; threshold: number }[];
  /** `gamesPlayed` when each category was last worked on (the tutor tagged it, or a practice problem). */
  practiced: Partial<Record<MistakeCategory, number>>;
  gamesPlayed: number;
  problemsSolved: number;
  /** How much the tutor steps in during games (default "coach"). */
  tutorLevel: TutorLevel;
  /** How the learner's moves are judged (default "optimal"). */
  judgeMode: JudgeMode;
  /** The limit on practice: misses so far, and the break it takes after too many. Absent until a practice problem is missed. */
  practice?: PracticeLimit;
}

/**
 * Practice stops after PRACTICE_MISS_LIMIT missed problems (src/server/lessons.ts) and stays closed
 * for PRACTICE_PAUSE_MS; when it opens again the missed lessons come first. Reviews of a game's
 * mistakes neither count nor close.
 */
export interface PracticeLimit {
  /** Practice problems missed since practice last closed, oldest first: when, and the lesson (its key). */
  misses: { at: number; lesson: string }[];
  /** Practice is closed until then (ms epoch). */
  closedUntil?: number;
  /** Lessons missed before practice last closed, which practice shows first once they are due; each leaves the list when it is shown. */
  retry?: string[];
}

/** What `summary` and GET /api/problems show of the practice limit. */
export interface PracticeStatus {
  /** Problems missed in this practice session, of `limit`. */
  misses: number;
  limit: number;
  /** Present while practice is closed. */
  closedUntil?: number;
  /** Lessons practice shows first once they are due. */
  retry: string[];
}

/** What to teach next (`recommendFocus` in src/server/profile.ts). */
export interface FocusRecommendation {
  category: MistakeCategory;
  reason: string;
  suggestion: "problems" | "game";
}

/** GET /api/profile. */
export interface ProfileResponse {
  profile: Profile;
  focus: FocusRecommendation;
}

// ---------------------------------------------------------------------------
// Practice problems (data/problems.json, src/server/problems.ts)
// ---------------------------------------------------------------------------

/** One practice problem as GET /api/problems lists it. */
export interface ProblemListItem {
  id: string;
  kind: ProblemKind;
  size: number;
  category: MistakeCategory;
  toPlay: Color;
  prompt: string;
  /** Accepted answers (KataGo's moves within 1 point of its best). */
  answers: Gtp[];
  /** Spaced-repetition (Leitner) box, 1–5: solving on the first try moves it up, failing sends it to 1. */
  box: number;
  /** When it is next due (ms epoch), and whether that is now. */
  due: number;
  isDue: boolean;
  /** Times it was shown to a result, and times solved. */
  seen: number;
  solves: number;
  lastResult?: "first_try" | "solved" | "failed";
  /** The learner's game and move it came from (kind "game"), and the points that move lost. */
  source?: { gameId: string; moveNumber: number };
  difficulty?: number;
  /** Where a generated problem comes from (kind "generated"). */
  generated?: GeneratedProblemInfo;
  /** One variant of a lesson: a run of mistakes that missed the same point. */
  lesson?: LessonInfo;
}

/** GET /api/problems. */
export interface ProblemsResponse {
  /** Due first (in the order next_problem would pick them), then the rest by due time. */
  problems: ProblemListItem[];
  counts: {
    total: number;
    due: number;
    fromGames: number;
    generated: number;
    /** Problems per box; index 0 is box 1. */
    byBox: number[];
    /** Due problems per category. */
    dueByCategory: Partial<Record<MistakeCategory, number>>;
  };
  /** The profile's recommended focus, which next_problem prefers. */
  focus: FocusRecommendation;
  /** Problem generation: the batch in progress and the newest finished one. */
  generation?: GenerationStatus;
  /** The practice limit: misses so far, and whether practice is closed. */
  practice?: PracticeStatus;
}

/**
 * "game" = built from the learner's own mistake; "generated" = from a mistake in a game KataGo
 * played against itself with its human-style net (src/server/generate.ts).
 */
export type ProblemKind = "game" | "generated";

/** What the learner, the tutor and the UI see of a generated problem's origin. */
export interface GeneratedProblemInfo {
  batchId: string;
  /** The rank at which KataGo's human-style policy finds an answer half the time, e.g. "14k". */
  difficultyRank: string;
  /** The human-SL ranks of the self-play game: the side that made the mistake, and its opponent. */
  weakerRank: string;
  strongerRank: string;
}

/** One board size's share of a batch of generated problems. */
export interface GenerationSizeStatus {
  size: BoardSize;
  found: number;
  target: number;
  /** Self-play games finished on this size so far, and KataGo time spent on this size, in minutes. */
  games: number;
  minutes: number;
}

/** A batch of generated problems (GET /api/generation, GameView.generation). */
export interface GenerationBatchStatus {
  id: string;
  number: number;
  weakerRank: string;
  strongerRank: string;
  /** "first" = the starter batch; "mastery" = the previous batch was mastered; "manual" = `tutor generate --now`. */
  trigger: "first" | "mastery" | "manual";
  found: number;
  target: number;
  sizes: GenerationSizeStatus[];
  /** The difficulty band preferred, e.g. "20k–16k". */
  band: string;
  createdAt: number;
  finishedAt?: number;
}

export interface GenerationStatus {
  /**
   * "generating" = KataGo is working on a batch; "waiting" = a batch is in progress but waits while
   * the learner plays or KataGo isn't ready; "idle" = no batch in progress.
   */
  state: "generating" | "waiting" | "idle";
  current: GenerationBatchStatus | null;
  /**
   * The newest finished batch: its problems, how many are mastered (Leitner box 3 or higher), and
   * how many mastered ones start the next batch.
   */
  last: (GenerationBatchStatus & { problems: number; mastered: number; needed: number }) | null;
  /** Finished batches so far. */
  batches: number;
}

// Rank scale used for `Profile.rating`: 30k = 0 … 1k = 29, 1d = 30 … 9d = 38. Convert with
// rankToRating / ratingToRank in src/shared/rank.ts.
