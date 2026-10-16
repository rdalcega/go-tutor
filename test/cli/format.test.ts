import { describe, expect, it } from "vitest";
import {
  formatEvent,
  formatProblems,
  formatProfile,
  formatReview,
  formatState,
  num,
  resultText,
  statusLine,
} from "../../src/cli/format.ts";
import type { Board, GameSettings, GameView, MoveEval, MoveRecord, Profile, TutorEvent } from "../../src/shared/types.ts";

const settings: GameSettings = { size: 9, komi: 7, humanColor: "B", botRank: "20k", handicap: 0 };
const ctx = { sizeOf: (g: string) => (g === "g12" ? 9 : undefined), now: 1_000_000 };

const evalOf = (pointLoss: number): MoveEval => ({
  leadBefore: 2,
  leadAfter: 2 - pointLoss,
  pointLoss,
  winrateBefore: 0.6,
  winrateAfter: 0.3,
  bestMove: "D5",
  bestPv: ["D5", "E4", "C6"],
  candidates: [{ move: "D5", lead: 2, winrate: 0.6, visits: 300, pv: ["D5", "E4"] }],
});

// C3 on 9x9 is x=2, y=6.
const humanMove: MoveRecord = { number: 14, move: { color: "B", point: { x: 2, y: 6 } }, captures: [], eval: evalOf(6.2) };

describe("formatEvent", () => {
  const base = { seq: 1, ts: 1_000_000 };

  it("formats a teaching moment on one line", () => {
    const e: TutorEvent = {
      ...base,
      type: "teaching_moment",
      gameId: "g12",
      moment: { id: "m3", moveNumber: 14, pointLoss: 6.2, state: "waiting", deadline: 1_030_000 },
      record: humanMove,
      boardBefore: "",
      boardAfter: "",
    };
    expect(formatEvent(e, ctx)).toBe(
      "MOMENT m3 game=g12 move 14 B C3 lost 6.2 pts (best D5, pv D5 E4 C6) — reply with: claim m3, then say/show/rethink/resume; fallback in 30s",
    );
    // The countdown runs from now, not from when the event was stamped.
    expect(formatEvent(e, { ...ctx, now: 1_012_000 })).toMatch(/; fallback in 18s$/);
  });

  it("marks replayed moments that are no longer waiting, without a countdown", () => {
    const e = (state: "tutor" | "fallback" | "resolved"): TutorEvent => ({
      ...base,
      type: "teaching_moment",
      gameId: "g12",
      moment: { id: "m3", moveNumber: 14, pointLoss: 6.2, state },
      record: humanMove,
      boardBefore: "",
      boardAfter: "",
    });
    expect(formatEvent(e("fallback"), ctx)).toBe(
      "MOMENT m3 game=g12 move 14 B C3 lost 6.2 pts (best D5, pv D5 E4 C6) — reply with: claim m3, then say/show/rethink/resume (replayed; now fallback)",
    );
    expect(formatEvent(e("resolved"), ctx)).toBe("MOMENT m3 game=g12 move 14 B C3 lost 6.2 pts (best D5, pv D5 E4 C6) (replayed; already resolved)");
  });

  it("formats moves, with loss when known", () => {
    const bot: TutorEvent = {
      ...base,
      type: "move",
      gameId: "g12",
      by: "bot",
      record: { number: 15, move: { color: "W", point: { x: 3, y: 3 } }, captures: [] },
    };
    expect(formatEvent(bot, ctx)).toBe("MOVE 15 W D6 (bot)");
    const human: TutorEvent = { ...base, type: "move", gameId: "g12", by: "human", record: humanMove };
    expect(formatEvent(human, ctx)).toBe("MOVE 14 B C3 (human) lost 6.2 (best D5)");
    const pass: TutorEvent = { ...base, type: "move", gameId: "g12", by: "bot", record: { number: 16, move: { color: "W", pass: true }, captures: [] } };
    expect(formatEvent(pass, ctx)).toBe("MOVE 16 W pass (bot)");
  });

  it("formats chat, hints, fallback, game end and problems", () => {
    expect(formatEvent({ ...base, type: "user_message", text: "why was that bad?\nreally", momentId: "m3", gameId: "g12" }, ctx)).toBe(
      'USER "why was that bad?\\nreally" (moment m3) game=g12',
    );
    expect(formatEvent({ ...base, type: "hint_request", text: "where now?", gameId: "g12", board: "", toPlay: "B" }, ctx)).toBe(
      'HINT game=g12 B to play — user asks: "where now?" — run: state, then say/show/mark',
    );
    expect(formatEvent({ ...base, type: "fallback", momentId: "m3" }, ctx)).toBe("FALLBACK m3 (tutor too slow; KataGo answer shown)");
    const end: TutorEvent = {
      ...base,
      type: "game_end",
      gameId: "g12",
      result: { winner: "W", margin: -3.5, reason: "score" },
      summary: {
        moves: 61,
        totalPointLoss: 15,
        mistakes: [
          { moveNumber: 20, move: "E5", pointLoss: 4.1, bestMove: "F5" },
          { moveNumber: 14, move: "C3", pointLoss: 6.2, bestMove: "D5" },
        ],
      },
    };
    expect(formatEvent(end, ctx)).toBe(
      "GAME_END g12 W+3.5 — 2 mistakes, worst move 14 (6.2), total loss 15 over 61 moves — run: review g12",
    );
    expect(formatEvent({ ...base, type: "problem_attempt", problemId: "p4", move: "C7", correct: false }, ctx)).toBe(
      "PROBLEM p4 attempt C7 wrong",
    );
  });

  it("formats game start", () => {
    expect(formatEvent({ ...base, type: "game_start", gameId: "g12", settings }, ctx)).toBe("GAME_START g12 9x9 komi 7 human=B bot=20k");
  });
});

