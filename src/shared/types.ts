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
   * Help the learner had for this move (human moves only; absent = none). Assisted moves don't count
   * for the rank estimate.
   */
  assist?: AssistKind[];
}

/**
 * Kinds of help for one human move: "hint" = played after a hint for that position was answered
 * (by the tutor or KataGo); "retry" = replaces a move the learner took back (Try again, Take back);
 * "rethink" = replaces a move the tutor took back; "shown" = played after the tutor drew on that
 * position (show or mark) or a hint circled a point there, even if the learner hid the drawing.
 */
export const ASSIST_KINDS = ["hint", "retry", "rethink", "shown"] as const;
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

/** Help the learner had in one game: hint requests, their own take-backs, and the tutor's rethinks. */
export interface AssistCounts {
  hints: number;
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
}

export type GameStatus = "playing" | "paused" | "finished";

export interface GameSettings {
  size: 9 | 13 | 19;
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
  /** True while KataGo is thinking (bot move or analysis). */
  engineBusy: boolean;
  /** Present in problem mode. */
  problem?: ProblemView | null;
  /** Bumped whenever the learner profile changes (a game or problem ends, a tag): refetch GET /api/profile. */
  profileVersion: number;
  /** The browser actions the server accepts right now (the same checks POST /api/action enforces). */
  allowed: ClientAction["type"][];
}

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
  attempts: number;
  solved: boolean;
  /** "game" = built from the learner's own mistake; "builtin" = one of the classic starter problems. */
  kind: "game" | "builtin";
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
  | { type: "leave_problem" } // back to the game (or the idle board)
  | { type: "clear_overlay" } // hide the drawing on the board (the tutor's, KataGo's or a hint)
  | { type: "set_tutor_level"; level: TutorLevel }; // applies from the learner's next move

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
  | { type: "start_problem"; problemId?: string }
  /**
   * `takenBack`: a taken-back first attempt at that move number, not the move that stayed on the
   * board: a number is the try's number there (review's "first try #2"), `true` the only one.
   */
  | { type: "tag"; gameId: string; moveNumber: number; category: MistakeCategory; note?: string; takenBack?: boolean | number };

// ---------------------------------------------------------------------------
// Server → tutor event stream (GET /api/tutor/events, SSE; one JSON object per event)
// ---------------------------------------------------------------------------

export type TutorEvent =
  | { seq: number; ts: number; type: "game_start"; gameId: string; settings: GameSettings; tutorLevel?: TutorLevel }
  | { seq: number; ts: number; type: "move"; gameId: string; size: number; record: MoveRecord; by: "human" | "bot" }
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
  /** `problemId` is set when the learner wrote while a practice problem was on the board (the message is about it). */
  | { seq: number; ts: number; type: "user_message"; text: string; momentId?: string; gameId: string | null; problemId?: string }
  | { seq: number; ts: number; type: "hint_request"; text?: string; gameId: string; size: number; board: string; toPlay: Color }
  | { seq: number; ts: number; type: "fallback"; momentId: string }
  /** Moves were taken back (browser Try again, or the tutor's rethink). `moves` is how many remain. */
  | { seq: number; ts: number; type: "undo"; gameId: string; moves: number; toPlay: Color; by: "human" | "tutor" }
  /** `summary.rating` is `pending` while the rank estimate runs; a `rating` event follows. */
  | { seq: number; ts: number; type: "game_end"; gameId: string; result: GameResult; summary: GameSummary }
  /** The finished game's rank estimate is in and the rating updated. */
  | { seq: number; ts: number; type: "rating"; gameId: string; rating: RatingChange }
  /** A practice problem is on the board. `answers` are the accepted moves (for the tutor; the learner doesn't see them). */
  | {
      seq: number;
      ts: number;
      type: "problem_start";
      problemId: string;
      kind: "game" | "builtin";
      category: MistakeCategory;
      toPlay: Color;
      prompt: string;
      answers: Gtp[];
      box: number;
      source?: { gameId: string; moveNumber: number };
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
    };

export interface GameSummary {
  moves: number;
  /** Human moves with pointLoss >= the mistake threshold, worst first, taken-back first attempts included. */
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
  /** Points lost by every evaluated human move, taken-back ones included. */
  totalPointLoss: number;
  /** Help the learner had in the game. */
  assistance?: AssistCounts;
  /** How the game moved the learner's rating. Present once the game finished (not abandoned). */
  rating?: RatingChange;
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
  /** Human moves that were taken back, in the order they were (absent in games saved before they were kept). */
  takenBack?: TakenBackMove[];
  /** Help the learner had so far. */
  assistance?: AssistCounts;
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
   * Finished rated games whose rank estimate hasn't been applied yet, in the order they finished
   * (it waits for KataGo, and for the migration while `ratingModel` isn't 2). Absent when none.
   */
  estimating?: string[];
  /** Mistake threshold in points for pausing a game (default 4; adapts between 2 and 6). */
  mistakeThreshold: number;
  /** Changes of mistakeThreshold, oldest first. */
  thresholdHistory: { ts: number; gameId: string; from: number; to: number; reason: string }[];
  /** Running tally of mistakes by category (the tutor's tag, else the heuristic category). */
  mistakeCounts: Record<MistakeCategory, number>;
  /** Most recent categorized mistakes, newest first, capped at 50. */
  recentMistakes: { ts: number; gameId: string; moveNumber: number; category: MistakeCategory; pointLoss: number; note?: string; takenBack?: number }[];
  /**
   * Finished games, oldest first, capped at 20: evaluated human moves, average point loss per
   * move, mistakes (point loss >= `threshold`, the threshold the game was played with).
   */
  recentGames: { ts: number; gameId: string; size: number; humanMoves: number; avgPointLoss: number; mistakes: number; threshold: number }[];
  /** `gamesPlayed` when each category was last worked on (the tutor tagged it, or a practice problem). */
  practiced: Partial<Record<MistakeCategory, number>>;
  gamesPlayed: number;
  problemsSolved: number;
  /** How much the tutor steps in during games (default "coach"). */
  tutorLevel: TutorLevel;
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
  kind: "game" | "builtin";
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
}

/** GET /api/problems. */
export interface ProblemsResponse {
  /** Due first (in the order next_problem would pick them), then the rest by due time. */
  problems: ProblemListItem[];
  counts: {
    total: number;
    due: number;
    fromGames: number;
    builtin: number;
    /** Problems per box; index 0 is box 1. */
    byBox: number[];
    /** Due problems per category. */
    dueByCategory: Partial<Record<MistakeCategory, number>>;
  };
  /** The profile's recommended focus, which next_problem prefers. */
  focus: FocusRecommendation;
}

/**
 * Rank scale used for `Profile.rating`: 30k = 0, 1k = 29, 1d = 30, 9d = 38.
 * Convert with rankToRating / ratingToRank in src/shared/rank.ts.
 */
export const RANK_SCALE_NOTE = "30k=0 … 1k=29, 1d=30 … 9d=38";
