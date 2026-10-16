// Talking to the server: actions, the profile, and the SSE stream of GameViews.

import type { ActionResponse, ClientAction, GameView, ProfileResponse } from "../../src/shared/types.ts";
import { backoffDelay } from "./geometry.ts";

export type ConnectionState = "connecting" | "open" | "reconnecting";

export interface Transport {
  send(action: ClientAction): Promise<ActionResponse>;
  /**
   * Streams views (the current one first) until the returned function is called. `raw` is the
   * view's message text when it came from the stream, so identical frames can be skipped cheaply.
   */
  subscribe(onView: (v: GameView, raw?: string) => void, onConnection: (s: ConnectionState) => void): () => void;
  /** The learner profile and recommended focus; null when the server can't provide it. */
  getProfile(): Promise<ProfileResponse | null>;
}

async function getState(): Promise<GameView> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`GET /api/state failed: ${res.status}`);
  return (await res.json()) as GameView;
}

export const httpTransport: Transport = {
  async getProfile() {
    try {
      const res = await fetch("/api/profile");
      if (!res.ok) return null;
      const body = (await res.json()) as Partial<ProfileResponse>;
      return body.profile ? (body as ProfileResponse) : null;
    } catch {
      return null;
    }
  },

  async send(action) {
    try {
      const res = await fetch("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      });
      const body = (await res.json().catch(() => null)) as ActionResponse | null;
      if (body) return body;
      return { ok: false, error: `Server answered ${res.status}` };
    } catch {
      return { ok: false, error: "Can't reach the server." };
    }
  },

  subscribe(onView, onConnection) {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let closed = false;
    let opened = false;

    const connect = () => {
      onConnection(attempt === 0 ? "connecting" : "reconnecting");
      source = new EventSource("/api/events");
      source.onopen = () => {
        // Every (re)connection starts with the current view, so nothing missed needs fetching.
        opened = true;
        attempt = 0;
        onConnection("open");
      };
      source.onmessage = (e) => {
        try {
          const raw = e.data as string;
          onView(JSON.parse(raw) as GameView, raw);
        } catch {
          // Ignore malformed frames; the next one carries the full view anyway.
        }
      };
      source.onerror = () => {
        // Take over from EventSource's fixed retry so we can back off.
        source?.close();
        source = null;
        if (closed) return;
        // The stream never opened (a proxy that drops SSE, say): show the state anyway.
        if (!opened && attempt === 0) getState().then((v) => onView(v), () => {});
        onConnection("reconnecting");
        timer = setTimeout(connect, backoffDelay(attempt++));
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(timer);
      source?.close();
    };
  },
};