describe("helpers", () => {
  it("formats numbers and results", () => {
    expect(num(6.25)).toBe("6.3");
    expect(num(7)).toBe("7");
    expect(resultText({ winner: "B", margin: 2.5, reason: "score" })).toBe("B+2.5");
    expect(resultText({ winner: "W", margin: 0, reason: "resign" })).toBe("W+R");
    expect(resultText({ winner: null, margin: 0, reason: "score" })).toBe("draw");
  });
});

const emptyBoard = (n: number): Board => Array.from({ length: n }, () => Array<null>(n).fill(null));

const view = (over: Partial<GameView> = {}): GameView => ({
  gameId: "g12",
  mode: "game",
  settings,
  status: "paused",
  board: emptyBoard(9),
  toPlay: "W",
  moves: [
    { number: 1, move: { color: "B", point: { x: 4, y: 4 } }, captures: [], eval: evalOf(0.3) },
    { number: 2, move: { color: "W", point: { x: 2, y: 2 } }, captures: [] },
    { ...humanMove, number: 3 },
  ],
  captures: { B: 0, W: 0 },
  result: null,
  moment: { id: "m3", moveNumber: 3, pointLoss: 6.2, state: "waiting", deadline: 20_000 },
  overlay: { variation: { label: "Better", moves: [{ color: "B", point: { x: 3, y: 4 } }] }, marks: [{ point: { x: 4, y: 4 }, kind: "circle" }] },
  chat: [
    { id: "c1", ts: 1, from: "user", text: "hi" },
    { id: "c2", ts: 2, from: "tutor", text: "line1\nline2", momentId: "m3" },
  ],
  tutorAttached: true,
  engineBusy: false,
  ...over,
});

