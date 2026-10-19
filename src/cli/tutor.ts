// Entry point: `npm run -s tutor -- <command> [args]`.

import type { GenerationStatus, ProblemsResponse } from "../shared/types.ts";
import { parseInvocation, UsageError, type Invocation } from "./args.ts";
import { Client, ServerError, serverUrl } from "./client.ts";
import { commandJson, commandOutput, formatGeneration, formatProblemList, formatProblems, formatProfile, formatState } from "./format.ts";
import { HELP, USAGE } from "./help.ts";
import { getGame, getProfile, reviewText } from "./queries.ts";
import { watch } from "./watch.ts";

const print = (text: string) => process.stdout.write(text + "\n");
const printErr = (text: string) => process.stderr.write(text + "\n");

/** GET /api/problems, or null when the server has none (an older server) or it fails. */
async function getProblems(client: Client): Promise<ProblemsResponse | null> {
  const body = await client.getJson<ProblemsResponse>("/api/problems").catch(() => null);
  return body && Array.isArray(body.problems) && body.counts ? body : null;
}

/**
 * Waits until the server answers: `summary --wait` right after `npm start`, instead of polling. Only
 * "can't reach it" (or a 5xx while it starts) is waited out, for at most 100 s (under the Bash
 * tool's 2-minute limit); any other answer is an error now.
 */
async function waitForServer(client: Client): Promise<void> {
  const until = Date.now() + 100_000;
  for (;;) {
    try {
      await client.state(undefined, false); // only whether it answers: no analysis wanted
      return;
    } catch (e) {
      // Not reachable yet, or answering 5xx while it starts.
      const starting = e instanceof ServerError && (e.status === undefined || e.status >= 500);
      if (!starting || Date.now() >= until) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
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

/** `generate`: with `now`, start the next batch of generated problems first; then print the status. */
async function generate(client: Client, now: boolean, json: boolean): Promise<void> {
  // The command's view carries the status; a status query reads it on its own.
  const status = now ? ((await client.send({ type: "generate" })).generation ?? null) : await client.getJson<GenerationStatus>("/api/generation");
  if (!status) throw new ServerError("this server doesn't generate problems (GET /api/generation returned 404)", 404);
  if (json) print(JSON.stringify(status));
  else print(`${now ? `ok started ${status.current?.id ?? "a batch"}\n` : ""}${formatGeneration(status)}`);
}

async function review(client: Client, gameId: string, json: boolean): Promise<void> {
  print(json ? JSON.stringify(await getGame(client, gameId)) : await reviewText(client, gameId));
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
      await watch({ client, since: inv.since, all: inv.all, json: inv.json, out: print, err: printErr, signal: controller.signal });
      return;
    }
    case "state": {
      const view = await client.state();
      print(inv.json ? JSON.stringify(view) : formatState(view));
      return;
    }
    case "summary":
      if (inv.wait) await waitForServer(client);
      return summary(client, inv.json);
    case "problems":
      return problems(client, inv.json);
    case "review":
      return review(client, inv.gameId, inv.json);
    case "generate":
      return generate(client, inv.now, inv.json);
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
