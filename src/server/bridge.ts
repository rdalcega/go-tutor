// Tutor bridge: stamps controller events with seq/ts, logs them to data/events.jsonl, fans them out
// to `tutor watch` SSE connections (tracking tutorAttached), pushes GameViews to browsers, and
// validates the JSON bodies of browser actions and tutor commands.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientAction, Color, GameSettings, MistakeCategory, TutorCommand, TutorEvent } from "../shared/types.ts";
import { UserError, type GameController, type TutorEventInput } from "./game.ts";
import { MISTAKE_CATEGORIES, type Store } from "./store.ts";

export interface BridgeOptions {
  /** Events kept in memory for `since` replays; older ones are read from the log. Default 1000. */
  ringSize?: number;
  /** A tutor that drops its stream has this long to reconnect before it counts as gone. Default 3 s. */
  detachGraceMs?: number;
  /** SSE comment heartbeat, so dead connections get noticed. Default 15 s. */
  heartbeatMs?: number;
  now?: () => number;
  /** Where problems the game can survive (a failing event log) are reported. Default console.error. */
  log?: (msg: string) => void;
}

/** First frame of every tutor stream: which server boot it talks to, and where its replay starts. */
export interface StreamHello {
  epoch: string;
  /** Events after this seq are replayed; null when the stream started without a cursor. */
  since: number | null;
}

export class TutorBridge {
  /**
   * Identifies this server boot. Seqs continue from the event log, but events that never reached
   * the log (a full disk) are reused after a restart, so a cursor only counts within its epoch.
   */
  readonly epoch = randomBytes(6).toString("hex");
  private seq: number;
  /** The seq this boot started from: everything after it is new to a client from another epoch. */
  private readonly bootSeq: number;
  private logFailing = false;
  private readonly log: (msg: string) => void;
  private readonly ring: TutorEvent[] = [];
  private readonly tutors = new Set<ServerResponse>();
  private readonly browsers = new Set<ServerResponse>();
  private readonly ringSize: number;
  private readonly detachGraceMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private detachTimer: ReturnType<typeof setTimeout> | null = null;
  private viewQueued = false;
  /** Browsers waiting for "drain" before they get the next view. */
  private readonly draining = new Set<ServerResponse>();

