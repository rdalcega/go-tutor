// Unit tests for src/server/katago.ts. They never need KataGo: the protocol tests run a small
// fake `katago` script that speaks the JSON analysis protocol.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  KATAGO_RULES,
  KataGo,
  chooseBotMove,
  moveEvalFrom,
  policyIndexToGtp,
  sideToMove,
  type Analysis,
  type Position,
} from "../../src/server/katago.ts";

const empty9: Position = { size: 9, komi: 7, moves: [], rules: "chinese" };

/** The position after one more move by the side to move. */
const playMove = (pos: Position, move: string): Position => ({ ...pos, moves: [...pos.moves, [sideToMove(pos), move]] });

describe("helpers", () => {
  it("maps policy indices to GTP (row 1 at the bottom, no I column)", () => {
    expect(policyIndexToGtp(0, 9)).toBe("A9");
    expect(policyIndexToGtp(8, 9)).toBe("J9");
    expect(policyIndexToGtp(40, 9)).toBe("E5");
    expect(policyIndexToGtp(72, 9)).toBe("A1");
    expect(policyIndexToGtp(81, 9)).toBe("pass");
    expect(policyIndexToGtp(18 * 19 + 18, 19)).toBe("T1");
  });

  it("works out the side to move", () => {
    expect(sideToMove(empty9)).toBe("B");
    expect(sideToMove({ ...empty9, initialStones: [["B", "C3"], ["B", "G7"]] })).toBe("W");
    expect(sideToMove({ ...empty9, initialPlayer: "W" })).toBe("W");
    expect(sideToMove(playMove(empty9, "E5"))).toBe("W");
    expect(playMove(playMove(empty9, "E5"), "C3").moves).toEqual([["B", "E5"], ["W", "C3"]]);
  });
});

describe("chooseBotMove", () => {
  const size = 3; // 9 points + pass
  const policy = (entries: Record<number, number>, fill = 0): number[] =>
    Array.from({ length: size * size + 1 }, (_, i) => entries[i] ?? fill);

  it("samples in proportion to human policy, ignoring entries under 1%", () => {
    // Index 0: 0.6, index 4: 0.3, index 8: 0.005 (ignored), others illegal.
    const humanPolicy = policy({ 0: 0.6, 4: 0.3, 8: 0.005, 9: 0.095 }, -1);
    const pick = (r: number) => chooseBotMove({ humanPolicy }, size, () => r);
    expect(pick(0)).toBe("A3");
    expect(pick(0.66)).toBe("A3"); // 0.66 * 0.9 = 0.594 < 0.6
    expect(pick(0.67)).toBe("B2");
    expect(pick(0.999)).toBe("B2");
  });

  it("passes when pass is the human policy's argmax", () => {
    const humanPolicy = policy({ 0: 0.2, 9: 0.7 }, -1);
    expect(chooseBotMove({ humanPolicy }, size, () => 0)).toBe("pass");
  });

  it("passes when the regular policy strongly prefers pass", () => {
    const humanPolicy = policy({ 0: 0.6, 9: 0.4 }, -1);
    expect(chooseBotMove({ humanPolicy, policy: policy({ 0: 0.3, 9: 0.7 }) }, size, () => 0)).toBe("pass");
    expect(chooseBotMove({ humanPolicy, policy: policy({ 0: 0.7, 9: 0.3 }) }, size, () => 0)).toBe("A3");
  });

  it("never samples pass otherwise, even with substantial pass mass", () => {
    const humanPolicy = policy({ 0: 0.45, 9: 0.4, 3: 0.15 }, -1);
    for (const r of [0, 0.5, 0.99]) expect(chooseBotMove({ humanPolicy }, size, () => r)).not.toBe("pass");
  });

  it("falls back to the most likely legal move when all are under 1%", () => {
    const humanPolicy = policy({ 2: 0.004, 5: 0.008, 9: 0.002 }, -1);
    expect(chooseBotMove({ humanPolicy }, size, () => 0.5)).toBe("C2");
  });

  it("passes when no board move is legal", () => {
    expect(chooseBotMove({ humanPolicy: policy({ 9: 1 }, -1) }, size)).toBe("pass");
  });

  it("requires humanPolicy", () => {
    expect(() => chooseBotMove({ policy: policy({}) }, size)).toThrow(/humanPolicy/);
  });
});

