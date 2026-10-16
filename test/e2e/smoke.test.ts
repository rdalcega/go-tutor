// End-to-end smoke test against real KataGo: the server, the HTTP API and the tutor CLI together.
// Skips when KataGo isn't installed/configured. Slow: KataGo startup alone is 30-70 s.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveKataGoPaths } from "../../src/server/katago.ts";
import type { GameView } from "../../src/shared/types.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const run = promisify(execFile);

function hasKataGo(): boolean {
  try {
    resolveKataGoPaths();
    return true;
  } catch {
    return false;
  }
}

/** Collects a child's stdout lines and lets a test wait for one matching a pattern. */
function lines(child: ChildProcess) {
  const seen: string[] = [];
  const waiters: { re: RegExp; resolve: (m: RegExpMatchArray) => void }[] = [];
  createInterface({ input: child.stdout! }).on("line", (line) => {
    seen.push(line);
    for (const w of [...waiters]) {
      const m = line.match(w.re);
      if (m) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  return {
    seen,
    waitFor(re: RegExp, timeoutMs: number): Promise<RegExpMatchArray> {
      for (const line of seen) {
        const m = line.match(re);
        if (m) return Promise.resolve(m);
      }
      return new Promise((resolveWait, rejectWait) => {
        const timer = setTimeout(() => rejectWait(new Error(`timed out waiting for ${re}; saw:\n${seen.join("\n")}`)), timeoutMs);
        waiters.push({ re, resolve: (m) => (clearTimeout(timer), resolveWait(m)) });
      });
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasKataGo())("end to end with real KataGo", () => {
  let server: ChildProcess;
  let watcher: ChildProcess | null = null;
  let base = "";
  let dataDir = "";
  const env = () => ({ ...process.env, TUTOR_SERVER: base });

  const state = async (): Promise<GameView> => (await fetch(`${base}/api/state`)).json() as Promise<GameView>;
  const act = async (body: unknown) => {
    const res = await fetch(`${base}/api/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as { ok: boolean; view?: GameView; error?: string };
  };
  const until = async (pred: (v: GameView) => boolean, timeoutMs: number): Promise<GameView> => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await state();
      if (pred(v)) return v;
      if (Date.now() > end) throw new Error(`condition not met in ${timeoutMs} ms; last view status=${v.status} busy=${v.engineBusy}`);
      await sleep(100);
    }
  };
  const tutor = async (...args: string[]) => (await run(TSX, [join(ROOT, "src/cli/tutor.ts"), ...args], { env: env(), cwd: ROOT })).stdout;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "go-tutor-e2e-"));
    server = spawn(TSX, [join(ROOT, "src/server/index.ts")], {
      cwd: ROOT,
      env: { ...process.env, PORT: "0", GO_TUTOR_DATA: dataDir, TUTOR_TIMEOUT_MS: "60000" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const m = await lines(server).waitFor(/listening on (http:\/\/localhost:\d+)/, 30_000);
    base = m[1]!;
    const first = await state();
    expect(first.engineBusy).toBe(true); // serving before KataGo is ready
    await until((v) => !v.engineBusy, 180_000);
  }, 240_000);

  afterAll(async () => {
    watcher?.kill("SIGTERM");
    if (server && server.exitCode === null) {
      const exited = new Promise((r) => server.once("exit", r));
      server.kill("SIGTERM");
      await exited;
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it("plays a game with a teaching moment handled by the tutor CLI, then ends by passing", async () => {
    watcher = spawn(TSX, [join(ROOT, "src/cli/tutor.ts"), "watch"], { cwd: ROOT, env: env(), stdio: ["ignore", "pipe", "ignore"] });
    const watch = lines(watcher);
    await until((v) => v.tutorAttached, 20_000);

    expect((await act({ type: "new_game", settings: { size: 9 } })).ok).toBe(true);
    await watch.waitFor(/^GAME_START /, 10_000);

    // A good first move, then a deliberately bad one in the corner.
    expect((await act({ type: "play", point: { x: 4, y: 4 } })).ok).toBe(true);
    await until((v) => v.moves.length === 2 && !v.engineBusy, 60_000);
    const before = await state();
    const corner = [{ x: 0, y: 8 }, { x: 8, y: 0 }, { x: 0, y: 0 }].find((p) => !before.board[p.y]![p.x])!;
    expect((await act({ type: "play", point: corner })).ok).toBe(true);

    const moment = await watch.waitFor(/^MOMENT (\S+) .* lost ([\d.]+) pts/, 60_000);
    const momentId = moment[1]!;
    expect(Number(moment[2])).toBeGreaterThanOrEqual(4);
    let v = await state();
    expect(v.status).toBe("paused");
    expect(v.moment?.state).toBe("waiting");

    expect(await tutor("claim", momentId)).toMatch(/^ok .*state=tutor/);
    expect(await tutor("say", "The corner stone does very little. Where is the biggest open area?")).toMatch(/^ok/);
    v = await state();
    expect(v.chat.at(-1)).toMatchObject({ from: "tutor", momentId });
    expect(await tutor("resume")).toMatch(/^ok .*status=playing/);
    v = await until((s) => s.moves.length === 4 && !s.engineBusy, 60_000);
    expect(v.moves.at(-1)!.move.color).toBe("W");

    // Pass until the game ends, continuing past any teaching moments that early passes cause.
    v = await until((s) => {
      if (s.status === "finished") return true;
      if (s.engineBusy) return false;
      if (s.status === "paused") void act({ type: "continue" });
      else if (s.toPlay === s.settings!.humanColor) void act({ type: "pass" });
      return false;
    }, 300_000);
    expect(v.result?.reason).toBe("score");
    await watch.waitFor(/^GAME_END /, 10_000);

    const saved = (await (await fetch(`${base}/api/game/last`)).json()) as { id: string; result: unknown; moves: unknown[] };
    expect(saved.id).toBe(v.gameId);
    expect(saved.result).toEqual(v.result);
    expect(await tutor("summary")).toMatch(/games 1/);
  }, 420_000);
});
