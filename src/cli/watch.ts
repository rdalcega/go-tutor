// `tutor watch`: follow the tutor event stream, one stdout line per event.
// Everything that is not an event goes to stderr, because each stdout line becomes a notification.

import type { TutorEvent } from "../shared/types.ts";
import { Client, ServerError } from "./client.ts";
import { formatEvent } from "./format.ts";
import { SseParser } from "./sse.ts";

export interface WatchOptions {
  client: Client;
  /** Resume after this sequence number. Omitted: the server decides where a fresh stream starts. */
  since?: number;
  json: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /** Initial and maximum reconnect delays. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs until the signal aborts. Never resolves on its own: the stream is meant to be followed forever. */
export async function watch(opts: WatchOptions): Promise<void> {
  const { client, out, err, signal } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const minBackoff = opts.minBackoffMs ?? 500;
  const maxBackoff = opts.maxBackoffMs ?? 10_000;
  let last = opts.since;
  /** The server boot `last` belongs to; sent back so a restarted server can tell a stale cursor. */
  let epoch: string | undefined;
  let backoff = minBackoff;
  /** Board sizes seen in the stream, for events logged before they carried `size`. */
  const sizes = new Map<string, number>();

  const handle = (data: string, id: string | undefined): void => {
    let event: TutorEvent;
    try {
      event = JSON.parse(data) as TutorEvent;
    } catch {
      err(`watch: ignoring non-JSON event data: ${data.slice(0, 200)}`);
      return;
    }
    const seq = typeof event.seq === "number" ? event.seq : Number(id);
    if (Number.isFinite(seq)) {
      if (last !== undefined && seq <= last) return; // replayed after a reconnect
      last = seq;
    }
    if (event.type === "game_start") sizes.set(event.gameId, event.settings.size);
    else if ("size" in event && typeof event.size === "number" && "gameId" in event && typeof event.gameId === "string") sizes.set(event.gameId, event.size);
    out(opts.json ? JSON.stringify(event) : formatEvent(event, { sizeOf: (g) => sizes.get(g) }));
  };

  /** The server's first frame: its epoch, and the seq its replay starts after (our new cursor). */
  const hello = (data: string): void => {
    let msg: { epoch?: unknown; since?: unknown };
    try {
      msg = JSON.parse(data) as typeof msg;
    } catch {
      err(`watch: ignoring malformed hello: ${data.slice(0, 200)}`);
      return;
    }
    if (typeof msg.epoch !== "string") return;
    if (epoch !== undefined && msg.epoch !== epoch) err("watch: the server restarted; resuming from its replay");
    epoch = msg.epoch;
    // A restarted server may reuse seqs we already saw; its replay start is where we are now.
    if (typeof msg.since === "number") last = msg.since;
  };

  while (!signal?.aborted) {
    const params = new URLSearchParams();
    if (last !== undefined) params.set("since", String(last));
    if (last !== undefined && epoch !== undefined) params.set("epoch", epoch);
    const query = params.toString();
    const path = `/api/tutor/events${query ? `?${query}` : ""}`;
    try {
      const res = await client.request(path, { headers: { accept: "text/event-stream" }, signal });
      if (!res.ok || !res.body) throw new ServerError(`event stream answered HTTP ${res.status}`, res.status);
      err(`watch: connected to ${client.base}${path}`);
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          backoff = minBackoff; // the connection is live; next drop retries quickly
          for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
            if (msg.event === "hello") hello(msg.data);
            else handle(msg.data, msg.id);
          }
          // The server's cursor frame (id, no data) moves `last` even before any event arrives.
          const cursor = Number(parser.lastEventId);
          if (parser.lastEventId !== undefined && Number.isFinite(cursor) && (last === undefined || cursor > last)) last = cursor;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      err("watch: stream closed by server");
    } catch (e) {
      if (signal?.aborted) break;
      err(`watch: ${(e as Error).message}`);
    }
    if (signal?.aborted) break;
    err(`watch: reconnecting in ${(backoff / 1000).toFixed(1)}s (since=${last ?? "none"})`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, maxBackoff);
  }
}