  constructor(
    private readonly controller: GameController,
    private readonly store: Store,
    opts: BridgeOptions = {},
  ) {
    this.ringSize = opts.ringSize ?? 1000;
    this.detachGraceMs = opts.detachGraceMs ?? 3000;
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((msg) => console.error(msg));
    this.seq = store.lastEventSeq();
    this.bootSeq = this.seq;
    controller.onEvent((e) => this.publish(e));
    controller.onChange(() => this.queueView());
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Stamp, log and fan out one event. */
  publish(input: TutorEventInput): TutorEvent {
    const event = { ...input, seq: ++this.seq, ts: this.now() } as TutorEvent;
    try {
      this.store.appendEvent(event);
      if (this.logFailing) this.log(`Event log is writable again (from seq ${event.seq}).`);
      this.logFailing = false;
    } catch (err) {
      // The in-memory ring still serves replays; a full disk shouldn't stop the game.
      if (!this.logFailing) this.log(`Couldn't append event ${event.seq} to the event log (${(err as Error).message}); further failures are not reported until it works again.`);
      this.logFailing = true;
    }
    this.ring.push(event);
    if (this.ring.length > this.ringSize) this.ring.shift();
    const frame = tutorFrame(event);
    for (const res of this.tutors) send(res, frame);
    return event;
  }

  /** Events with seq > since, from memory when possible, else from the log. */
  eventsSince(since: number): TutorEvent[] {
    const first = this.ring[0];
    if (first && first.seq <= since + 1) return this.ring.filter((e) => e.seq > since);
    return this.store.readEvents(since);
  }

  // --- SSE endpoints -----------------------------------------------------------

  /**
   * GET /api/tutor/events?since=N&epoch=E. A cursor from another epoch (the server restarted) may
   * be past seqs this boot reuses, so the replay starts no later than this boot's first event.
   */
  openTutorStream(req: IncomingMessage, res: ServerResponse, since: number | undefined, epoch?: string): void {
    if (since !== undefined && epoch !== undefined && epoch !== this.epoch) since = Math.min(since, this.bootSeq);
    startSse(res);
    const hello: StreamHello = { epoch: this.epoch, since: since ?? null };
    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    const replay = since !== undefined ? this.eventsSince(since) : this.currentMomentEvents();
    for (const e of replay) res.write(tutorFrame(this.replayed(e)));
    // An id-only frame sets the client's cursor without an event, so a reconnect replays from here
    // even when nothing was sent yet.
    res.write(`id: ${this.seq}\n\n`);
    this.tutors.add(res);
    if (this.detachTimer) clearTimeout(this.detachTimer);
    this.detachTimer = null;
    this.controller.setTutorAttached(true);
    this.keepAlive(req, res, () => {
      this.tutors.delete(res);
      if (this.tutors.size > 0) return;
      // `tutor watch` reconnects quickly after a drop; don't fall back on a blip.
      this.detachTimer = setTimeout(() => {
        this.detachTimer = null;
        if (this.tutors.size === 0) this.controller.setTutorAttached(false);
      }, this.detachGraceMs);
    });
  }

  /** GET /api/events: the full GameView now and after every change. */
  openViewStream(req: IncomingMessage, res: ServerResponse): void {
    startSse(res);
    res.write(viewFrame(this.controller.view()));
    this.browsers.add(res);
    this.keepAlive(req, res, () => {
      this.browsers.delete(res);
      this.draining.delete(res);
    });
  }

  close(): void {
    for (const res of [...this.tutors, ...this.browsers]) res.end();
    if (this.detachTimer) clearTimeout(this.detachTimer);
  }

  /**
   * A replayed teaching moment carries the moment's state now, not when it was logged: a moment
   * the tutor or the fallback already answered isn't "waiting" anymore.
   */
  private replayed(e: TutorEvent): TutorEvent {
    if (e.type !== "teaching_moment") return e;
    // The game's moment, not the view's: a practice problem's view shows none while the game waits.
    const current = this.controller.gameMoment();
    const moment = current?.id === e.moment.id ? current : { ...e.moment, state: "resolved" as const };
    if (moment.state !== "waiting") delete moment.deadline;
    return { ...e, moment };
  }

  /**
   * A fresh `watch` (no since) gets the open teaching moment and the practice problem on the board
   * (a moment can wait under a problem), so a late tutor can still pick them up.
   */
  private currentMomentEvents(): TutorEvent[] {
    const view = this.controller.view();
    // The game's moment (null once the game is over), which stays open under a practice problem.
    const moment = this.controller.gameMoment();
    const open = moment && moment.state !== "resolved" ? moment.id : undefined;
    const problemId = view.mode === "problem" ? view.problem?.id : undefined;
    const newest = [...this.ring].reverse();
    const events = [
      open && newest.find((e) => e.type === "teaching_moment" && e.moment.id === open),
      problemId && newest.find((e) => e.type === "problem_start" && e.problemId === problemId),
    ];
    return events.filter((e): e is TutorEvent => !!e).sort((a, b) => a.seq - b.seq);
  }

  private keepAlive(req: IncomingMessage, res: ServerResponse, onClose: () => void): void {
    const beat = setInterval(() => send(res, ": ping\n\n"), this.heartbeatMs);
    beat.unref();
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      onClose();
    };
    req.on("close", done);
    res.on("close", done);
    res.on("error", done);
  }

  private queueView(): void {
    if (this.viewQueued) return;
    this.viewQueued = true;
    // Coalesce the bursts of changes one action makes into a single push.
    setImmediate(() => {
      this.viewQueued = false;
      if (this.browsers.size === 0) return;
      const frame = viewFrame(this.controller.view());
      for (const res of this.browsers) this.pushView(res, frame);
    });
  }

  /** Only the latest view matters: a browser that isn't keeping up gets the current one once it drains. */
  private pushView(res: ServerResponse, frame: string): void {
    if (!res.writableNeedDrain) {
      send(res, frame);
      return;
    }
    if (this.draining.has(res)) return;
    this.draining.add(res);
    res.once("drain", () => {
      this.draining.delete(res);
      if (this.browsers.has(res)) this.pushView(res, viewFrame(this.controller.view()));
    });
  }
}

/** Unread SSE data a client may hold before it counts as stalled and is dropped (it can reconnect). */
const MAX_BUFFERED_BYTES = 1 << 20;

function send(res: ServerResponse, frame: string): void {
  if (res.destroyed) return;
  if (res.writableLength > MAX_BUFFERED_BYTES) {
    res.destroy();
    return;
  }
  res.write(frame);
}

function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.socket?.setNoDelay(true);
  res.write(": connected\n\n");
}

