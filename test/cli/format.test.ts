import { describe, expect, it } from "vitest";
import { defaultProfile } from "../../src/server/store.ts";
import {
  commandJson,
  commandOutput,
  dueText,
  formatEvent,
  formatGeneration,
  formatProblemList,
  formatProblems,
  formatProfile,
  formatReview,
  formatState,
  generationLines,
  num,
  problemLines,
  resultText,
  reviewThreshold,
  statusLine,
  winrateSwings,
} from "../../src/cli/format.ts";
import { thresholdText } from "../../src/shared/threshold.ts";
import type {
  Board,
  GameSettings,
  GameView,
  GenerationStatus,
  MoveEval,
  MoveRecord,
  ProblemListItem,
  ProblemsResponse,
  ProblemView,
  Profile,
  TutorEvent,
} from "../../src/shared/types.ts";

const settings: GameSettings = { size: 9, komi: 7, humanColor: "B", botRank: "20k", handicap: 0 };
const ctx = { now: 1_000_000 };

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
      size: 9,
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
      size: 9,
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
      size: 9,
      gameId: "g12",
      by: "bot",
      record: { number: 15, move: { color: "W", point: { x: 3, y: 3 } }, captures: [] },
    };
    expect(formatEvent(bot, ctx)).toBe("MOVE 15 W D6 (bot)");
    const human: TutorEvent = { ...base, type: "move", gameId: "g12", size: 9, by: "human", record: humanMove };
    expect(formatEvent(human, ctx)).toBe("MOVE 14 B C3 (human) lost 6.2 (best D5)");
    const pass: TutorEvent = { ...base, type: "move", gameId: "g12", size: 9, by: "bot", record: { number: 16, move: { color: "W", pass: true }, captures: [] } };
    expect(formatEvent(pass, ctx)).toBe("MOVE 16 W pass (bot)");
  });

  it("formats events logged before they carried size, without throwing", () => {
    // Old-format events (events.jsonl from before `size`): no size on the event.
    const old = { ...base, type: "move", gameId: "g12", by: "bot", record: { number: 12, move: { color: "W", point: { x: 3, y: 3 } }, captures: [] } } as unknown as TutorEvent;
    expect(formatEvent(old, ctx)).toBe("MOVE 12 W (coords unavailable) (bot)");
    expect(formatEvent(old, { ...ctx, sizeOf: (g) => (g === "g12" ? 9 : undefined) })).toBe("MOVE 12 W D6 (bot)");
    const moment = {
      ...base,
      type: "teaching_moment",
      gameId: "g12",
      moment: { id: "m3", moveNumber: 14, pointLoss: 6.2, state: "resolved" },
      record: humanMove,
      boardBefore: "",
      boardAfter: "",
    } as unknown as TutorEvent;
    expect(formatEvent(moment, ctx)).toBe("MOMENT m3 game=g12 move 14 B (coords unavailable) lost 6.2 pts (best D5, pv D5 E4 C6) (replayed; already resolved)");
    // Even a malformed event prints as a raw line instead of throwing.
    const broken = { ...base, type: "move", gameId: "g12", size: 9, by: "bot" } as unknown as TutorEvent;
    expect(formatEvent(broken, ctx)).toMatch(/^EVENT move seq=/);
  });

  it("formats chat, hints, fallback, game end and problems", () => {
    expect(formatEvent({ ...base, type: "user_message", text: "why was that bad?\nreally", momentId: "m3", gameId: "g12" }, ctx)).toBe(
      'USER "why was that bad?\\nreally" (moment m3) game=g12',
    );
    expect(formatEvent({ ...base, type: "user_message", text: "what is this?", gameId: "g12", problemId: "b-ladder" }, ctx)).toBe(
      'USER "what is this?" (problem b-ladder)',
    );
    expect(formatEvent({ ...base, type: "hint_request", text: "where now?", gameId: "g12", size: 9, board: "", toPlay: "B" }, ctx)).toBe(
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
    if (end.type !== "game_end") throw new Error("expected game_end");
    const rated = { ...end, summary: { ...end.summary, rating: { before: 10, after: 8.5, rated: true, nextBotRank: "20k", nextHandicap: 0 } } };
    expect(formatEvent(rated, ctx)).toBe(
      "GAME_END g12 W+3.5 — 2 mistakes, worst move 14 (6.2), total loss 15 over 61 moves, rating 10 -> 8.5 — run: review g12",
    );
    // Rating model 2: the estimate runs after game_end, and a RATING line follows.
    const firsts = [{ moveNumber: 14, move: "C3", pointLoss: 6.2, bestMove: "D5", takenBack: 0 }];
    const pending = {
      ...end,
      summary: { ...end.summary, mistakes: [...end.summary.mistakes, ...firsts], assistance: { hints: 2, takeBacks: 1, rethinks: 0 }, rating: { before: 10, after: 10, rated: true, pending: true, nextBotRank: "20k", nextHandicap: 0 } },
    };
    expect(formatEvent(pending, ctx)).toBe(
      "GAME_END g12 W+3.5 — 3 mistakes (1 taken back), worst move 14 (6.2), total loss 15 over 61 moves, help: 2 hints, 1 take-back, rank estimate running (a RATING line follows) — run: review g12",
    );
    const estimate = { rating: 12.4, floor: false, moves: 25, hints: 2, takeBacks: 1, rethinks: 0 };
    expect(formatEvent({ ...base, type: "rating", gameId: "g12", rating: { before: 10, after: 11.9, rated: true, nextBotRank: "18k", nextHandicap: 0, estimate } }, ctx)).toBe(
      "RATING g12 rank estimate 18k from 25 unassisted moves (2 hints, 1 take-back); rating 10 -> 11.9 (+1.9, rank 18k); next bot 18k",
    );
  });

  it("formats problem starts and attempts with the category, first try and what to do next", () => {
    const start: TutorEvent = {
      ...base,
      type: "problem_start",
      problemId: "p4",
      kind: "game",
      category: "life_and_death",
      toPlay: "B",
      prompt: "Black to play. Live.",
      answers: ["D5", "E5"],
      box: 2,
      source: { gameId: "g12", moveNumber: 14 },
      board: "",
    };
    expect(formatEvent(start, ctx)).toBe(
      'PROBLEM_START p4 life_and_death B to play (from g12 move 14, box 2) answers D5,E5 — "Black to play. Live." — run: state; let them try, don\'t give the answer',
    );
    if (start.type !== "problem_start") throw new Error("expected problem_start");
    const { source: _source, ...rest } = start;
    const generated = { batchId: "batch2", difficultyRank: "14k", weakerRank: "17k", strongerRank: "12k" };
    expect(formatEvent({ ...rest, kind: "generated", problemId: "gen4", size: 13, generated }, ctx)).toContain(
      "PROBLEM_START gen4 life_and_death B to play (generated 13x13, difficulty 14k, batch2, box 2)",
    );
    // An old starter problem in the log.
    expect(formatEvent({ ...rest, problemId: "b-net" }, ctx)).toContain("PROBLEM_START b-net life_and_death B to play (built-in, box 2)");

    const batch = {
      id: "batch2",
      number: 2,
      weakerRank: "17k",
      strongerRank: "12k",
      trigger: "mastery" as const,
      found: 20,
      target: 20,
      sizes: [
        { size: 9 as const, found: 7, target: 7, games: 6, minutes: 8 },
        { size: 13 as const, found: 6, target: 6, games: 3, minutes: 12 },
        { size: 19 as const, found: 7, target: 7, games: 3, minutes: 21 },
      ],
      band: "17k–13k",
      createdAt: 0,
    };
    expect(formatEvent({ ...base, type: "generation", status: "started", batch: { ...batch, found: 0 } }, ctx)).toBe(
      "BATCH batch2 started (mastery): 20 problems from 17k vs 12k self-play, difficulty band 17k–13k; they join practice as they're found",
    );
    expect(formatEvent({ ...base, type: "generation", status: "finished", batch }, ctx)).toBe(
      "BATCH batch2 finished: 20 new problems (7 on 9x9, 6 on 13x13, 7 on 19x19), difficulty band 17k–13k — tell the learner when it fits (not mid-game on Silent)",
    );

    const attempt = {
      ...base,
      type: "problem_attempt" as const,
      problemId: "p4",
      move: "C7",
      correct: false,
      category: "life_and_death" as const,
      attempt: 1,
      firstTry: false,
      pointLoss: 5.24,
      revealed: false,
      bestMove: "D5",
      bestPv: ["D5", "E4", "C6"],
    };
    expect(formatEvent(attempt, ctx)).toBe(
      "PROBLEM p4 attempt 1 C7 wrong, lost 5.2 (life_and_death; another attempt left) — ask what they see, don't give the answer (best D5, pv D5 E4 C6)",
    );
    expect(formatEvent({ ...attempt, attempt: 2, revealed: true }, ctx)).toBe(
      "PROBLEM p4 attempt 2 C7 wrong, lost 5.2 (life_and_death; out of attempts, answer shown) — best D5, pv D5 E4 C6 — explain it; show the refutation of C7",
    );
    expect(formatEvent({ ...attempt, move: "D5", correct: true, firstTry: true, pointLoss: 0, revealed: true }, ctx)).toBe(
      "PROBLEM p4 attempt 1 D5 correct, first try (life_and_death) — best D5, pv D5 E4 C6 — say why it works",
    );
  });

  it("formats game start", () => {
    expect(formatEvent({ ...base, type: "game_start", gameId: "g12", settings }, ctx)).toBe("GAME_START g12 9x9 komi 7 human=B bot=20k");
    expect(formatEvent({ ...base, type: "game_start", gameId: "g12", settings, tutorLevel: "silent" }, ctx)).toBe(
      "GAME_START g12 9x9 komi 7 human=B bot=20k level=silent",
    );
  });

  it("formats tutor level changes and point_out moments with what they mean for the tutor", () => {
    expect(formatEvent({ ...base, type: "tutor_level", level: "point_out", gameId: "g12" }, ctx)).toBe(
      "LEVEL point_out — explain mistakes, don't take moves back (rethink is refused) (from the learner's next move)",
    );
    expect(formatEvent({ ...base, type: "tutor_level", level: "silent", gameId: null }, ctx)).toMatch(/^LEVEL silent — no teaching moments; .*one say/);
    const moment: TutorEvent = {
      ...base,
      type: "teaching_moment",
      size: 9,
      gameId: "g12",
      moment: { id: "m3", moveNumber: 14, pointLoss: 6.2, state: "waiting", deadline: 1_030_000 },
      record: humanMove,
      boardBefore: "",
      boardAfter: "",
      tutorLevel: "point_out",
    };
    expect(formatEvent(moment, ctx)).toBe(
      "MOMENT m3 game=g12 move 14 B C3 lost 6.2 pts (best D5, pv D5 E4 C6) — level point_out: explain mistakes, don't take moves back (rethink is refused) — reply with: claim m3, then say/show/mark/resume; fallback in 30s",
    );
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
  tutorLevel: "coach",
  engineBusy: false,
  profileVersion: 0,
  allowed: ["new_game", "chat", "next_problem", "resign", "continue", "retry"],
  mistakeThreshold: 4,
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

  it("describes a practice problem: where it's from, the attempt, the last verdict and the answer once shown", () => {
    const problem: ProblemView = {
      id: "p4",
      prompt: "Black to play. Live.",
      source: { gameId: "g12", moveNumber: 14 },
      attempts: 1,
      solved: false,
      kind: "game",
      category: "life_and_death",
      toPlay: "B",
      maxAttempts: 2,
      revealed: false,
      box: 1,
      lastAttempt: { move: "C7", correct: false, pointLoss: 5.2 },
    };
    expect(problemLines(problem)).toEqual([
      "problem p4 life_and_death (from g12 move 14, box 1) B to play, attempt 2 of 2: Black to play. Live.",
      "last attempt C7 wrong, lost 5.2",
    ]);
    const shown = { ...problem, attempts: 2, revealed: true, answer: { move: "D5", pv: ["D5", "E4"] } };
    expect(problemLines(shown)[2]).toBe("answer D5 (pv D5 E4)");
    const v = view({ gameId: null, mode: "problem", status: "finished", moves: [], moment: null, problem: shown });
    expect(formatState(v)).toContain("problem p4 life_and_death (from g12 move 14, box 1) B to play, answer shown: Black to play. Live.");
    expect(statusLine(v)).toBe("problem=p4 mode=problem status=finished level=coach attempts=2/2 answer shown (D5)");
  });

  it("handles an idle server", () => {
    const text = formatState(view({ gameId: null, mode: "idle", settings: null, status: "playing", board: [], moves: [], moment: null, overlay: null, chat: [] }));
    expect(text).toContain("no game mode=idle");
    expect(text).toContain("moves: none");
    expect(text).toContain("moment: none");
    expect(text).toContain("chat: empty");
  });

  it("says after resume when the pause now waits for the learner", () => {
    const awaiting = view({ moment: { id: "m3", moveNumber: 3, pointLoss: 6.2, state: "tutor", awaitingLearner: true } });
    const out = commandOutput({ type: "resume" }, awaiting).split("\n");
    expect(out[0]).toBe(
      "ok game=g12 mode=game status=paused level=coach threshold=4 toPlay=W moves=3 moment m3 move 3 lost 6.2 state=tutor (you resumed; still paused with the drawing, waiting for the learner to press Continue)",
    );
    expect(out[1]).toMatch(/^still paused: your drawing stays on the board until the learner presses Continue/);
    // Other commands, and a resume that ended the pause, print the status only.
    expect(commandOutput({ type: "say", text: "hi" }, awaiting)).toBe(out[0]);
    expect(commandOutput({ type: "resume" }, view({ status: "playing", moment: { id: "m3", moveNumber: 3, pointLoss: 6.2, state: "resolved" } }))).toBe(
      "ok game=g12 mode=game status=playing level=coach threshold=4 toPlay=W moves=3",
    );
    expect(formatState(awaiting)).toContain("tutor level coach: full coaching");
    expect(formatState(awaiting)).toContain("waiting for the learner to press Continue");
  });

  it("resume --json says whether the game is still paused for the learner", () => {
    const awaiting = view({ moment: { id: "m3", moveNumber: 3, pointLoss: 6.2, state: "tutor", awaitingLearner: true } });
    const json = JSON.parse(commandJson({ type: "resume" }, awaiting)) as Record<string, unknown>;
    expect(json).toMatchObject({ status: "paused", stillPaused: true, moment: { awaitingLearner: true } });
    const ended = view({ status: "playing", moment: { id: "m3", moveNumber: 3, pointLoss: 6.2, state: "resolved" } });
    expect(JSON.parse(commandJson({ type: "resume" }, ended))).toMatchObject({ status: "playing", stillPaused: false });
    // Other commands print the view as it is.
    expect(commandJson({ type: "say", text: "hi" }, awaiting)).toBe(JSON.stringify(awaiting));
  });

  it("shows the mistake threshold on the game's board in state and the status line", () => {
    // 6.2 is a mistake on 9×9 (threshold 4) but not on 19×19 (8): no "!" there.
    const nine = view({ mistakeThreshold: 4 });
    expect(formatState(nine)).toContain("mistake threshold 4 pts on 9×9 (a move losing this much or more is a teaching moment)");
    expect(formatState(nine)).toContain("3 B C3 -6.2!");
    expect(statusLine(nine)).toContain(" level=coach threshold=4 toPlay=W ");
    const big = view({ settings: { ...settings, size: 19 }, board: emptyBoard(19), mistakeThreshold: 8, moment: null });
    expect(formatState(big)).toContain("mistake threshold 8 pts on 19×19");
    expect(formatState(big)).toContain("3 B C13 -6.2\n");
    expect(statusLine(big)).toContain(" threshold=8 ");
    expect(statusLine(view({ settings: { ...settings, size: 13 }, mistakeThreshold: 6.75 }))).toContain(" threshold=6.75 ");
    // Outside a game (a problem on the board) the threshold isn't shown.
    expect(statusLine(view({ mode: "problem" }))).not.toContain("threshold");
  });

  it("statusLine is a single line", () => {
    expect(statusLine(view({ moment: { id: "m3", moveNumber: 3, pointLoss: 6.2, state: "tutor" } }))).toBe(
      "game=g12 mode=game status=paused level=coach threshold=4 toPlay=W moves=3 moment m3 move 3 lost 6.2 state=tutor",
    );
  });
});


describe("summary and review", () => {
  const profile = (over: Partial<Profile> = {}): Profile => ({
    botRank: "18k",
    rating: 11.6,
    handicap: 0,
    ratingHistory: [
      { ts: 1, gameId: "g10", rating: 10.4, botRank: "20k", won: true, delta: 0.4 },
      { ts: 2, gameId: "g11", rating: 11.6, botRank: "19k", won: true, handicap: 0, delta: 1.2 },
    ],
    mistakeThreshold: 4,
    thresholdHistory: [{ ts: 2, gameId: "g11", from: 4.5, to: 4, reason: "average loss 1.2 pts per move over the last 3 games" }],
    mistakeCounts: { life_and_death: 3, capturing_race: 0, opening: 1, direction: 0, shape: 5, endgame: 0, tactics: 0, other: 0 },
    recentMistakes: [
      { ts: 3, gameId: "g11", moveNumber: 14, category: "shape", pointLoss: 6.2, note: "empty triangle" },
      { ts: 2, gameId: "g11", moveNumber: 9, category: "shape", pointLoss: 5 },
      { ts: 1, gameId: "g7", moveNumber: 20, category: "life_and_death", pointLoss: 9 },
    ],
    recentGames: ["g7", "g8", "g9", "g10", "g11"].map((gameId, i) => ({ ts: i, gameId, size: 9, humanMoves: 30, avgPointLoss: 2, mistakes: 1, threshold: 4 })),
    practiced: {},
    gamesPlayed: 11,
    problemsSolved: 2,
    tutorLevel: "coach",
    ...over,
  });

  it("formats a profile with the rating trend, bot, threshold, category trends and focus", () => {
    const text = formatProfile(profile(), { category: "shape", reason: "shape keeps costing points.", suggestion: "problems" });
    expect(text.split("\n")).toEqual([
      "rank estimate 18k (rating 11.6, trend +1.6 over the last 2 rated games), games 11, problems solved 2",
      "bot plays 18k",
      "tutor level coach: full coaching: say, show, mark, and rethink to let them find the move",
      "mistake threshold 4 pts on 9×9 (6 on 13×13, 8 on 19×19) (last changed 4.5 -> 4 after g11: average loss 1.2 pts per move over the last 3 games)",
      "recent rated games: g10 won vs 20k (+0.4), g11 won vs 19k (+1.2)",
      "mistakes by category (total, in the last 3 games): shape 5 (2, rising), life_and_death 3 (0, falling), opening 1 (0, steady)",
      "recent mistakes:",
      '  g11 move 14 shape -6.2 "empty triangle"',
      "  g11 move 9 shape -5",
      "  g7 move 20 life_and_death -9",
      "recommended focus: shape, as practice problems — shape keeps costing points.",
    ]);
  });

  it("mentions handicap stones while the learner is below 20k", () => {
    const text = formatProfile(profile({ botRank: "20k", rating: 7, handicap: 2, ratingHistory: [], thresholdHistory: [] }));
    expect(thresholdText(4.5)).toBe("4.5 pts on 9×9 (6.75 on 13×13, 9 on 19×19)");
    expect(thresholdText(2)).toBe("2 pts on 9×9 (3 on 13×13, 4 on 19×19)");
    expect(text).toContain("bot plays 20k, learner takes 2 handicap stones on 9x9 (rating below 20k, the weakest bot)");
    expect(text).toContain("mistake threshold 4 pts on 9×9 (6 on 13×13, 8 on 19×19)\n");
  });

  const NOW = 1_000_000_000;
  const item = (over: Partial<ProblemListItem>): ProblemListItem => ({
    id: "p1",
    kind: "game",
    size: 9,
    category: "life_and_death",
    toPlay: "B",
    prompt: "Black to play.",
    answers: ["D5"],
    box: 1,
    due: NOW,
    isDue: true,
    seen: 0,
    solves: 0,
    ...over,
  });
  const problemsBody = (problems: ProblemListItem[]): ProblemsResponse => ({
    problems,
    counts: {
      total: problems.length,
      due: problems.filter((p) => p.isDue).length,
      fromGames: problems.filter((p) => p.kind === "game").length,
      generated: problems.filter((p) => p.kind === "generated").length,
      byBox: [problems.length, 0, 0, 0, 0],
      dueByCategory: { life_and_death: 1, tactics: 1 },
    },
    focus: { category: "life_and_death", reason: "", suggestion: "problems" },
  });

  const generated = { batchId: "batch1", difficultyRank: "17k", weakerRank: "20k", strongerRank: "15k" };

  it("summarizes practice problems: counts, boxes and the next due", () => {
    const body = problemsBody([
      item({ source: { gameId: "g3", moveNumber: 9 }, difficulty: 6.2 }),
      item({ id: "gen3", kind: "generated", size: 13, generated, category: "tactics", seen: 2, solves: 1, lastResult: "failed" }),
      item({ id: "p2", source: { gameId: "g3", moveNumber: 15 }, due: NOW + 3 * 3_600_000, isDue: false }),
    ]);
    expect(formatProblems(body, NOW)).toBe(
      [
        "practice problems: 3 (2 from the learner's games, 1 generated), 2 due now (life_and_death 1, tactics 1); boxes 1:3 2:0 3:0 4:0 5:0",
        'next due (the first is what "problem" starts):',
        "  p1 life_and_death from g3 move 9 (lost 6.2) box 1 due now",
        "  gen3 tactics generated 13x13, difficulty 17k, batch1 box 1 due now solved 1/2 last failed",
      ].join("\n"),
    );
    expect(formatProblems(problemsBody([item({ due: NOW + 60_000, isDue: false })]), NOW)).toContain('nothing is due; "problem" still starts the one due soonest');
    expect(formatProblems(problemsBody([]), NOW)).toContain("nothing is due\n".trim());
  });

  it("adds problem generation to the summary: the batch in progress, or how close the next one is", () => {
    const batch = {
      id: "batch2",
      number: 2,
      weakerRank: "17k",
      strongerRank: "12k",
      trigger: "mastery" as const,
      found: 7,
      target: 20,
      sizes: [
        { size: 9 as const, found: 3, target: 7, games: 3, minutes: 4.5 },
        { size: 13 as const, found: 2, target: 6, games: 1, minutes: 6 },
        { size: 19 as const, found: 2, target: 7, games: 1, minutes: 9 },
      ],
      band: "17k–13k",
      createdAt: 0,
    };
    const last = { ...batch, id: "batch1", number: 1, weakerRank: "20k", strongerRank: "15k", trigger: "first" as const, found: 20, band: "20k–16k", finishedAt: 0 };
    const running: GenerationStatus = { state: "generating", current: batch, last: { ...last, problems: 20, mastered: 16, needed: 15 }, batches: 1 };
    const body = { ...problemsBody([]), generation: running };
    expect(formatProblems(body, NOW).split("\n").slice(1, 3)).toEqual([
      "problem generation: batch2 (17k vs 12k): 7/20 (9x9 3/7, 13x13 2/6, 19x19 2/7), generating now; difficulty band 17k–13k; new problems join practice as they're found",
      "last generated batch: batch1 (20k vs 15k), 20 problems, difficulty band 20k–16k",
    ]);
    const idle: GenerationStatus = { state: "idle", current: null, last: { ...last, problems: 20, mastered: 9, needed: 15 }, batches: 1 };
    expect(generationLines(idle)).toEqual(["last generated batch: batch1 (20k vs 15k), 20 problems, difficulty band 20k–16k; the next batch starts at 15 mastered (box 3+): 9/15"]);
    expect(generationLines({ state: "idle", current: null, last: null, batches: 0 })).toEqual(["problem generation: no batch yet (the first starts once KataGo is ready)"]);
    expect(formatGeneration(running).split("\n")).toEqual([
      "problem generation: batch2 (17k vs 12k): 7/20 (9x9 3/7, 13x13 2/6, 19x19 2/7), generating now; difficulty band 17k–13k; new problems join practice as they're found",
      "last generated batch: batch1 (20k vs 15k), 20 problems, difficulty band 20k–16k",
      "  time so far: 9x9 4.5 min (3 games), 13x13 6 min (1 game), 19x19 9 min (1 game); 19.5 min in all",
      `  batch1 took: 9x9 4.5 min (3 games), 13x13 6 min (1 game), 19x19 9 min (1 game); 19.5 min in all, finished ${new Date(0).toLocaleString()}`,
      "finished batches: 1",
    ]);
  });

  it("lists every problem with its answers and due time", () => {
    const text = formatProblemList(
      problemsBody([item({ source: { gameId: "g3", moveNumber: 9 } }), item({ id: "gen2", kind: "generated", generated, answers: ["E5", "F5"], due: NOW + 2 * 86_400_000, isDue: false })]),
      NOW,
    );
    expect(text.split("\n")).toEqual([
      "problems: 2, 1 due; focus life_and_death (next_problem prefers it, then the learner's own, then generated)",
      "  p1 life_and_death from g3 move 9 box 1 due now answers D5",
      "  gen2 life_and_death generated 9x9, difficulty 17k, batch1 box 1 due in 2d answers E5,F5",
      "start one with: problem <id> (or problem for the next due)",
    ]);
    expect([dueText(NOW + 30_000, NOW), dueText(NOW + 5 * 3_600_000, NOW), dueText(NOW - 1, NOW)]).toEqual(["in 1m", "in 5h", "now"]);
  });

  it("finds the win-rate swings of both sides, biggest first, shown in move order", () => {
    const moves = view().moves;
    expect(winrateSwings(moves, "B").map((s) => [s.record.number, s.from, s.to])).toEqual([
      [1, 0.6, 0.3],
      [2, 0.3, 0.6],
      [3, 0.6, 0.3],
    ]);
    expect(winrateSwings(moves, "B", 1)).toHaveLength(1);
  });

  it("formats a compact review", () => {
    const text = formatReview({
      id: "g12",
      settings,
      moves: view().moves,
      result: { winner: "W", margin: -3.5, reason: "score" },
      summary: {
        moves: 3,
        totalPointLoss: 6.5,
        mistakes: [{ moveNumber: 3, move: "C3", pointLoss: 6.2, bestMove: "D5", category: "shape", categorySource: "heuristic" }],
        rating: { before: 10, after: 11.5, rated: true, nextBotRank: "18k", nextHandicap: 0 },
      },
    });
    const lines = text.split("\n");
    expect(lines.slice(0, 9)).toEqual([
      "game g12 9x9 komi 7 human=B bot=20k result W+3.5 moves 3",
      "rating 10 -> 11.5 (+1.5, rank 18k); next bot 18k",
      "mistakes (1, worst first, total loss 6.5):",
      "  move 3 B C3 -6.2 best D5 [shape, heuristic] pv D5 E4 C6",
      "  confirm or correct categories with: tag g12 <move#> <category> [note]",
      "win-rate swings (learner's win rate):",
      "  move 1 B E5 60% -> 30% (-30)",
      "  move 2 W C7 (bot) 30% -> 60% (+30)",
      "  move 3 B C3 60% -> 30% (-30)",
    ]);
    expect(lines[9]).toBe("board before move 3 (B played C3, best D5):");
    expect(text).toContain("(O)"); // the board before move 3 ends with White's C7
    expect(lines.slice(-2)).toEqual(["moves (human loss in pts, ! = mistake):", "1 B E5 -0.3 | 2 W C7 | 3 B C3 -6.2!"]);
  });

  it("reviews with the threshold the game was played with on its board", () => {
    const big = { ...settings, size: 19 as const };
    const moves = view().moves; // the learner's C13 lost 6.2
    const p = { ...defaultProfile(), recentGames: [{ ts: 0, gameId: "old", size: 19 as const, humanMoves: 2, avgPointLoss: 3, mistakes: 1, threshold: 4 }] };
    const summary = { moves: 3, totalPointLoss: 6.5, mistakes: [] };
    // A game saved with its own threshold uses it.
    expect(reviewThreshold({ id: "new", settings: big, summary: { ...summary, threshold: 8 } }, p)).toBe(8);
    // An older finished game used the profile's threshold unscaled on every size.
    expect(reviewThreshold({ id: "old", settings: big, summary }, p)).toBe(4);
    expect(reviewThreshold({ id: "older", settings: big, summary }, { ...p, mistakeThreshold: 3.5 })).toBe(3.5);
    // An unfinished game: the profile's threshold on its board.
    expect(reviewThreshold({ id: "now", settings: big }, p)).toBe(8);
    expect(reviewThreshold({ id: "now", settings: { ...settings, size: 13 } }, p)).toBe(6);
    expect(reviewThreshold({ id: "now", settings: big }, null)).toBeUndefined();

    // Unfinished on 19×19: 6.2 is under 8, so it isn't a mistake; on 9×9 it is.
    const unfinished = formatReview({ id: "now", settings: big, moves }, reviewThreshold({ id: "now", settings: big }, p));
    expect(unfinished).toContain("mistakes: none");
    expect(unfinished).toContain("3 B C13 -6.2");
    expect(unfinished).not.toContain("-6.2!");
    expect(formatReview({ id: "now", settings: big, moves })).toContain("mistakes: none");
    // Without a profile, an older finished game defaults to the unscaled starting threshold, 4.
    expect(formatReview({ id: "old", settings: big, moves, summary })).toContain("3 B C13 -6.2!");
    expect(formatReview({ id: "old", settings: big, moves, summary }, reviewThreshold({ id: "old", settings: big, summary }, p))).toContain("3 B C13 -6.2!");
    expect(formatReview({ id: "new", settings: big, moves, summary: { ...summary, threshold: 8 } })).not.toContain("-6.2!");
  });

  it("reviews a game without a summary from its moves, and says when a game didn't count", () => {
    const text = formatReview({
      id: "g13",
      settings,
      moves: view().moves,
      summary: { moves: 3, totalPointLoss: 6.5, mistakes: [], rating: { before: 10, after: 10, rated: false, nextBotRank: "20k", nextHandicap: 2 } },
    });
    expect(text).toContain("rating unchanged at 10 (games under 10 moves don't count); next bot 20k with 2 handicap stones");
    expect(text).toContain("mistakes: none");
    const bare = formatReview({ id: "g14", settings, moves: view().moves });
    expect(bare).toContain("  move 3 B C3 -6.2 best D5 [untagged] pv D5 E4 C6");
  });

  it("reviews first attempts, help and the rank estimate", () => {
    const moves = view().moves.map((r) => (r.number === 3 ? { ...r, assist: ["rethink" as const] } : r));
    const firstTry = { ...moves[2]!, move: { color: "B" as const, point: { x: 8, y: 0 } }, assist: undefined };
    const estimate = { rating: 12, floor: false, moves: 30, hints: 1, takeBacks: 0, rethinks: 1 };
    const text = formatReview({
      id: "g15",
      settings,
      moves,
      takenBack: [{ moveNumber: 3, record: firstTry, by: "tutor", ts: 0, before: ["E5", "C7"], heuristic: "direction" }],
      summary: {
        moves: 3,
        totalPointLoss: 15.5,
        mistakes: [{ moveNumber: 3, move: "J9", pointLoss: 9, bestMove: "D5", category: "direction", categorySource: "heuristic", takenBack: 0 }],
        assistance: { hints: 1, takeBacks: 0, rethinks: 1 },
        rating: { before: 10, after: 11.6, rated: true, nextBotRank: "18k", nextHandicap: 0, estimate },
      },
    });
    const lines = text.split("\n");
    expect(lines[1]).toBe("rank estimate 18k from 30 unassisted moves (1 hint, 1 tutor take-back); rating 10 -> 11.6 (+1.6, rank 18k); next bot 18k");
    expect(lines[2]).toBe("help: 1 hint, 1 tutor take-back; moves played with help (* below, left out of the rank estimate): 3 rethink");
    expect(text).toContain("  move 3 (first try #1, taken back by the tutor) B J9 -9 best D5 [direction, heuristic]");
    expect(text).toContain("tag g15 <move#> <category> [note] (add --taken-back <n> for first try #n)");
    // The board before the first attempt, from its own line.
    expect(text).toContain("board before move 3 (first try #1, taken back by the tutor) (B played J9, best D5):");
    expect(lines.slice(-2)).toEqual(["moves (human loss in pts, ! = mistake, * = played with help):", "1 B E5 -0.3 | 2 W C7 | 3 B C3 -6.2!*"]);
    expect(formatReview({ id: "g16", settings, moves, summary: { moves: 3, totalPointLoss: 0, mistakes: [], rating: { before: 10, after: 10, rated: true, pending: true, nextBotRank: "20k", nextHandicap: 0 } } })).toContain(
      "rank estimate running; rating 10 for now",
    );
  });

  it("shows the latest rank estimate and taken-back mistakes in the summary", () => {
    const estimate = { rating: 10, floor: true, moves: 29, hints: 2, takeBacks: 3, rethinks: 6 };
    const p: Profile = {
      ...defaultProfile(),
      rating: 11.2,
      ratingModel: 2,
      ratingHistory: [{ ts: 1, gameId: "g1", rating: 11.2, botRank: "18k", won: true, handicap: 0, delta: 1.2, estimate }],
      recentMistakes: [{ ts: 1, gameId: "g1", moveNumber: 9, category: "tactics", pointLoss: 8.8, takenBack: 0 }],
      mistakeCounts: { ...defaultProfile().mistakeCounts, tactics: 1 },
    };
    const text = formatProfile(p, null);
    expect(text).toContain("last game's estimate (g1): rank estimate 20k or weaker from 29 unassisted moves (2 hints, 3 take-backs, 6 tutor take-backs)");
    expect(text).toContain("recent rated games: g1 won vs 18k (+1.2 est 20k or weaker/29 moves)");
    expect(text).toContain("  g1 move 9 (first try, taken back) tactics -8.8");
    expect(formatProfile({ ...p, estimating: ["g2", "g3"] }, null)).toContain("rank estimate for g2, g3 still running");
    expect(formatProfile({ ...defaultProfile(), ratingModel: 2 }, null)).toContain("no rank estimate yet");
  });
});
