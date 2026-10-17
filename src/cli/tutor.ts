// Entry point: `npm run -s tutor -- <command> [args]`.

import type { FocusRecommendation, ProblemsResponse, Profile, ProfileResponse, SavedGame } from "../shared/types.ts";
import { parseInvocation, UsageError, type Invocation } from "./args.ts";
import { Client, ServerError, serverUrl } from "./client.ts";
import { commandJson, commandOutput, formatProblemList, formatProblems, formatProfile, formatReview, formatState, reviewThreshold } from "./format.ts";
import { HELP, USAGE } from "./help.ts";
import { watch } from "./watch.ts";

const print = (text: string) => process.stdout.write(text + "\n");
const printErr = (text: string) => process.stderr.write(text + "\n");

/** GET /api/profile: `{ profile, focus }` (an older server sent the bare profile). */
async function getProfile(client: Client): Promise<{ profile: Profile; focus: FocusRecommendation | null } | null> {
  const body = await client.getJson<ProfileResponse | Profile>("/api/profile");
  if (!body) return null;
  return "profile" in body ? body : { profile: body, focus: null };
}

/** GET /api/problems, or null when the server has none (an older server) or it fails. */
async function getProblems(client: Client): Promise<ProblemsResponse | null> {
  const body = await client.getJson<ProblemsResponse>("/api/problems").catch(() => null);
  return body && Array.isArray(body.problems) && body.counts ? body : null;
}

async function summary(client: Client, json: boolean): Promise<void> {
  const [profile, problems] = await Promise.all([getProfile(client), getProblems(client)]);
  if (json) {
    print(JSON.stringify({ profile: profile?.profile ?? null, focus: profile?.focus ?? null, problems }));
    return;
  }
  print(profile ? formatProfile(profile.profile, profile.focus) : "profile: not available (the server has no /api/profile)");
  print(problems ? formatProblems(problems) : "practice problems: not available on this server");
}

async function problems(client: Client, json: boolean): Promise<void> {
  const body = await getProblems(client);
  if (!body) throw new ServerError("this server has no practice problems (GET /api/problems failed)", 404);
  print(json ? JSON.stringify(body) : formatProblemList(body));
}

async function review(client: Client, gameId: string, json: boolean): Promise<void> {
  const [game, profile] = await Promise.all([
    client.getJson<SavedGame>(`/api/game/${encodeURIComponent(gameId)}`),
    json ? null : getProfile(client).catch(() => null),
  ]);
  if (!game) {
    throw new ServerError(gameId === "last" ? "no saved games yet (GET /api/game/last returned 404)" : `no saved game "${gameId}"`, 404);
  }
  if (json) {
    print(JSON.stringify(game));
    return;
  }
  // The threshold the game was played with, on its board, decides what counted as a mistake.
  print(formatReview(game, reviewThreshold(game, profile?.profile)));
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
    case "problems":
      return problems(client, inv.json);
    case "review":
      return review(client, inv.gameId, inv.json);
    case "command": {
      const view = await client.send(inv.command);
      print(inv.json ? commandJson(inv.command, view) : commandOutput(inv.command, view));
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
