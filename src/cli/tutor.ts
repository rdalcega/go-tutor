// Entry point: `npm run -s tutor -- <command> [args]`.

import type { Profile } from "../shared/types.ts";
import { parseInvocation, UsageError, type Invocation } from "./args.ts";
import { Client, ServerError, serverUrl } from "./client.ts";
import { formatProblems, formatProfile, formatReview, formatState, statusLine, type ProblemInfo, type SavedGame } from "./format.ts";
import { HELP, USAGE } from "./help.ts";
import { watch } from "./watch.ts";

const print = (text: string) => process.stdout.write(text + "\n");
const printErr = (text: string) => process.stderr.write(text + "\n");

async function summary(client: Client, json: boolean): Promise<void> {
  const [profile, problems] = await Promise.all([
    client.getJson<Profile>("/api/profile"),
    client.getJson<ProblemInfo[] | { problems: ProblemInfo[] }>("/api/problems"),
  ]);
  const list = problems === null ? null : Array.isArray(problems) ? problems : problems.problems;
  if (json) {
    print(JSON.stringify({ profile, problems: list }));
    return;
  }
  print(profile ? formatProfile(profile) : "profile: not available yet (the server has no /api/profile; arrives with Milestone 4)");
  print(list ? formatProblems(list) : "problems: not available yet (the server has no /api/problems; arrives with Milestone 5)");
}

async function review(client: Client, gameId: string, json: boolean): Promise<void> {
  const game = await client.getJson<SavedGame>(`/api/game/${encodeURIComponent(gameId)}`);
  if (!game) {
    throw new ServerError(gameId === "last" ? "no saved games yet (GET /api/game/last returned 404)" : `no saved game "${gameId}"`, 404);
  }
  if (json) {
    print(JSON.stringify(game));
    return;
  }
  const profile = await client.getJson<Profile>("/api/profile").catch(() => null);
  print(formatReview(game, profile?.mistakeThreshold));
}

async function run(inv: Invocation, client: Client): Promise<void> {
  switch (inv.kind) {
    case "help":
      print(HELP);
      return;
    case "watch": {
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      process.once("SIGTERM", () => controller.abort());
      await watch({ client, since: inv.since, json: inv.json, out: print, err: printErr, signal: controller.signal });
      return;
    }
    case "state": {
      const view = await client.state();
      print(inv.json ? JSON.stringify(view) : formatState(view));
      return;
    }
    case "summary":
      return summary(client, inv.json);
    case "review":
      return review(client, inv.gameId, inv.json);
    case "command": {
      const view = await client.send(inv.command);
      print(inv.json ? JSON.stringify(view) : `ok ${statusLine(view)}`);
      return;
    }
  }
}

async function main(argv: string[]): Promise<number> {
  let inv: Invocation;
  try {
    inv = parseInvocation(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    printErr(`usage error: ${e.message}\n${USAGE}`);
    return 2;
  }
  try {
    await run(inv, new Client(serverUrl()));
    return 0;
  } catch (e) {
    if (!(e instanceof ServerError)) throw e;
    printErr(`error: ${e.message}`);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    printErr(`error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
