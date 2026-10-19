// HTTP access to the Go Tutor server.

import type { ActionResponse, GameView, TutorCommand } from "../shared/types.ts";

export const DEFAULT_SERVER = "http://localhost:4747";

export function serverUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.TUTOR_SERVER || DEFAULT_SERVER).replace(/\/+$/, "");
}

/** The server answered with an error, or could not be reached. */
export class ServerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class Client {
  constructor(
    readonly base: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(this.base + path, init);
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message;
      throw new ServerError(`cannot reach the Go Tutor server at ${this.base} (${cause}). Is it running? Start it with: npm run dev`);
    }
  }

  /** GET a JSON resource. Returns null on 404 so callers can explain missing features. */
  async getJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
    const res = await this.request(path, { headers: { accept: "application/json" }, ...(signal && { signal }) });
    if (res.status === 404) return null;
    const body = await readBody(res);
    if (!res.ok) throw new ServerError(errorMessage(body, res), res.status);
    if (body === null || typeof body !== "object") {
      throw new ServerError(`GET ${path} did not return JSON; is TUTOR_SERVER (${this.base}) the Go Tutor server?`, res.status);
    }
    return body as T;
  }

  /** The tutor's view: on the learner's turn in a game, with KataGo's analysis of the position to play (`tutor` false: the learner's view, no KataGo query). */
  async state(signal?: AbortSignal, tutor = true): Promise<GameView> {
    const view = await this.getJson<GameView>(tutor ? "/api/state?tutor=1" : "/api/state", signal);
    if (!view) throw new ServerError(`GET /api/state returned 404 at ${this.base}; is TUTOR_SERVER pointing at the Go Tutor server?`, 404);
    return view;
  }

  /** POST a tutor command. Resolves with the new view; throws ServerError with the server's message. */
  async send(command: TutorCommand): Promise<GameView> {
    const res = await this.request("/api/tutor", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(command),
    });
    const body = (await readBody(res)) as Partial<ActionResponse> | null;
    if (!res.ok || !body || body.ok !== true || !body.view) {
      throw new ServerError(errorMessage(body, res), res.status);
    }
    return body.view;
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(body: unknown, res: Response): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  if (typeof body === "string" && body.trim()) return `HTTP ${res.status}: ${body.trim().slice(0, 300)}`;
  return `HTTP ${res.status} ${res.statusText}`.trim();
}