describe("formatState", () => {
  it("includes header, board, moves, eval, moment, overlay and chat", () => {
    const text = formatState(view(), 10_000);
    expect(text).toContain("game g12 mode=game status=paused 9x9 komi 7 human=B bot=20k");
    expect(text).toContain("toPlay=W captures B:0 W:0 tutor=attached engine=idle");
    // The board comes from the engine's toAscii, so it matches the boards in events.
    expect(text).toContain("9 . . . . . . . . . 9\n8 . . . . . . . . . 8");
    expect(text).toContain("1 B E5 -0.3 | 2 W C7 | 3 B C3 -6.2!");
    expect(text).toContain("last move 3 B C3: lead 2 -> -4.2, winrate 60% -> 30%, best D5 (pv D5 E4 C6)");
    expect(text).toContain("candidates: D5 2");
    expect(text).toContain("moment m3 move 3 lost 6.2 state=waiting (fallback in 10s; claim it to keep it)");
    expect(text).toContain('overlay: variation "Better": B D5; marks: E5 circle');
    const before = formatState(view({ overlay: { variation: { moves: [{ color: "B", point: { x: 3, y: 4 } }], fromMove: 3 } } }), 10_000);
    expect(before).toContain("overlay: variation (from the position before move 3): B D5");
    expect(text).toContain("[user] hi\n[tutor m3] line1 / line2");
  });

  it("handles an idle server", () => {
    const text = formatState(view({ gameId: null, mode: "idle", settings: null, status: "playing", board: [], moves: [], moment: null, overlay: null, chat: [] }));
    expect(text).toContain("no game mode=idle");
    expect(text).toContain("moves: none");
    expect(text).toContain("moment: none");
    expect(text).toContain("chat: empty");
  });

  it("statusLine is a single line", () => {
    expect(statusLine(view({ moment: { id: "m3", moveNumber: 3, pointLoss: 6.2, state: "tutor" } }))).toBe(
      "game=g12 mode=game status=paused toPlay=W moves=3 moment m3 move 3 lost 6.2 state=tutor",
    );
  });
});

describe("summary and review", () => {
  it("formats a profile", () => {
    const p: Profile = {
      botRank: "18k",
      rating: 10.6,
      ratingHistory: [{ ts: 1, gameId: "g11", rating: 10, botRank: "19k", won: true }],
      mistakeThreshold: 4,
      mistakeCounts: { life_and_death: 3, capturing_race: 0, opening: 1, direction: 0, shape: 5, endgame: 0, tactics: 0, other: 0 },
      recentMistakes: [{ ts: 1, gameId: "g11", moveNumber: 14, category: "shape", pointLoss: 6.2, note: "empty triangle" }],
      gamesPlayed: 11,
      problemsSolved: 2,
    };
    const text = formatProfile(p);
    expect(text).toContain("rank estimate 19k (rating 10.6), bot plays 18k, games 11, problems solved 2, mistake threshold 4 pts");
    expect(text).toContain("mistakes by category: shape 5, life_and_death 3, opening 1");
    expect(text).toContain('g11 move 14 shape -6.2 "empty triangle"');
  });

  it("lists open problems", () => {
    expect(formatProblems([])).toBe("open problems: none (0 total)");
    expect(formatProblems([{ id: "p1", solved: true }, { id: "p2", prompt: "Black to live", source: { gameId: "g3", moveNumber: 9 } }])).toBe(
      "open problems (1 of 2) — start one with: problem <id>\n  p2 from g3 move 9: Black to live",
    );
  });

  it("formats a review", () => {
    const text = formatReview({
      id: "g12",
      settings,
      moves: view().moves,
      result: { winner: "W", margin: -3.5, reason: "score" },
      summary: { moves: 3, totalPointLoss: 6.5, mistakes: [{ moveNumber: 3, move: "C3", pointLoss: 6.2, bestMove: "D5" }] },
    });
    expect(text.split("\n")).toEqual([
      "game g12 9x9 komi 7 human=B bot=20k result W+3.5 moves 3",
      "moves (human: loss, best move, pv; bot moves bare):",
      "1 B E5 -0.3",
      "2 W C7",
      "3 B C3 -6.2 MISTAKE best D5 pv D5 E4 C6",
      "summary: 1 mistake, worst move 3 (6.2), total loss 6.5",
      "  move 3 C3 -6.2 best D5 [untagged]",
      "tag untagged mistakes with: tag g12 <move#> <category> [note]",
    ]);
  });
});