describe("moveEvalFrom", () => {
  const analysis = (toPlay: "B" | "W", scoreLead: number, winrate: number, moves: string[] = []): Analysis => ({
    id: "x",
    toPlay,
    rootInfo: { scoreLead, winrate, visits: 100 },
    moveInfos: moves.map((move, order) => ({
      move,
      scoreLead: scoreLead - order,
      winrate: winrate - order / 100,
      visits: 50 - order,
      order,
      prior: 0.1,
      pv: [move, "D4"],
    })),
  });

  it("reports from the mover's perspective and flips the after-position", () => {
    const before = analysis("B", 1.5, 0.6, ["E5", "D5", "C5", "F5", "E4", "E6"]);
    const after = analysis("W", 10, 0.9); // White now leads by 10
    const ev = moveEvalFrom(before, after);
    expect(ev.leadBefore).toBe(1.5);
    expect(ev.leadAfter).toBe(-10);
    expect(ev.pointLoss).toBe(11.5);
    expect(ev.winrateBefore).toBe(0.6);
    expect(ev.winrateAfter).toBeCloseTo(0.1);
    expect(ev.bestMove).toBe("E5");
    expect(ev.bestPv).toEqual(["E5", "D4"]);
    expect(ev.candidates).toHaveLength(5);
    expect(ev.candidates[1]).toEqual({ move: "D5", lead: 0.5, winrate: 0.59, visits: 49, pv: ["D5", "D4"] });
  });

  it("clamps gains to zero point loss", () => {
    expect(moveEvalFrom(analysis("W", -2, 0.3), analysis("B", 1, 0.6)).pointLoss).toBe(0);
  });

  it("rejects mismatched positions", () => {
    expect(() => moveEvalFrom(analysis("B", 0, 0.5), analysis("B", 0, 0.5))).toThrow();
  });
});

// A fake `katago analysis` process. Behaviour by query content:
//   moves include "ERR"  -> error response
//   moves include "WARN" -> a warning line, then a normal response
//   FAKE_KATAGO=crash    -> exits before becoming ready
//   moves include "DIE"  -> exits mid-query
// rootInfo.visits reports the most queries the fake has seen in flight at once.
const FAKE = String.raw`#!/usr/bin/env node
if (process.env.FAKE_KATAGO === "crash") {
  process.stderr.write("Loading model...\nError: could not load model\n");
  process.exit(2);
}
process.stderr.write("Loading model...\nStarted, ready to begin handling requests\n");
let outstanding = 0, maxOutstanding = 0, buf = "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const q = JSON.parse(line);
    const flat = JSON.stringify(q.moves);
    if (flat.includes("DIE")) process.exit(3);
    if (flat.includes("ERR")) { send({ id: q.id, error: "Illegal move", field: "moves" }); continue; }
    if (flat.includes("WARN")) send({ id: q.id, warning: "Unused field", field: "bogus" });
    outstanding++; maxOutstanding = Math.max(maxOutstanding, outstanding);
    const n = q.moves.length;
    const toPlay = n ? (q.moves[n - 1][0] === "B" ? "W" : "B") : (q.initialPlayer || "B");
    const delay = q.moves.length === 1 ? 60 : 15; // one-move queries finish last
    setTimeout(() => {
      outstanding--;
      const size = q.boardXSize * q.boardYSize;
      const res = {
        id: q.id, isDuringSearch: false, turnNumber: n,
        rootInfo: { scoreLead: 2, winrate: 0.7, visits: maxOutstanding, currentPlayer: toPlay },
        moveInfos: [
          { move: "D4", scoreLead: 1, winrate: 0.6, visits: 3, order: 1, prior: 0.2, pv: ["D4"] },
          { move: "E5", scoreLead: 2, winrate: 0.7, visits: 9, order: 0, prior: 0.5, pv: ["E5", "C3"] },
        ],
        echo: { moves: q.moves, priority: q.priority ?? 0, override: q.overrideSettings ?? null },
      };
      if (q.includeOwnership) res.ownership = Array(size).fill(0.5);
      if (q.includePolicy) {
        res.policy = Array(size + 1).fill(0.001);
        res.humanPolicy = Array(size + 1).fill(-1);
        res.humanPolicy[q.overrideSettings?.humanSLProfile === "rank_1d" ? 40 : 0] = 1;
      }
      send(res);
    }, delay);
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 50));
`;