function tutorFrame(e: TutorEvent): string {
  return `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;
}

function viewFrame(view: unknown): string {
  return `data: ${JSON.stringify(view)}\n\n`;
}

// --- request validation --------------------------------------------------------------

type Json = Record<string, unknown>;

function asObject(body: unknown): Json {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new UserError("Expected a JSON object.");
  return body as Json;
}

function str(o: Json, key: string, required: true): string;
function str(o: Json, key: string, required?: false): string | undefined;
function str(o: Json, key: string, required = false): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) throw new UserError(`"${key}" is required.`);
    return undefined;
  }
  if (typeof v !== "string") throw new UserError(`"${key}" must be a string.`);
  return v;
}

function strings(o: Json, key: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) throw new UserError(`"${key}" must be a list of coordinates.`);
  return v as string[];
}

function color(o: Json, key: string): Color | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (v !== "B" && v !== "W") throw new UserError(`"${key}" must be "B" or "W".`);
  return v;
}

function settings(o: Json): Partial<GameSettings> | undefined {
  if (o.settings === undefined || o.settings === null) return undefined;
  const s = asObject(o.settings);
  const out: Partial<GameSettings> = {};
  if (s.size !== undefined) out.size = s.size as GameSettings["size"];
  if (s.komi !== undefined) out.komi = s.komi as number;
  if (s.handicap !== undefined) out.handicap = s.handicap as number;
  const humanColor = color(s, "humanColor");
  if (humanColor) out.humanColor = humanColor;
  const botRank = str(s, "botRank");
  if (botRank) out.botRank = botRank;
  return out; // ranges are checked by the controller
}

export function parseClientAction(body: unknown): ClientAction {
  const o = asObject(body);
  switch (o.type) {
    case "new_game":
      return { type: "new_game", settings: settings(o) };
    case "play": {
      const p = asObject(o.point);
      if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) throw new UserError('"point" must be {x, y} integers.');
      return { type: "play", point: { x: p.x as number, y: p.y as number } };
    }
    case "pass":
    case "resign":
    case "continue":
    case "retry":
    case "next_problem":
    case "leave_problem":
      return { type: o.type };
    case "chat":
      return { type: "chat", text: str(o, "text", true) };
    case "ask_tutor": {
      const text = str(o, "text");
      return text === undefined ? { type: "ask_tutor" } : { type: "ask_tutor", text };
    }
    default:
      throw new UserError(`Unknown action type ${JSON.stringify(o.type)}.`);
  }
}

const MARK_KINDS = ["circle", "triangle", "square", "x"] as const;

export function parseTutorCommand(body: unknown): TutorCommand {
  const o = asObject(body);
  const momentId = str(o, "momentId");
  switch (o.type) {
    case "say":
    case "rethink": {
      const text = str(o, "text", true);
      if (!text.trim()) throw new UserError(`${o.type} needs some text.`);
      return { type: o.type, text, ...(momentId && { momentId }) };
    }
    case "show": {
      const start = color(o, "start");
      const label = str(o, "label");
      return { type: "show", moves: strings(o, "moves"), ...(start && { start }), ...(label && { label }) };
    }
    case "mark": {
      const kind = str(o, "kind");
      if (kind !== undefined && !(MARK_KINDS as readonly string[]).includes(kind)) {
        throw new UserError(`Mark kind must be one of ${MARK_KINDS.join(", ")}.`);
      }
      const text = str(o, "text");
      return {
        type: "mark",
        points: strings(o, "points"),
        ...(kind && { kind: kind as (typeof MARK_KINDS)[number] }),
        ...(text && { text }),
      };
    }
    case "clear":
    case "resume":
      return { type: o.type };
    case "claim":
      return { type: "claim", momentId: str(o, "momentId", true) };
    case "new_game":
      return { type: "new_game", settings: settings(o) };
    case "start_problem": {
      const problemId = str(o, "problemId");
      return { type: "start_problem", ...(problemId && { problemId }) };
    }
    case "tag": {
      const category = str(o, "category", true);
      if (!(MISTAKE_CATEGORIES as readonly string[]).includes(category)) {
        throw new UserError(`Category must be one of ${MISTAKE_CATEGORIES.join(", ")}.`);
      }
      if (!Number.isInteger(o.moveNumber) || (o.moveNumber as number) < 1) throw new UserError('"moveNumber" must be a positive integer.');
      const note = str(o, "note");
      return {
        type: "tag",
        gameId: str(o, "gameId", true),
        moveNumber: o.moveNumber as number,
        category: category as MistakeCategory,
        ...(note && { note }),
      };
    }
    default:
      throw new UserError(`Unknown tutor command ${JSON.stringify(o.type)}.`);
  }
}
