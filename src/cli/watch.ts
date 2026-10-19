// `tutor watch`: follow the tutor event stream, printing the events the tutor acts on.
// Everything that is not an event goes to stderr, because each stdout write becomes a notification
// (a Claude turn), so the text stream leaves out what needs no answer and carries what the answer
// needs:
// - moves, level and judge changes and batch starts are left out, and the learner's moves and
//   take-backs unless one changes the position of a moment or hint the tutor may be answering
//   (`all` prints everything);
// - a waiting MOMENT, a HINT, a PROBLEM_START or a USER line while its game is in play comes with
//   the state (printed once per write, and a question on an unchanged board just says so), and a
//   GAME_END with the review, so the tutor doesn't spend a turn running `state` or `review`;
// - what arrives together goes out in one write: the server sends a GAME_END with its RATING when
//   the rank estimate is quick, and holds events that need no answer (a game or problem start, a
//   finished batch, a fallback) for the next one that does, so each is one notification.

import { toAscii } from "../engine/ascii.ts";
import { movePoint } from "../shared/coords.ts";
import type { GameView, TutorEvent } from "../shared/types.ts";
import { Client, ServerError } from "./client.ts";
import { formatEvent, formatState } from "./format.ts";
import { reviewText } from "./queries.ts";
import { SseParser } from "./sse.ts";

export interface WatchOptions {
  client: Client;
  /** Resume after this sequence number. Omitted: the server decides where a fresh stream starts. */
  since?: number;
  /** Print every event, the bare line only (no state or review). */
  all?: boolean;
  /** Every event as raw JSON, for programs. */
  json: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /** Initial and maximum reconnect delays. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long the state or review fetched for an event may take before the bare line goes out. Default 3 s. */
  contextTimeoutMs?: number;
  now?: () => number;
}

/** Events older than this (a `--since` replay) get no state or review: the board has moved on, and the reviews would flood one notification. */
const CONTEXT_MAX_AGE_MS = 10 * 60_000;

/** Under a PROBLEM_START whose problem the learner already answered and now plays out against KataGo. */
export const PLAYOUT_CONTEXT = "(the learner answered it and is playing it out against KataGo; nothing to answer)";

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Events the tutor acts on. The rest stays out of the text stream unless `all` is set. */
function actionable(event: TutorEvent): boolean {
  switch (event.type) {
    case "move":
      // Only the learner's move that leaves a hint request unanswered: the tutor's answer would be about the old position.
      return event.hintPending === true;
    case "tutor_level":
    case "judge_mode":
      return false;
    case "undo":
      // The learner's take-back of a position the tutor may be answering about (the tutor's own rethink needs no word).
      return event.by === "human" && event.during !== undefined;
    case "generation":
      return event.status === "finished";
    default:
      return true;
  }
}

