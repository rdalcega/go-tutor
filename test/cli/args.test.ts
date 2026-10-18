import { describe, expect, it } from "vitest";
import { parseInvocation, UsageError } from "../../src/cli/args.ts";

const cmd = (argv: string[]) => {
  const inv = parseInvocation(argv);
  if (inv.kind !== "command") throw new Error(`expected command, got ${inv.kind}`);
  return inv.command;
};
const usage = (argv: string[]) => expect(() => parseInvocation(argv)).toThrow(UsageError);

describe("parseInvocation", () => {
  it("defaults to help", () => {
    expect(parseInvocation([])).toEqual({ kind: "help" });
    expect(parseInvocation(["help"]).kind).toBe("help");
    expect(parseInvocation(["say", "--help"]).kind).toBe("help");
  });

  it("parses read commands", () => {
    expect(parseInvocation(["watch"])).toEqual({ kind: "watch", json: false });
    expect(parseInvocation(["watch", "--since", "41"])).toEqual({ kind: "watch", since: 41, json: false });
    expect(parseInvocation(["watch", "--since=7", "--json"])).toEqual({ kind: "watch", since: 7, json: true });
    expect(parseInvocation(["state", "--json"])).toEqual({ kind: "state", json: true });
    expect(parseInvocation(["review"])).toEqual({ kind: "review", gameId: "last", json: false });
    expect(parseInvocation(["review", "g12"])).toEqual({ kind: "review", gameId: "g12", json: false });
    expect(parseInvocation(["generate"])).toEqual({ kind: "generate", now: false, json: false });
    expect(parseInvocation(["generate", "--status", "--json"])).toEqual({ kind: "generate", now: false, json: true });
    expect(parseInvocation(["generate", "--now"])).toEqual({ kind: "generate", now: true, json: false });
    expect(() => parseInvocation(["generate", "--now", "--status"])).toThrow(/not both/);
    expect(() => parseInvocation(["generate", "batch2"])).toThrow(/takes no arguments/);
    expect(() => parseInvocation(["generate", "--soon", "1"])).toThrow(/unknown option --soon/);
    expect(parseInvocation(["problems", "--json"])).toEqual({ kind: "problems", json: true });
    expect(() => parseInvocation(["problems", "p4"])).toThrow(/takes no arguments/);
  });

  it("joins say/rethink text and takes --moment", () => {
    expect(cmd(["say", "Look", "at", "D5"])).toEqual({ type: "say", text: "Look at D5" });
    expect(cmd(["say", "Why C3?", "--moment", "m3"])).toEqual({ type: "say", text: "Why C3?", momentId: "m3" });
    expect(cmd(["rethink", "Try again"])).toEqual({ type: "rethink", text: "Try again" });
    expect(cmd(["say", "--", "--not a flag"])).toEqual({ type: "say", text: "--not a flag" });
  });

  it("parses show and mark with validated coordinates", () => {
    expect(cmd(["show", "d5", "E4", "pass", "--label", "Better", "--start", "w"])).toEqual({
      type: "show",
      moves: ["D5", "E4", "pass"],
      label: "Better",
      start: "W",
    });
    expect(cmd(["mark", "E5", "F5", "--kind", "triangle", "--text", "weak"])).toEqual({
      type: "mark",
      points: ["E5", "F5"],
      kind: "triangle",
      text: "weak",
    });
    usage(["show", "I5"]);
    usage(["show", "D20"]);
    usage(["mark", "pass"]);
    usage(["mark", "D4", "--kind", "star"]);
  });

  it("parses simple commands", () => {
    expect(cmd(["clear"])).toEqual({ type: "clear" });
    expect(cmd(["resume"])).toEqual({ type: "resume" });
    expect(cmd(["claim", "m3"])).toEqual({ type: "claim", momentId: "m3" });
    expect(cmd(["problem"])).toEqual({ type: "start_problem" });
    expect(cmd(["problem", "p4"])).toEqual({ type: "start_problem", problemId: "p4" });
  });

  it("parses new-game settings", () => {
    expect(cmd(["new-game"])).toEqual({ type: "new_game" });
    expect(cmd(["new-game", "--size", "13", "--rank", "18K", "--color", "W", "--komi", "6.5", "--handicap", "2"])).toEqual({
      type: "new_game",
      settings: { size: 13, botRank: "18k", humanColor: "W", komi: 6.5, handicap: 2 },
    });
    usage(["new-game", "--size", "10"]);
    usage(["new-game", "--rank", "40k"]);
    // KataGo's human-SL profiles stop at 20k, and the server rejects weaker ranks the same way.
    usage(["new-game", "--rank", "25k"]);
    expect(cmd(["new-game", "--rank", "20k"])).toEqual({ type: "new_game", settings: { botRank: "20k" } });
    usage(["new-game", "--color", "red"]);
  });

  it("parses tag", () => {
    expect(cmd(["tag", "g12", "14", "shape", "empty", "triangle"])).toEqual({
      type: "tag",
      gameId: "g12",
      moveNumber: 14,
      category: "shape",
      note: "empty triangle",
    });
    usage(["tag", "g12", "14", "laziness"]);
    usage(["tag", "g12", "x", "shape"]);
    usage(["tag", "g12"]);
    // A taken-back first attempt at that move.
    expect(cmd(["tag", "g12", "14", "shape", "--taken-back", "too", "slow"])).toEqual({
      type: "tag",
      gameId: "g12",
      moveNumber: 14,
      category: "shape",
      note: "too slow",
      takenBack: true,
    });
    usage(["tag", "g12", "14", "shape", "--taken-back=yes"]);
    // A numbered try (review's "first try #2"), as the next token or with =.
    expect(cmd(["tag", "g12", "14", "shape", "--taken-back", "2", "too", "slow"])).toMatchObject({ moveNumber: 14, note: "too slow", takenBack: 2 });
    expect(cmd(["tag", "g12", "14", "shape", "--taken-back=1"])).toMatchObject({ takenBack: 1 });
    expect(cmd(["tag", "g12", "14", "--taken-back", "shape"])).toMatchObject({ category: "shape", takenBack: true });
    usage(["tag", "g12", "14", "shape", "--taken-back", "0"]);
  });

  it("rejects bad usage", () => {
    usage(["frobnicate"]);
    usage(["say"]);
    usage(["claim"]);
    usage(["claim", "m1", "m2"]);
    usage(["state", "extra"]);
    usage(["state", "--bogus", "1"]);
    usage(["watch", "--since"]);
    usage(["watch", "--since", "-1"]);
  });
});
