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
  marks?: { point: Point; kind: "circle" | "triangle" | "square" | "x" | "label"; text?: string }[];
}

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
  /** True while KataGo is thinking (bot move or analysis). */
  engineBusy: boolean;
  /** Present in problem mode. */
  problem?: ProblemView | null;
}

export interface ProblemView {
  id: string;
  prompt: string;
  /** Source game and move, when built from the user's own mistake. */
  source?: { gameId: string; moveNumber: number };
  attempts: number;
  solved: boolean;
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
  | { type: "retry" } // take back the last human move (and bot reply) and try again
  | { type: "chat"; text: string }
  | { type: "ask_tutor"; text?: string } // explicit "hint please" button
  | { type: "next_problem" };

// ---------------------------------------------------------------------------
// Tutor → server (the `tutor` CLI posts these to POST /api/tutor)
// ---------------------------------------------------------------------------

export type TutorCommand =
  | { type: "say"; text: string; momentId?: string }
  /** Undo the human's last move and ask them to think again. Keeps the game paused until they play. */
  | { type: "rethink"; text: string; momentId?: string }
  /** Draw a variation as numbered ghost stones. Moves alternate starting with `start` (default: the mover of the moment). */
  | { type: "show"; moves: Gtp[]; start?: Color; label?: string }
  | { type: "mark"; points: Gtp[]; kind?: "circle" | "triangle" | "square" | "x"; text?: string }
  | { type: "clear" }
  /** End the pause and let play continue. */
  | { type: "resume" }
  /** Tutor took ownership of the current moment; cancels the fallback timer. */
  | { type: "claim"; momentId: string }
  | { type: "new_game"; settings?: Partial<GameSettings> }
  | { type: "start_problem"; problemId?: string }
  | { type: "tag"; gameId: string; moveNumber: number; category: MistakeCategory; note?: string };

// ---------------------------------------------------------------------------
// Server → tutor event stream (GET /api/tutor/events, SSE; one JSON object per event)
// ---------------------------------------------------------------------------

export type TutorEvent =
  | { seq: number; ts: number; type: "game_start"; gameId: string; settings: GameSettings }
  | { seq: number; ts: number; type: "move"; gameId: string; record: MoveRecord; by: "human" | "bot" }
  | {
      seq: number;
      ts: number;
      type: "teaching_moment";
      gameId: string;
      /** "waiting" when live. A replay (reconnect, fresh watch) carries the moment's state at replay time. */
      moment: TeachingMoment;
      record: MoveRecord;
      /** ASCII rendering of the position BEFORE the human's move, for the tutor to read. */
      boardBefore: string;
      /** ASCII rendering AFTER the move. */
      boardAfter: string;
    }
  | { seq: number; ts: number; type: "user_message"; text: string; momentId?: string; gameId: string | null }
  | { seq: number; ts: number; type: "hint_request"; text?: string; gameId: string; board: string; toPlay: Color }
  | { seq: number; ts: number; type: "fallback"; momentId: string }
  /** Moves were taken back (browser Try again, or the tutor's rethink). `moves` is how many remain. */
  | { seq: number; ts: number; type: "undo"; gameId: string; moves: number; toPlay: Color; by: "human" | "tutor" }
  | { seq: number; ts: number; type: "game_end"; gameId: string; result: GameResult; summary: GameSummary }
  | { seq: number; ts: number; type: "problem_attempt"; problemId: string; move: Gtp; correct: boolean };

export interface GameSummary {
  moves: number;
  /** Human moves with pointLoss >= the mistake threshold, worst first. */
  mistakes: { moveNumber: number; move: Gtp; pointLoss: number; bestMove: Gtp; category?: MistakeCategory }[];
  totalPointLoss: number;
}

// ---------------------------------------------------------------------------
// Learner profile (data/profile.json)
// ---------------------------------------------------------------------------

export type MistakeCategory =
  | "life_and_death"
  | "capturing_race"
  | "opening"
  | "direction"
  | "shape"
  | "endgame"
  | "tactics"
  | "other";

export interface Profile {
  /** Rank the bot plays at next game (human-SL profile string, e.g. "18k"). */
  botRank: string;
  /** Estimated human rank on the RANK_SCALE below (fractional; 10.5 ≈ 19-20k). */
  rating: number;
  ratingHistory: { ts: number; gameId: string; rating: number; botRank: string; won: boolean }[];
  /** Mistake threshold in points for pausing a game (default 4). */
  mistakeThreshold: number;
  /** Running tally of tagged mistakes by category. */
  mistakeCounts: Record<MistakeCategory, number>;
  /** Most recent tagged mistakes, newest first, capped. */
  recentMistakes: { ts: number; gameId: string; moveNumber: number; category: MistakeCategory; pointLoss: number; note?: string }[];
  gamesPlayed: number;
  problemsSolved: number;
}

/**
 * Rank scale used for `Profile.rating`: 30k = 0, 1k = 29, 1d = 30, 9d = 38.
 * Convert with rankToRating / ratingToRank in src/shared/rank.ts.
 */
export const RANK_SCALE_NOTE = "30k=0 … 1k=29, 1d=30 … 9d=38";