/** Runs until the signal aborts. Never resolves on its own: the stream is meant to be followed forever. */
export async function watch(opts: WatchOptions): Promise<void> {
  const { client, out, err, signal } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const minBackoff = opts.minBackoffMs ?? 500;
  const maxBackoff = opts.maxBackoffMs ?? 10_000;
  const contextTimeoutMs = opts.contextTimeoutMs ?? 3_000;
  const now = opts.now ?? Date.now;
  // The text stream for the tutor; --all and --json print every event, bare.
  const tutorStream = !opts.all && !opts.json;
  let last = opts.since;
  /** The server boot `last` belongs to; sent back so a restarted server can tell a stale cursor. */
  let epoch: string | undefined;
  let backoff = minBackoff;
  /** Board sizes seen in the stream, for events logged before they carried `size`. */
  const sizes = new Map<string, number>();

  const line = (event: TutorEvent, attached?: boolean): string =>
    opts.json ? JSON.stringify(event) : formatEvent(event, { sizeOf: (g) => sizes.get(g), ...(attached !== undefined && { attached }) });

  /** Games the stream has seen end: a question about one is about the review, not a board. */
  const ended = new Set<string>();
  /** The position of the last state printed, so a question on an unchanged board doesn't reprint it (unless KataGo's analysis of it has come in since). */
  let lastBoard: string | undefined;
  const boardKey = (v: GameView): string => JSON.stringify([v.mode, v.gameId, v.problem?.id, v.moves.length, v.toPlay, v.status, v.moment?.id, v.moment?.state, v.toPlayAnalysis ? (v.toPlayAnalysis.pending ? "pending" : "ready") : null]);

  /**
   * The state (or review) to print under an event: null when it has none, false when it should but
   * the server can't give it in time, "gone" when the board has moved on from it. `state` fetches the
   * view once for all the events of a write, and `t` is the write's clock, so they print alike.
   */
  const contextFor = async (event: TutorEvent, state: () => Promise<GameView>, fetchSignal: AbortSignal, t: number): Promise<string | null | false | "gone"> => {
    if (!tutorStream || t - event.ts > CONTEXT_MAX_AGE_MS) return null;
    // A question during a game comes with the board too: the stream leaves out the moves since the last moment.
    const question = event.type === "user_message" && !event.problemId && !!event.gameId && !ended.has(event.gameId);
    const wanted =
      event.type === "teaching_moment" ? event.moment.state === "waiting" : question || event.type === "hint_request" || event.type === "problem_start" || event.type === "game_end";
    if (!wanted) return null;
    try {
      if (event.type === "game_end") return await reviewText(client, event.gameId, fetchSignal, true);
      const view = await state();
      // A problem being played out is answered and unjudged: its board is for the tutor only while it
      // still owes a reply (only a problem_start can match a problem view; a moment under it prints
      // the game's board below).
      if (event.type === "problem_start" && view.problem?.playout && !view.problem.playout.replyOwed) {
        return view.problem.id === event.problemId ? PLAYOUT_CONTEXT : "gone";
      }
      // The board must be the one the event is about: a replayed moment or hint can come after the game moved on.
      const same =
        event.type === "teaching_moment"
          ? view.moment?.id === event.moment.id
          : event.type === "hint_request"
            ? view.mode === "game" && view.gameId === event.gameId && toAscii(view.board, movePoint(view.moves.at(-1)?.move)) === event.board
            : event.type === "user_message"
              ? view.mode === "game" && view.gameId === event.gameId && !view.result
              : event.type === "problem_start" && view.problem?.id === event.problemId;
      if (same) {
        const key = boardKey(view);
        if (event.type === "user_message" && key === lastBoard) return "(the board hasn't changed since the last state above)";
        lastBoard = key;
        return formatState(view, t, 0, true);
      }
      // A question after the game or over a practice problem simply goes without it.
      if (event.type === "user_message") return null;
      // A moment waiting under a practice problem: `state` shows the problem, so give the game's board from the event.
      if (event.type === "teaching_moment" && view.mode === "problem" && event.boardAfter) {
        return (
          `practice problem ${view.problem?.id ?? ""} on the board; the moment waits under it (say/show/mark go to the problem; ` +
          `claim ${event.moment.id} keeps the moment for after it). Board after move ${event.record.number}:\n${event.boardAfter}`
        );
      }
      err(`watch: the board has moved on from this ${event.type}; not attaching the state`);
      return "gone";
    } catch (e) {
      err(`watch: couldn't fetch the ${event.type === "game_end" ? "review" : "state"} for this event: ${(e as Error).message}`);
    }
    return false;
  };

  /** The event to print, or null when it is a duplicate, unreadable, or one the tutor doesn't act on. */
  const accept = (data: string, id: string | undefined): TutorEvent | null => {
    let event: TutorEvent;
    try {
      event = JSON.parse(data) as TutorEvent;
    } catch {
      err(`watch: ignoring non-JSON event data: ${data.slice(0, 200)}`);
      return null;
    }
    const seq = typeof event.seq === "number" ? event.seq : Number(id);
    if (Number.isFinite(seq)) {
      if (last !== undefined && seq <= last) return null; // replayed after a reconnect
      last = seq;
    }
    if (event.type === "game_start") sizes.set(event.gameId, event.settings.size);
    if (event.type === "game_end") ended.add(event.gameId);
    else if ("size" in event && typeof event.size === "number" && "gameId" in event && typeof event.gameId === "string") sizes.set(event.gameId, event.size);
    return tutorStream && !actionable(event) ? null : event;
  };

  /**
   * One write for what arrived together (the server sends events that need no answer, like a
   * PROBLEM_START, with the next one that does): the event lines first (a GAME_END's RATING right
   * under it), then the states and reviews, fetched at once. A PROBLEM_START whose problem has left
   * the board by then is dropped.
   */
  const render = async (events: TutorEvent[]): Promise<string> => {
    const timeout = AbortSignal.timeout(contextTimeoutMs);
    const fetchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let view: Promise<GameView> | undefined;
    const state = () => (view ??= client.state(fetchSignal));
    const t = now();
    const contexts = await Promise.all(events.map((e) => contextFor(e, state, fetchSignal, t)));
    const kept = events.map((e, i) => ({ e, c: contexts[i]! })).filter(({ e, c }) => !(c === "gone" && e.type === "problem_start"));
    const attached = (c: (typeof contexts)[number]): c is string => typeof c === "string" && c !== "gone";
    const lines = kept.map(({ e, c }) => line(e, c === null ? undefined : attached(c)));
    // The same state under two events (a moment and a question about it) is printed once.
    return [...lines, ...new Set(kept.map(({ c }) => c).filter(attached))].join("\n");
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
    // The tutor's stream: right after its last watch closed, the server replays what that one missed.
    if (tutorStream) params.set("rejoin", "1");
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
          // What arrived together goes out in one write: one notification.
          const events: TutorEvent[] = [];
          for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
            if (msg.event === "hello") hello(msg.data);
            else {
              const event = accept(msg.data, msg.id);
              if (event) events.push(event);
            }
          }
          if (events.length > 0) out(await render(events));
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
