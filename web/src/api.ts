// Talking to the server: state fetch, actions, and the SSE stream of GameViews.

import type { ClientAction, GameView } from "../../src/shared/types.ts";
import { backoffDelay } from "./geometry.ts";

export interface ActionResponse {
  ok: boolean;
  view?: GameView;
  error?: string;
}

export type ConnectionState = "connecting" | "open" | "reconnecting";

export interface Transport {
  getState(): Promise<GameView>;
  send(action: ClientAction): Promise<ActionResponse>;
  /** Streams views until the returned function is called. */
  subscribe(onView: (v: GameView) => void, onConnection: (s: ConnectionState) => void): () => void;
}

export const httpTransport: Transport = {
  async getState() {
    const res = await fetch("/api/state");
    if (!res.ok) throw new Error(`GET /api/state failed: ${res.status}`);
    return (await res.json()) as GameView;
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

    const connect = () => {
      onConnection(attempt === 0 ? "connecting" : "reconnecting");
      source = new EventSource("/api/events");
      source.onopen = () => {
        attempt = 0;
        onConnection("open");
        // Catch up on anything missed while disconnected.
        httpTransport.getState().then(onView, () => {});
      };
      source.onmessage = (e) => {
        try {
          onView(JSON.parse(e.data as string) as GameView);
        } catch {
          // Ignore malformed frames; the next one carries the full view anyway.
        }
      };
      source.onerror = () => {
        // Take over from EventSource's fixed retry so we can back off.
        source?.close();
        source = null;
        if (closed) return;
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
