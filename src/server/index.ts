// HTTP server: JSON API, SSE streams, static UI from dist/. Starts serving at once and brings
// KataGo up in the background; the view reports engineBusy until it is ready.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TutorBridge, parseClientAction, parseTutorCommand } from "./bridge.ts";
import { UserError } from "./common.ts";
import { GameController } from "./game.ts";
import { removeLegacyBuiltins } from "./generate.ts";
import { KataGo } from "./katago.ts";
import { problemsResponse } from "./problems.ts";
import { recommendFocus } from "./profile.ts";
import { Store, isValidGameId } from "./store.ts";
import type { ProblemsResponse, ProfileResponse } from "../shared/types.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_BODY = 64 * 1024;
/** The Vite dev server (`npm run dev`) proxies /api here and keeps the browser's Origin. */
const DEV_PORT = 5173;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export interface AppOptions {
  controller: GameController;
  bridge: TutorBridge;
  store: Store;
  /** Built UI to serve; default <repo>/dist. */
  distDir?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new UserError("Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) throw new UserError("Expected a JSON body.");
  try {
    return JSON.parse(text);
  } catch {
    throw new UserError("The request body is not valid JSON.");
  }
}

/**
 * Whether a request's Origin may use the API. Browsers send Origin on cross-origin requests and
 * on every POST; the tutor CLI sends none. Only pages served by this server or by the Vite dev
 * server count, so another site open in the browser can't play moves or post chat to the tutor.
 */
export function isAllowedOrigin(origin: string | undefined, serverPort: number | undefined): boolean {
  if (origin === undefined) return true;
  const ports = [serverPort, DEV_PORT].filter((p): p is number => p !== undefined);
  return ports.some((port) => origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`);
}

function isJson(req: IncomingMessage): boolean {
  const type = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  return type === "application/json";
}

function serveStatic(req: IncomingMessage, res: ServerResponse, distDir: string, pathname: string): void {
  const index = join(distDir, "index.html");
  if (!existsSync(index)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("The UI isn't built. Run `npm start` (builds, then serves) or `npm run dev` and open the Vite URL.\n");
    return;
  }
  let file = normalize(join(distDir, decodeURIComponent(pathname)));
  if (file !== distDir && !file.startsWith(distDir + sep)) {
    res.writeHead(403).end();
    return;
  }
  const isFile = existsSync(file) && statSync(file).isFile();
  if (!isFile) {
    // SPA fallback for page routes; a missing asset is a real 404.
    if (extname(pathname)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found\n");
      return;
    }
    file = index;
  }
  const hashed = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}

export function createApp({ controller, bridge, store, distDir = join(REPO_ROOT, "dist") }: AppOptions): Server {
  const dist = resolve(distDir);

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path.startsWith("/api/")) {
      if (!isAllowedOrigin(req.headers.origin, req.socket.localPort)) {
        return sendJson(res, 403, { ok: false, error: `Requests from ${req.headers.origin} are not allowed. Open the Go Tutor page itself.` });
      }
      // A cross-site form can't send this content type without a CORS preflight, which is never granted.
      if (method === "POST" && !isJson(req)) {
        return sendJson(res, 415, { ok: false, error: "POST bodies must be sent with content-type: application/json." });
      }
    }
    if (path === "/api/state" && method === "GET") return sendJson(res, 200, controller.view());
    if (path === "/api/events" && method === "GET") return bridge.openViewStream(req, res);
    if (path === "/api/tutor/events" && method === "GET") {
      const raw = url.searchParams.get("since");
      const since = raw === null || raw === "" ? undefined : Number(raw);
      if (since !== undefined && !Number.isInteger(since)) return sendJson(res, 400, { ok: false, error: "since must be an integer seq." });
      return bridge.openTutorStream(req, res, since, url.searchParams.get("epoch") ?? undefined, url.searchParams.get("rejoin") === "1");
    }
    if (path === "/api/action" && method === "POST") {
      await controller.handleAction(parseClientAction(await readJson(req)));
      return sendJson(res, 200, { ok: true, view: controller.view() });
    }
    if (path === "/api/tutor" && method === "POST") {
      await controller.handleTutor(parseTutorCommand(await readJson(req)));
      return sendJson(res, 200, { ok: true, view: controller.view() });
    }
    if (path === "/api/profile" && method === "GET") {
      const profile = controller.currentProfile;
      const body: ProfileResponse = { profile, focus: recommendFocus(profile) };
      return sendJson(res, 200, body);
    }
    if (path === "/api/problems" && method === "GET") {
      const generation = controller.generationStatus();
      const body: ProblemsResponse = problemsResponse(store.loadProblems(), Date.now(), recommendFocus(controller.currentProfile), generation);
      return sendJson(res, 200, body);
    }
    if (path === "/api/generation" && method === "GET") return sendJson(res, 200, controller.generationStatus());
    const gameMatch = /^\/api\/game\/([^/]+)$/.exec(path);
    if (gameMatch && method === "GET") {
      const id = decodeURIComponent(gameMatch[1]!);
      const game = id === "last" ? store.lastGame({ finished: true }) ?? store.lastGame() : isValidGameId(id) ? store.loadGame(id) : null;
      return game ? sendJson(res, 200, game) : sendJson(res, 404, { ok: false, error: id === "last" ? "No saved games yet." : `No saved game "${id}".` });
    }
    if (path.startsWith("/api/")) return sendJson(res, 404, { ok: false, error: `No such endpoint: ${method} ${path}` });
    if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    serveStatic(req, res, dist, path);
  };

  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof UserError) sendJson(res, 400, { ok: false, error: err.message });
      else {
        console.error(err);
        sendJson(res, 500, { ok: false, error: `Server error: ${(err as Error).message ?? String(err)}` });
      }
    });
  });
}

const KATAGO_FIX = "Run `npm run setup:katago` in the go-tutor folder, then restart the server.";

/**
 * Crash accounting for KataGo restarts: each call records a crash and says whether to restart
 * again, which is no once more than `max` crashes fall within `windowMs`. An occasional crash over a
 * long session never uses up the budget.
 */
export function crashLimiter(max = 3, windowMs = 10 * 60_000, now: () => number = Date.now): () => boolean {
  const crashes: number[] = [];
  return () => {
    const t = now();
    crashes.push(t);
    while (crashes[0]! <= t - windowMs) crashes.shift();
    return crashes.length <= max;
  };
}

/** Bring KataGo up in the background, restarting it (a few times) if it crashes. */
function startEngine(engine: KataGo, controller: GameController): void {
  const started = Date.now();
  controller.setEngineState("starting");
  engine.start().then(
    () => {
      console.log(`KataGo ready after ${((Date.now() - started) / 1000).toFixed(1)}s`);
      controller.setEngineState("ready");
      // Once per data dir: re-estimate the rating from the saved games' moves (rating model 2).
      void controller.migrateRatings();
    },
    (err: Error) => {
      console.error(`KataGo failed to start: ${err.message}`);
      controller.setEngineState("failed", `KataGo couldn't start, so there's no bot or analysis yet. ${err.message.split("\n")[0]} ${KATAGO_FIX}`);
    },
  );
}

async function main(): Promise<void> {
  // A background task that fails unexpectedly is a bug to log, not a reason to stop the game.
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason instanceof Error ? (reason.stack ?? reason.message) : reason);
  });
  const port = Number(process.env.PORT ?? 4747);
  const timeout = Number(process.env.TUTOR_TIMEOUT_MS);
  const tutorTimeoutMs = Number.isFinite(timeout) && timeout >= 0 ? timeout : 30_000;
  const debug = !!process.env.GO_TUTOR_DEBUG;
  const store = new Store();
  // Generated problems replaced the built-in starter set: drop it from problems.json (backed up first).
  const migrated = removeLegacyBuiltins(store, Date.now());
  if (migrated.removed) console.log(`removed ${migrated.removed} built-in practice problems from problems.json (backup in ${migrated.backupDir})`);
  const mayRestart = crashLimiter();
  let controller: GameController;
  const engine = new KataGo({
    onLog: (line) => {
      if (debug) console.log(`[katago] ${line}`);
    },
    onExit: (err) => {
      console.error(err.message);
      if (!mayRestart()) {
        controller.setEngineState("failed", `KataGo keeps crashing. ${KATAGO_FIX}`);
        return;
      }
      controller.system("KataGo stopped unexpectedly; restarting it.");
      startEngine(engine, controller);
    },
  });
  controller = new GameController({
    engine,
    store,
    tutorTimeoutMs,
    log: (m) => console.log(m),
    ...(debug && { debug: (m: string) => console.log(`[generate] ${m}`) }),
  });
  const bridge = new TutorBridge(controller, store);
  controller.restoreLastGame();
  // In the background whenever KataGo is free: resumes a batch in progress, or starts the first one.
  controller.startGeneration();

  const server = createApp({ controller, bridge, store });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Go Tutor listening on http://localhost:${actualPort} (data in ${store.dir})`);

  startEngine(engine, controller);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    controller.flush();
    bridge.close();
    server.close();
    server.closeAllConnections();
    // generation.json is written after every step, so a stopped batch resumes from its last move.
    void controller.stopGeneration();
    engine.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown); // the terminal running the server closed
  process.on("beforeExit", () => controller.flush());
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