describe("KataGo process wrapper (fake engine)", () => {
  const dir = mkdtempSync(join(tmpdir(), "go-tutor-katago-"));
  const binary = join(dir, "katago");
  writeFileSync(binary, FAKE);
  chmodSync(binary, 0o755);
  for (const f of ["analysis.cfg", "main.bin.gz", "human.bin.gz"]) writeFileSync(join(dir, f), "");
  const logs: string[] = [];
  const make = (concurrency = 2) =>
    new KataGo({
      binary,
      config: join(dir, "analysis.cfg"),
      model: join(dir, "main.bin.gz"),
      humanModel: join(dir, "human.bin.gz"),
      concurrency,
      onLog: (l) => logs.push(l),
      random: () => 0,
    });
  let kg: KataGo | null = null;

  afterEach(async () => {
    delete process.env.FAKE_KATAGO;
    await kg?.stop();
    kg = null;
    logs.length = 0;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("starts, forwards stderr and normalizes analyses", async () => {
    kg = make();
    expect(kg.ready).toBe(false);
    await kg.start();
    expect(kg.ready).toBe(true);
    expect(logs).toContain("Loading model...");

    const a = await kg.analyze(playMove(empty9, "E5"), { includeOwnership: true });
    expect(a.toPlay).toBe("W");
    expect(a.moveInfos.map((m) => m.move)).toEqual(["E5", "D4"]); // sorted by order
    expect(a.ownership).toHaveLength(81);
    expect(a.ownership![0]).toBe(-0.5); // flipped to Black's view
    const b = await kg.analyze(empty9, { includeOwnership: true });
    expect(b.ownership![0]).toBe(0.5);
  });

  it("matches out-of-order responses by id and caps concurrency", async () => {
    kg = make(2);
    await kg.start();
    const positions = [playMove(empty9, "C3"), empty9, playMove(playMove(empty9, "C3"), "D4"), empty9, empty9];
    const results = await Promise.all(positions.map((p) => kg!.analyze(p)));
    expect(results.map((r) => r.toPlay)).toEqual(["W", "B", "B", "B", "B"]);
    expect(Math.max(...results.map((r) => r.rootInfo.visits))).toBe(2);
    expect(kg.pending).toBe(0);
  });

  it("rejects a query KataGo reports as an error and keeps going", async () => {
    kg = make();
    await kg.start();
    await expect(kg.analyze({ ...empty9, moves: [["B", "ERR"]] })).rejects.toThrow(/Illegal move \(field moves\)/);
    await expect(kg.analyze(empty9)).resolves.toMatchObject({ toPlay: "B" });
  });

  it("logs warnings and still returns the response", async () => {
    kg = make();
    await kg.start();
    const a = await kg.analyze({ ...empty9, moves: [["B", "WARN"]] });
    expect(a.toPlay).toBe("W");
    expect(logs.some((l) => l.includes("Unused field"))).toBe(true);
  });

  it("asks for the human profile and samples the bot move from humanPolicy", async () => {
    kg = make();
    await kg.start();
    expect(await kg.botMove(empty9, "20k")).toBe("A9");
    expect(await kg.botMove(empty9, "1d")).toBe("E5");
  });

  it("evaluates a move from the analyses before and after it", async () => {
    kg = make();
    await kg.start();
    const ev = moveEvalFrom(await kg.analyze(empty9), await kg.analyze(playMove(empty9, "A1")));
    // Fake always says the side to move leads by 2: before +2 for Black, after -2 for Black.
    expect(ev).toMatchObject({ leadBefore: 2, leadAfter: -2, pointLoss: 4, bestMove: "E5", bestPv: ["E5", "C3"] });
    expect(ev.winrateAfter).toBeCloseTo(0.3);
  });

  it("fails start() with the engine's output when it exits early", async () => {
    process.env.FAKE_KATAGO = "crash";
    kg = make();
    await expect(kg.start()).rejects.toThrow(/exited \(code 2.*could not load model/s);
    expect(kg.ready).toBe(false);
  });

  it("rejects pending queries and reports a crash after start", async () => {
    const exits: Error[] = [];
    kg = new KataGo({
      binary,
      config: join(dir, "analysis.cfg"),
      model: join(dir, "main.bin.gz"),
      humanModel: join(dir, "human.bin.gz"),
      onExit: (e) => exits.push(e),
    });
    await kg.start();
    const pending = kg.analyze(playMove(empty9, "C3"));
    await expect(kg.analyze({ ...empty9, moves: [["B", "DIE"]] })).rejects.toThrow(/exited \(code 3/);
    await expect(pending).rejects.toThrow(/exited/);
    expect(exits).toHaveLength(1);
    expect(kg.ready).toBe(false);
    await expect(kg.analyze(empty9)).rejects.toThrow(/not running/);
  });

  it("rejects queries queued during startup when the binary can't be launched", async () => {
    const notExecutable = join(dir, "katago-noexec");
    writeFileSync(notExecutable, "");
    chmodSync(notExecutable, 0o644);
    kg = new KataGo({ binary: notExecutable, config: join(dir, "analysis.cfg"), model: join(dir, "main.bin.gz"), humanModel: join(dir, "human.bin.gz") });
    const started = kg.start();
    await null; // launch() has spawned; the spawn error arrives on a later tick
    const queued = kg.analyze(empty9);
    await expect(started).rejects.toThrow(/Could not launch KataGo/);
    await expect(queued).rejects.toThrow(/Could not launch KataGo/);
    expect(kg.pending).toBe(0);
  });

  it("sends rules with positional superko, to match the local rules engine", () => {
    expect(KATAGO_RULES.chinese).toMatchObject({ ko: "POSITIONAL", scoring: "AREA", suicide: false });
  });

  it("explains missing files", async () => {
    await expect(new KataGo({ binary, config: join(dir, "nope.cfg") }).start()).rejects.toThrow(/setup:katago/);
  });
});
