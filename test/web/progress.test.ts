import { describe, expect, it } from "vitest";
import { defaultProfile } from "../../src/server/store.ts";
import type { ChatMessage, GameView, ProblemView, TeachingMoment } from "../../src/shared/types.ts";
import { latestEstimate, nextBotText, panelAttention, ratingChangeFor, ratingSparkPoints, topCategories, unreadCount } from "../../web/src/geometry.ts";

describe("progress panel helpers", () => {
  it("draws higher ratings higher, with a minimum vertical range", () => {
    expect(ratingSparkPoints([], 300, 32)).toEqual([]);
    expect(ratingSparkPoints([10], 300, 32)).toEqual([{ x: 150, y: 16 }]);
    const [a, b] = ratingSparkPoints([10, 12], 300, 32);
    expect(a).toEqual({ x: 4, y: 28 });
    expect(b).toEqual({ x: 296, y: 4 });
    // A small change stays small: 0.2 ranks on a range of at least 2.
    const [c, d] = ratingSparkPoints([10, 10.2], 300, 32);
    expect(c!.y - d!.y).toBeCloseTo(2.4);
  });

  it("names the top mistake categories", () => {
    expect(topCategories({ shape: 2, life_and_death: 5, opening: 1, endgame: 0 })).toEqual(["life and death 5", "shape 2"]);
    expect(topCategories({ other: 0 })).toEqual([]);
  });

  it("describes the next bot and a game's rating change", () => {
    expect(nextBotText({ botRank: "18k", handicap: 0 })).toBe("18k");
    expect(nextBotText({ botRank: "20k", handicap: 3 })).toBe("20k +3 stones");
    const p = { ...defaultProfile(), ratingHistory: [{ ts: 1, gameId: "g1", rating: 11.5, botRank: "20k", won: true, delta: 1.5 }] };
    expect(ratingChangeFor(p, "g1")).toEqual({ before: "20k", after: "18k", delta: 1.5 });
    expect(ratingChangeFor(p, "g2")).toBeNull();
    expect(latestEstimate(p)).toBeNull();
  });

  it("describes a game's rank estimate and the help left out of it", () => {
    const estimate = { rating: 12.2, floor: false, moves: 34, hints: 3, takeBacks: 2, rethinks: 0 };
    const p = {
      ...defaultProfile(),
      ratingHistory: [
        { ts: 1, gameId: "g1", rating: 10, botRank: "20k", won: true, delta: 0, estimate: { ...estimate, rating: 10, floor: true, moves: 20, hints: 0, takeBacks: 0 } },
        { ts: 2, gameId: "g2", rating: 11.5, botRank: "20k", won: true, delta: 1.5, estimate },
      ],
    };
    expect(ratingChangeFor(p, "g2")).toEqual({ before: "20k", after: "18k", delta: 1.5, estimate: "Rank estimate 18k from 34 unassisted moves (3 hints, 2 take-backs)" });
    expect(ratingChangeFor(p, "g1")?.estimate).toBe("Rank estimate 20k or weaker from 20 unassisted moves");
    expect(latestEstimate(p)).toEqual({ short: "18k · 34 moves", long: "Last game: Rank estimate 18k from 34 unassisted moves (3 hints, 2 take-backs)." });
  });
});

describe("unread messages while the panels are hidden", () => {
  const msg = (id: string, ts: number, from: ChatMessage["from"]): ChatMessage => ({ id, ts, from, text: id });

  it("counts the tutor's and the server's messages since the panels were hidden, not the learner's", () => {
    // c and d share a millisecond: the order of the chat decides, not the clock.
    const chat = [msg("a", 1, "tutor"), msg("b", 2, "user"), msg("c", 3, "tutor"), msg("d", 3, "system"), msg("e", 5, "user")];
    expect(unreadCount(chat, "b")).toBe(2);
    expect(unreadCount(chat, "c")).toBe(1);
    expect(unreadCount(chat, "e")).toBe(0);
    // Hidden with an empty chat, or the seen message trimmed away: everything left is new.
    expect(unreadCount(chat, null)).toBe(3);
    expect(unreadCount(chat.slice(3), "b")).toBe(1);
    expect(unreadCount([], null)).toBe(0);
  });
});

describe("what brings the hidden panels back", () => {
  const moment = (over: Partial<TeachingMoment> = {}): TeachingMoment => ({ id: "t1", moveNumber: 13, pointLoss: 6, state: "waiting", ...over });
  const problem = (over: Partial<ProblemView> = {}) => ({ id: "p3", attempts: 0, revealed: false, ...over }) as ProblemView;
  const game = { mode: "game", problem: null, status: "paused", moment: null } as Pick<GameView, "moment" | "mode" | "problem" | "status">;

  it("is nothing in a game without an open moment", () => {
    expect(panelAttention(null)).toBeNull();
    expect(panelAttention(game)).toBeNull();
    expect(panelAttention({ ...game, moment: moment({ state: "resolved" }) })).toBeNull();
    expect(panelAttention({ ...game, status: "finished", moment: moment() })).toBeNull();
  });

  it("changes with each thing the learner has to act on", () => {
    const keys = [
      panelAttention({ ...game, moment: moment() }),
      panelAttention({ ...game, moment: moment({ state: "tutor" }) }),
      panelAttention({ ...game, moment: moment({ state: "tutor", awaitingLearner: true }) }),
      panelAttention({ ...game, moment: moment({ id: "t2" }) }),
      panelAttention({ ...game, mode: "problem", problem: problem() }),
      panelAttention({ ...game, mode: "problem", problem: problem({ attempts: 1 }) }),
      panelAttention({ ...game, mode: "problem", problem: problem({ attempts: 2, revealed: true }) }),
      panelAttention({ ...game, mode: "problem", problem: problem({ attempts: 2, revealed: true, playout: { line: [], cursor: 0, thinking: false, over: false } }) }),
      panelAttention({ ...game, mode: "problem", problem: problem({ attempts: 2, revealed: true, playout: { line: [], cursor: 4, thinking: false, over: true } }) }),
      panelAttention({ ...game, mode: "problem", problem: problem({ id: "p4" }) }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(null);
    // Stepping through a play-out isn't something new to act on.
    const step = (cursor: number) => panelAttention({ ...game, mode: "problem", problem: problem({ revealed: true, playout: { line: [], cursor, thinking: cursor % 2 === 1, over: false } }) });
    expect(step(3)).toBe(step(2));
  });
});
